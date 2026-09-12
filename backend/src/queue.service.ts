import { Injectable, OnModuleInit } from '@nestjs/common';
import { DbService } from './db.service';

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly queue: Array<{ taskId: string; taskText: string }> = [];
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
  }

  async enqueue(taskText: string) {
    const res = await this.db.pool.query(
      `INSERT INTO tasks (task_text, status) VALUES ($1, 'queued') RETURNING id`,
      [taskText],
    );
    const taskId = res.rows[0].id as string;
    this.queue.push({ taskId, taskText });
    return { taskId };
  }

  async next(): Promise<{ taskId: string; taskText: string } | null> {
    const fromMemory = this.queue.shift();
    if (fromMemory) return fromMemory;

    // memory empty: atomically adopt one queued row - self-heals tasks whose
    // claim died before /start, and SKIP LOCKED keeps concurrent claimers
    // (panel + service worker) from double-claiming
    const res = await this.db.pool.query(
      `UPDATE tasks SET status='starting'
       WHERE id IN (SELECT id FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id, task_text`,
    );
    const row = res.rows[0];
    return row ? { taskId: row.id, taskText: row.task_text } : null;
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
