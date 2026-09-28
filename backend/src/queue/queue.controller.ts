import { Body, Controller, Get, Logger, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { QueueService } from './queue.service';

@Controller()
export class QueueController {
  private readonly logger = new Logger('queue');

  constructor(private readonly queue: QueueService) {}

  @Post('queue')
  enqueue(@Body() body: { taskText: string; skill?: string; model?: string; effort?: string; context?: string; steps?: string[] }) {
    if (!body.taskText?.trim()) throw new Error('taskText is required');
    const steps = Array.isArray(body.steps) ? body.steps.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) : undefined;
    return this.queue.enqueue(
      body.taskText.trim(),
      body.skill?.trim() || undefined,
      body.model?.trim() || undefined,
      body.effort?.trim() || undefined,
      body.context?.trim() || undefined,
      steps?.length ? steps : undefined,
    );
  }

  @Get('queue/next')
  async next(@Query('src') src?: string) {
    const claimed = await this.queue.next(src);
    if (claimed) {
      this.logger.log(`CLAIMED by ${src ?? 'unknown'}: ${claimed.taskId} "${claimed.taskText.slice(0, 60)}"`);
    }
    return claimed ?? {};
  }

  @Get('queue/depth')
  depth() {
    return { depth: this.queue.depth() };
  }

  @Get('queue/reap')
  reapNow() {
    return this.queue.reapStaleRuns();
  }

  @Get('tasks/wait')
  waitTask(@Query('id', ParseIntPipe) id: number, @Query('timeoutMs') timeoutMs?: string) {
    return this.queue.waitForTerminal(id, Math.min(Number(timeoutMs ?? 600000), 1800000));
  }

  @Post('tasks/:id/start')
  start(@Param('id', ParseIntPipe) id: number, @Body() body: { product?: string; model?: string; effort?: string }) {
    return this.queue.markRunning(id, body);
  }

  @Post('tasks/:id/retry')
  async retry(@Param('id', ParseIntPipe) id: number) {
    const res = await this.queue.retry(id);
    if (!res.queued) throw new NotFoundException(`task ${id} not found or not in failed/stopped state`);
    this.logger.log(`RETRY queued: ${id}`);
    return res;
  }

  @Post('tasks/:id/continue')
  async continueTask(@Param('id', ParseIntPipe) id: number, @Body() body: { message: string }) {
    const res = await this.queue.continueTask(id, body?.message ?? '');
    if (!res.queued) throw new NotFoundException(`task ${id} not found or still queued/running`);
    this.logger.log(`CONTINUE queued: ${id}`);
    return res;
  }

  @Post('tasks/:id/kill')
  async killTask(@Param('id', ParseIntPipe) id: number) {
    const res = await this.queue.kill(id);
    if (res.stopped) this.logger.log(`KILLED: task ${id}`);
    return res;
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
  workerStatus(@Body() body: { source: string; state: string; currentTask?: number }) {
    if (!body.source || !body.state) throw new Error('source and state are required');
    this.queue.reportWorkerStatus(body.source, body.state, body.currentTask);
    return { ok: true };
  }

  @Get('worker/status')
  workerStatusRead() {
    return this.queue.workerStatus();
  }
}
