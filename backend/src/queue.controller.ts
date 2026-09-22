import { Body, Controller, Get, Logger, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
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

  @Post('tasks/:id/continue')
  async continueTask(@Param('id', ParseIntPipe) id: number, @Body() body: { message: string }) {
    const res = await this.queue.continueTask(id, body?.message ?? '');
    if (!res.queued) throw new NotFoundException(`task ${id} not found or still queued/running`);
    this.logger.log(`CONTINUE queued: ${id}`);
    return res;
  }

  // kill switch for any task: marks the row stopped (a finished marker means
  // the reaper can never resurrect it) and, when a runner context may be
  // mid-run, requests an extension reload - the only reliable way to stop an
  // in-flight loop (kills every context; single-flight means at most one task)
  @Post('tasks/:id/kill')
  async killTask(@Param('id', ParseIntPipe) id: number) {
    const res = await this.db.pool.query(
      `UPDATE tasks SET status='stopped', reason='killed by user', finished_at=now()
       WHERE id=$1 AND status IN ('queued', 'starting', 'running') RETURNING status`,
      [id],
    );
    const stopped = (res.rowCount ?? 0) > 0;
    if (stopped) {
      this.queue.requestReload();
      this.logger.log(`KILLED: task ${id} - extension reload requested`);
    }
    return { stopped };
  }

  @Get('queue/next')
  async next(@Query('src') src?: string) {
    const claimed = await this.queue.next(src);
    if (claimed) {
      this.logger.log(`CLAIMED by ${src ?? 'unknown'}: ${claimed.taskId} "${claimed.taskText.slice(0, 60)}"`);
    }
    return claimed ?? {};
  }

  @Post('tasks/:id/retry')
  async retry(@Param('id', ParseIntPipe) id: number) {
    const res = await this.queue.retry(id);
    if (!res.queued) throw new NotFoundException(`task ${id} not found or not in failed/stopped state`);
    this.logger.log(`RETRY queued: ${id}`);
    return res;
  }

  @Get('queue/depth')
  depth() {
    return { depth: this.queue.depth() };
  }

  @Get('queue/reap')
  reapNow() {
    return this.queue.reapStaleRuns();
  }

  @Post('tasks/:id/start')
  async start(
    @Param('id', ParseIntPipe) id: number,
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
  workerStatus(@Body() body: { source: string; state: string; currentTask?: number }) {
    if (!body.source || !body.state) throw new Error('source and state are required');
    this.queue.reportWorkerStatus(body.source, body.state, body.currentTask);
    return { ok: true };
  }

  @Get('worker/status')
  workerStatusRead() {
    return this.queue.workerStatus();
  }

  @Get('tasks/wait')
  async waitTask(@Query('id', ParseIntPipe) id: number, @Query('timeoutMs') timeoutMs?: string) {
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
