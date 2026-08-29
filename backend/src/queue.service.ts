import { Injectable, OnModuleInit } from '@nestjs/common';
import { DbService } from './db.service';

@Injectable()
export class QueueService implements OnModuleInit {
  private readonly queue: Array<{ taskId: string; taskText: string }> = [];
  private reloadRequested = false;

  constructor(private readonly db: DbService) {}

  // the in-memory queue dies with the process; adopt rows still marked queued
  // so a backend restart never orphans tasks the extension never saw
  async onModuleInit() {
    const res = await this.db.pool.query(`SELECT id, task_text FROM tasks WHERE status = 'queued' ORDER BY created_at`);
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

  next(): { taskId: string; taskText: string } | null {
    return this.queue.shift() ?? null;
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
}
