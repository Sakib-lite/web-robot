import { Injectable, OnModuleInit } from '@nestjs/common';
import { DbService } from './db.service';

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly queue: Array<{ taskId: string; taskText: string; skill?: string; model?: string; effort?: string }> = [];
  private reloadRequested = false;
  private pendingWorkerControl: boolean | null = null;
  private readonly workerStatuses = new Map<
    string,
    { state: string; currentTask?: string; ts: number }
  >();

  constructor(private readonly db: DbService) {}

  async onModuleInit() {
    // the in-memory queue dies with the process; adopt rows still marked
    // queued (or stuck in starting after a crashed claim) so a backend
    // restart never orphans tasks the extension never ran
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

  async enqueue(taskText: string, skill?: string, model?: string, effort?: string) {
    const res = await this.db.pool.query(
      `INSERT INTO tasks (task_text, skill, model, effort, status) VALUES ($1, $2, $3, $4, 'queued') RETURNING id`,
      [taskText, skill ?? null, model ?? null, effort ?? null],
    );
    const taskId = res.rows[0].id as string;
    this.queue.push({ taskId, taskText, ...(skill ? { skill } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    return { taskId };
  }

  // claims must be serialized per backend process: a memory-claim that has not
  // yet flipped its row to 'starting' must not be adoptable by the db path
  // (panel + service worker poll within a second of each other after the
  // panel auto-opens on claim - without this they ran the same task twice)
  private claimChain: Promise<unknown> = Promise.resolve();

  async next(src?: string): Promise<{ taskId: string; taskText: string; skill?: string; model?: string; effort?: string } | null> {
    const claim = this.claimChain.then(() => this.claimNext(src));
    this.claimChain = claim.catch(() => undefined);
    return claim;
  }

  private async claimNext(src?: string): Promise<{ taskId: string; taskText: string; skill?: string; model?: string; effort?: string } | null> {
    // single-flight: while any worker is mid-run (busy heartbeat or a claim
    // from moments ago), nobody else gets a task - the sw and panel poll
    // independently and must not run two tasks in parallel
    const someoneBusy = [...this.workerStatuses.values()].some(
      (w) => w.state === 'busy' && Date.now() - w.ts < 20_000,
    );
    if (someoneBusy) return null;

    const fromMemory = this.queue.shift();
    if (fromMemory) {
      // flip the row immediately so the adoption path below (or another
      // worker's memory-empty poll) can never hand this task out again;
      // the row is the source of truth for text (reaper-requeued memory
      // entries carry none)
      const res = await this.db.pool.query(
        `UPDATE tasks SET status='starting' WHERE id = $1 AND status='queued' RETURNING task_text, skill, model, effort`,
        [fromMemory.taskId],
      );
      if (res.rowCount === 0) return null; // someone else already claimed it
      const row = res.rows[0];
      this.markClaimed(src, fromMemory.taskId);
      return {
        taskId: fromMemory.taskId,
        taskText: row.task_text,
        ...(row.skill ? { skill: row.skill } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
      };
    }

    // memory empty: atomically adopt one queued row - self-heals tasks whose
    // claim died before /start, and SKIP LOCKED keeps concurrent claimers
    // (panel + service worker) from double-claiming
    const res = await this.db.pool.query(
      `UPDATE tasks SET status='starting'
       WHERE id IN (SELECT id FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, task_text, skill, model, effort`,
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
    };
  }

  // a claim is a busy marker in itself: the claimant may not heartbeat for a
  // few seconds (long first llm call), and single-flight must hold from the
  // instant a task is handed out
  private markClaimed(src: string | undefined, taskId: string) {
    if (!src) return;
    this.workerStatuses.set(src, { state: 'busy', currentTask: taskId, ts: Date.now() });
  }

  // ---- stale-run reaper -------------------------------------------------
  // a task in running/starting whose claimant stopped heartbeating is a zombie
  // (extension reloaded, chrome closed, loop crashed): requeue it so a live
  // worker resumes it; after 3 interruptions give up and fail it. sweep every
  // 30s; a task must look dead on two consecutive sweeps (60s grace) so a
  // claim between heartbeats is never mistaken for a corpse.
  private readonly missingSince = new Map<string, number>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  startReaper() {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => void this.reapStaleRuns(), 30_000);
  }

  async reapStaleRuns(): Promise<{ requeued: string[]; failed: string[] }> {
    const res = await this.db.pool.query(
      `SELECT id, attempts FROM tasks WHERE status IN ('running', 'starting') AND finished_at IS NULL`,
    );
    const requeued: string[] = [];
    const failed: string[] = [];
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
      if (Date.now() - first < 45_000) continue; // grace: dead on this sweep only is not yet a corpse
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

  async retry(taskId: string): Promise<{ queued: boolean }> {
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

  reportWorkerStatus(source: string, state: string, currentTask?: string) {
    this.workerStatuses.set(source, { state, currentTask, ts: Date.now() });
  }

  workerStatus() {
    const sources: Record<string, { state: string; currentTask?: string; ageMs: number }> = {};
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
