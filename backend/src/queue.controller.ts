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
  async next(@Query('src') src?: string) {
    const claimed = await this.queue.next();
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
    const pendingWorker = this.queue.consumeWorkerControl();
    const response: { reload: boolean; workerEnabled?: boolean } = {
      reload: this.queue.consumeReload(),
    };
    if (pendingWorker !== null) response.workerEnabled = pendingWorker;
    return response;
  }

  @Post('worker/control')
  workerControl(@Body() body: { enabled: boolean }) {
    if (typeof body.enabled !== 'boolean') throw new Error('enabled (boolean) is required');
    this.queue.requestWorkerControl(body.enabled);
    return { pending: true, enabled: body.enabled };
  }

  @Post('worker/status')
  workerStatus(@Body() body: { source: string; state: string; currentTask?: string }) {
    if (!body.source || !body.state) throw new Error('source and state are required');
    this.queue.reportWorkerStatus(body.source, body.state, body.currentTask);
    return { ok: true };
  }

  @Get('worker/status')
  workerStatusRead() {
    return this.queue.workerStatus();
  }

  @Get('tasks/wait')
  async waitTask(@Query('id') id: string, @Query('timeoutMs') timeoutMs?: string) {
    const deadline = Date.now() + Math.min(Number(timeoutMs ?? 600000), 1800000);
    while (Date.now() < deadline) {
      const res = await this.db.pool.query(`SELECT status FROM tasks WHERE id = $1`, [id]);
      const status = res.rows[0]?.status;
      if (status && status !== 'queued' && status !== 'starting' && status !== 'running') {
        return { status };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { status: 'timeout' };
  }
}
