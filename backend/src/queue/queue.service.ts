import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ClaimedTask } from './dto/claimed-task.dto';
import { Task } from '../tasks/entities/task.entity';
import { TaskMessage } from '../tasks/entities/task-message.entity';

import { rawCount, rawRows } from './sql.helper';

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly queue: Array<{ taskId: number; taskText: string; skill?: string; model?: string; effort?: string; context?: string; steps?: string[] }> = [];
  private reloadRequested = false;
  private pendingWorkerControl: boolean | null = null;
  private readonly workerStatuses = new Map<string, { state: string; currentTask?: number; ts: number }>();

  private claimChain: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(TaskMessage) private readonly messages: Repository<TaskMessage>,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    const res = await this.dataSource.query(
      `UPDATE tasks SET status='queued'
       WHERE status IN ('queued', 'starting') AND finished_at IS NULL
       RETURNING id, task_text`,
    );
    for (const row of rawRows(res)) {
      this.queue.push({ taskId: row.id, taskText: row.task_text });
    }
    if (this.queue.length > 0) {
      console.log(`[web-robot queue] requeued ${this.queue.length} orphaned task(s) after restart`);
    }
    this.startReaper();
  }

  async enqueue(taskText: string, skill?: string, model?: string, effort?: string, context?: string, steps?: string[]) {
    const taskId = await this.dataSource.transaction(async (em) => {
      const task = await em.save(Task, {
        taskText,
        skill: skill ?? null,
        model: model ?? null,
        effort: effort ?? null,
        context: context ?? null,
        steps: steps?.length ? steps : null,
        status: 'queued',
      });
      await em.save(TaskMessage, { taskId: task.id, role: 'user', content: taskText });
      return task.id;
    });
    this.queue.push({ taskId, taskText, ...(skill ? { skill } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(context ? { context } : {}), ...(steps?.length ? { steps } : {}) });
    return { taskId };
  }

  async continueTask(taskId: number, message: string): Promise<{ queued: boolean }> {
    if (!message?.trim()) throw new Error('message is required');
    const queued = await this.dataSource.transaction(async (em) => {
      const result = await em.query(
        `UPDATE tasks SET status='queued', attempts=0, finished_at=NULL
         WHERE id=$1 AND status NOT IN ('queued','starting','running')`,
        [taskId],
      );
      if (rawCount(result) === 0) return false;
      await em.save(TaskMessage, { taskId, role: 'user', content: message.trim() });
      return true;
    });
    if (!queued) return { queued: false };
    this.queue.push({ taskId, taskText: '' });
    console.log(`[web-robot queue] CONTINUE queued: task ${taskId} "${message.slice(0, 60)}"`);
    return { queued: true };
  }

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
      const res = await this.dataSource.query(
        `UPDATE tasks SET status='starting' WHERE id = $1 AND status='queued'
         RETURNING task_text, skill, model, effort, context, steps,
           (SELECT content FROM task_messages tm WHERE tm.task_id = tasks.id AND tm.role='user' ORDER BY tm.id DESC LIMIT 1) AS last_message`,
        [fromMemory.taskId],
      );
      const rows = rawRows(res);
      if (rows.length === 0) return null;
      const row = rows[0];
      this.markClaimed(src, fromMemory.taskId);
      return this.toClaimed(fromMemory.taskId, row);
    }

    const res = await this.dataSource.query(
      `UPDATE tasks SET status='starting'
       WHERE id IN (SELECT id FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, task_text, skill, model, effort, context, steps,
         (SELECT content FROM task_messages tm WHERE tm.task_id = tasks.id AND tm.role='user' ORDER BY tm.id DESC LIMIT 1) AS last_message`,
    );
    const rows = rawRows(res);
    if (rows.length === 0) return null;
    const row = rows[0];
    this.markClaimed(src, row.id);
    return this.toClaimed(row.id, row);
  }

  private toClaimed(taskId: number, row: Record<string, unknown>): ClaimedTask {
    return {
      taskId,
      taskText: row.task_text as string,
      ...(row.skill ? { skill: row.skill as string } : {}),
      ...(row.model ? { model: row.model as string } : {}),
      ...(row.effort ? { effort: row.effort as string } : {}),
      ...(row.context ? { context: row.context as string } : {}),
      ...(Array.isArray(row.steps) && row.steps.length > 0 ? { steps: row.steps as string[] } : {}),
      ...(row.last_message ? { lastMessage: row.last_message as string } : {}),
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
    const res = await this.dataSource.query(
      `SELECT id, attempts FROM tasks WHERE status IN ('running', 'starting') AND finished_at IS NULL`,
    );
    const requeued: number[] = [];
    const failed: number[] = [];
    for (const row of res) {
      const id = Number(row.id);
      const alive = [...this.workerStatuses.values()].some(
        (w) => w.currentTask === id && Date.now() - w.ts < 90_000,
      );
      if (alive) {
        this.missingSince.delete(id);
        continue;
      }
      const first = this.missingSince.get(id) ?? Date.now();
      this.missingSince.set(id, first);
      if (Date.now() - first < 45_000) continue;
      this.missingSince.delete(id);
      const attempts = Number(row.attempts ?? 0) + 1;
      if (attempts >= 3) {
        await this.dataSource.query(
          `UPDATE tasks SET status='failed', reason=$2, attempts=$3, finished_at=now() WHERE id=$1`,
          [id, `runner died mid-run ${attempts} times without finishing (reaped)`, attempts],
        );
        failed.push(id);
      } else {
        await this.dataSource.query(`UPDATE tasks SET status='queued', attempts=$2 WHERE id=$1`, [id, attempts]);
        this.queue.push({ taskId: id, taskText: '' });
        requeued.push(id);
      }
    }
    if (requeued.length > 0) {
      console.log(`[web-robot queue] reaper requeued ${requeued.length} zombie task(s): ${requeued.join(', ')}`);
    }
    return { requeued, failed };
  }

  async retry(taskId: number): Promise<{ queued: boolean }> {
    const task = await this.tasks.findOneBy({ id: taskId });
    if (!task || (task.status !== 'failed' && task.status !== 'stopped')) return { queued: false };
    await this.tasks.update({ id: taskId }, { status: 'queued', attempts: 0, finishedAt: null });
    this.queue.push({ taskId, taskText: task.taskText });
    return { queued: true };
  }

  async markRunning(taskId: number, meta: { product?: string; model?: string; effort?: string }): Promise<{ started: boolean }> {
    await this.tasks.update({ id: taskId }, {
      status: 'running',
      product: meta.product ?? null,
      model: meta.model ?? null,
      effort: meta.effort ?? null,
    });
    return { started: true };
  }

  async waitForTerminal(taskId: number, timeoutMs: number): Promise<{ status: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = await this.tasks.findOneBy({ id: taskId });
      const status = task?.status;
      if (status && status !== 'queued' && status !== 'starting' && status !== 'running') {
        return { status };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { status: 'timeout' };
  }

  async kill(taskId: number): Promise<{ stopped: boolean }> {
    const result = await this.dataSource.query(
      `UPDATE tasks SET status='stopped', reason='killed by user', finished_at=now()
       WHERE id=$1 AND status IN ('queued','starting','running')`,
      [taskId],
    );
    const stopped = rawCount(result) > 0;
    if (stopped) this.reloadRequested = true;
    return { stopped };
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
}
