import { Injectable, OnModuleInit } from '@nestjs/common';
import { ClaimedTask } from './dto/claimed-task.dto';
import { DbService } from '../common/db.service';

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly queue: Array<{ taskId: number; taskText: string; skill?: string; model?: string; effort?: string; context?: string; steps?: string[] }> = [];
  private reloadRequested = false;
  private pendingWorkerControl: boolean | null = null;
  private readonly workerStatuses = new Map<
    string,
    { state: string; currentTask?: number; ts: number }
  >();

  constructor(private readonly db: DbService) {}

  async onModuleInit() {

    const res = await this.db.pool.query(
      `UPDATE tasks SET status='queued'
       WHERE status IN ('queued', 'starting')
         AND finished_at IS NULL
       RETURNING id, task_text`,
    );
    for (const row of res.rows) {
      this.queue.push({ taskId: row.id, taskText: row.task_text });
    }
    if (this.queue.length > 0) {
      console.log(`[web-robot queue] requeued ${this.queue.length} orphaned task(s) after restart`);
    }
    this.startReaper();
  }

  async enqueue(taskText: string, skill?: string, model?: string, effort?: string, context?: string, steps?: string[]) {
    const client = await this.db.pool.connect();
    let taskId: number;
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO tasks (task_text, skill, model, effort, context, steps, status) VALUES ($1, $2, $3, $4, $5, $6, 'queued') RETURNING id`,
        [taskText, skill ?? null, model ?? null, effort ?? null, context ?? null, steps?.length ? JSON.stringify(steps) : null],
      );
      taskId = res.rows[0].id as number;

      await client.query(`INSERT INTO task_messages (task_id, role, content) VALUES ($1, 'user', $2)`, [taskId, taskText]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    this.queue.push({ taskId, taskText, ...(skill ? { skill } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(context ? { context } : {}), ...(steps?.length ? { steps } : {}) });
    return { taskId };
  }

  async continueTask(taskId: number, message: string): Promise<{ queued: boolean }> {
    if (!message?.trim()) throw new Error('message is required');
    const client = await this.db.pool.connect();
    let taskText = '';
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `UPDATE tasks SET status='queued', attempts=0, finished_at=NULL
         WHERE id=$1 AND status NOT IN ('queued', 'starting', 'running')
         RETURNING task_text`,
        [taskId],
      );
      if (res.rowCount === 0) {
        await client.query('ROLLBACK');
        return { queued: false };
      }
      taskText = res.rows[0].task_text as string;
      await client.query(`INSERT INTO task_messages (task_id, role, content) VALUES ($1, 'user', $2)`, [taskId, message.trim()]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    this.queue.push({ taskId, taskText: '' });
    console.log(`[web-robot queue] CONTINUE queued: task ${taskId} "${message.slice(0, 60)}"`);
    return { queued: true };
  }

  private claimChain: Promise<unknown> = Promise.resolve();

  async next(src?: string): Promise<ClaimedTask | null> {
    const claim = this.claimChain.then(() => this.claimNext(src));
    this.claimChain = claim.catch(() => undefined);
    return claim;
  }

  private async claimNext(src?: string): Promise<ClaimedTask | null> {

    const someoneBusy = [...this.workerStatuses.values()].some(
      (w) => w.state === 'busy' && Date.now() - w.ts < 20_000,
    );
    if (someoneBusy) return null;

    const fromMemory = this.queue.shift();
    if (fromMemory) {

      const res = await this.db.pool.query(
        `UPDATE tasks SET status='starting' WHERE id = $1 AND status='queued'
         RETURNING task_text, skill, model, effort, context, steps,
           (SELECT content FROM task_messages tm WHERE tm.task_id = tasks.id AND tm.role='user' ORDER BY tm.id DESC LIMIT 1) AS last_message`,
        [fromMemory.taskId],
      );
      if (res.rowCount === 0) return null;
      const row = res.rows[0];
      this.markClaimed(src, fromMemory.taskId);
      return {
        taskId: fromMemory.taskId,
        taskText: row.task_text,
        ...(row.skill ? { skill: row.skill } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        ...(row.context ? { context: row.context } : {}),
        ...(Array.isArray(row.steps) && row.steps.length > 0 ? { steps: row.steps } : {}),
        ...(row.last_message ? { lastMessage: row.last_message } : {}),
      };
    }

    const res = await this.db.pool.query(
      `UPDATE tasks SET status='starting'
       WHERE id IN (SELECT id FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, task_text, skill, model, effort, context, steps,
         (SELECT content FROM task_messages tm WHERE tm.task_id = tasks.id AND tm.role='user' ORDER BY tm.id DESC LIMIT 1) AS last_message`,
    );
    const row = res.rows[0];
    if (!row) return null;
    this.markClaimed(src, row.id);
    return {
      taskId: row.id,
      taskText: row.task_text,
      ...(row.skill ? { skill: row.skill } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
      ...(row.context ? { context: row.context } : {}),
      ...(Array.isArray(row.steps) && row.steps.length > 0 ? { steps: row.steps } : {}),
      ...(row.last_message ? { lastMessage: row.last_message } : {}),
    };
  }

  private markClaimed(src: string | undefined, taskId: number) {
    if (!src) return;
    this.workerStatuses.set(src, { state: 'busy', currentTask: taskId, ts: Date.now() });
  }

  private readonly missingSince = new Map<number, number>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  startReaper() {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => void this.reapStaleRuns(), 30_000);
  }

  async reapStaleRuns(): Promise<{ requeued: number[]; failed: number[] }> {
    const res = await this.db.pool.query(
      `SELECT id, attempts FROM tasks WHERE status IN ('running', 'starting') AND finished_at IS NULL`,
    );
    const requeued: number[] = [];
    const failed: number[] = [];
    for (const row of res.rows) {
      const alive = [...this.workerStatuses.values()].some(
        (w) => w.currentTask === row.id && Date.now() - w.ts < 90_000,
      );
      if (alive) {
        this.missingSince.delete(row.id);
        continue;
      }
      const first = this.missingSince.get(row.id) ?? Date.now();
      this.missingSince.set(row.id, first);
      if (Date.now() - first < 45_000) continue;
      this.missingSince.delete(row.id);
      const attempts = Number(row.attempts ?? 0) + 1;
      if (attempts >= 3) {
        await this.db.pool.query(
          `UPDATE tasks SET status='failed', reason=$2, attempts=$3, finished_at=now() WHERE id=$1`,
          [row.id, `runner died mid-run ${attempts} times without finishing (reaped)`, attempts],
        );
        failed.push(row.id);
      } else {
        await this.db.pool.query(
          `UPDATE tasks SET status='queued', attempts=$2 WHERE id=$1`,
          [row.id, attempts],
        );
        this.queue.push({ taskId: row.id, taskText: '' });
        requeued.push(row.id);
      }
    }
    if (requeued.length > 0) {
      console.log(`[web-robot queue] reaper requeued ${requeued.length} zombie task(s): ${requeued.join(', ')}`);
    }
    return { requeued, failed };
  }

  async retry(taskId: number): Promise<{ queued: boolean }> {
    const res = await this.db.pool.query(
      `UPDATE tasks SET status='queued', attempts=0, finished_at=NULL
       WHERE id=$1 AND status IN ('failed', 'stopped') RETURNING task_text`,
      [taskId],
    );
    const row = res.rows[0];
    if (!row) return { queued: false };
    this.queue.push({ taskId, taskText: row.task_text });
    return { queued: true };
  }

  depth(): number {
    return this.queue.length;
  }

  requestReload() {
    this.reloadRequested = true;
  }

  consumeReload(): boolean {
    const value = this.reloadRequested;
    this.reloadRequested = false;
    return value;
  }

  requestWorkerControl(enabled: boolean) {
    this.pendingWorkerControl = enabled;
  }

  consumeWorkerControl(): boolean | null {
    const value = this.pendingWorkerControl;
    this.pendingWorkerControl = null;
    return value;
  }

  reportWorkerStatus(source: string, state: string, currentTask?: number) {
    this.workerStatuses.set(source, { state, currentTask, ts: Date.now() });
  }

  workerStatus() {
    const sources: Record<string, { state: string; currentTask?: number; ageMs: number }> = {};
    for (const [source, entry] of this.workerStatuses) {
      sources[source] = {
        state: entry.state,
        currentTask: entry.currentTask,
        ageMs: Date.now() - entry.ts,
      };
    }
    return { sources };
  }

  async markRunning(taskId: number, meta: { product?: string; model?: string; effort?: string }): Promise<{ started: boolean }> {
    await this.db.pool.query(
      `UPDATE tasks SET status='running', product=$2, model=$3, effort=$4 WHERE id=$1`,
      [taskId, meta.product ?? null, meta.model ?? null, meta.effort ?? null],
    );
    return { started: true };
  }

  async waitForTerminal(taskId: number, timeoutMs: number): Promise<{ status: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.db.pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
      const status = res.rows[0]?.status;
      if (status && status !== 'queued' && status !== 'starting' && status !== 'running') {
        return { status };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { status: 'timeout' };
  }

  async kill(taskId: number): Promise<{ stopped: boolean }> {
    const res = await this.db.pool.query(
      `UPDATE tasks SET status='stopped', reason='killed by user', finished_at=now()
       WHERE id=$1 AND status IN ('queued', 'starting', 'running')`,
      [taskId],
    );
    const stopped = (res.rowCount ?? 0) > 0;
    if (stopped) this.reloadRequested = true;
    return { stopped };
  }
}
