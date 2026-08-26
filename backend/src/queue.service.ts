import { Injectable } from '@nestjs/common';
import { DbService } from './db.service';

@Injectable()
export class QueueService {
  private readonly queue: Array<{ taskId: string; taskText: string }> = [];
  private reloadRequested = false;

  constructor(private readonly db: DbService) {}

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
