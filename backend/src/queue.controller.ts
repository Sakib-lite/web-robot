import { Body, Controller, Get, Logger, Post, Query } from '@nestjs/common';
import { QueueService } from './queue.service';
import { DbService } from './db.service';

@Controller()
export class QueueController {
  private readonly logger = new Logger('queue');

  constructor(
    private readonly queue: QueueService,
    private readonly db: DbService,
  ) {}

  @Post('queue')
  enqueue(@Body() body: { taskText: string }) {
    if (!body.taskText?.trim()) throw new Error('taskText is required');
    return this.queue.enqueue(body.taskText.trim());
  }

  @Get('queue/next')
  next(@Query('src') src?: string) {
    const claimed = this.queue.next();
    if (claimed) {
      this.logger.log(`CLAIMED by ${src ?? 'unknown'}: ${claimed.taskId} "${claimed.taskText.slice(0, 60)}"`);
    }
    return claimed ?? {};
  }

  @Get('queue/depth')
  depth() {
    return { depth: this.queue.depth() };
  }

  @Post('tasks/:id/start')
  async start(
    id: string,
    @Body() body: { product?: string; model?: string; effort?: string },
  ) {
    await this.db.pool.query(
      `UPDATE tasks SET status = 'running', product = $2, model = $3, effort = $4 WHERE id = $1`,
      [id, body.product ?? null, body.model ?? null, body.effort ?? null],
    );
    return { started: true };
  }

  @Post('control/reload')
  reload() {
    this.queue.requestReload();
    return { reload: true };
  }

  @Get('control/reload')
  consumeReload() {
    return { reload: this.queue.consumeReload() };
  }

  @Get('tasks/wait')
  async waitTask(@Query('id') id: string, @Query('timeoutMs') timeoutMs?: string) {
    const deadline = Date.now() + Math.min(Number(timeoutMs ?? 600000), 1800000);
    while (Date.now() < deadline) {
      const res = await this.db.pool.query(`SELECT status FROM tasks WHERE id = $1`, [id]);
      const status = res.rows[0]?.status;
      if (status && status !== 'queued' && status !== 'running') {
        return { status };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { status: 'timeout' };
  }
}
