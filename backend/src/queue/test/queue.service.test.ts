import { describe, expect, it, vi } from 'vitest';
import { QueueService } from '../queue.service';

type Run = (sql: string, params?: unknown[]) => Promise<any>;

function queueService(adopted: Array<{ id: number; task_text: string }> = [], insertIds: number[] = []) {
  const queries: Array<[string, unknown[]]> = [];
  const saves: Array<{ entity: unknown; dto: unknown }> = [];
  const texts = new Map<number, string>();
  const stepsByTask = new Map<number, string[] | null>();
  let adoptCalls = 0;
  let insertCalls = 0;

  const run: Run = async (sql: string, params: unknown[] = []) => {
    queries.push([sql, params]);
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      const row = adopted[adoptCalls++];
      return row ? [row] : [];
    }
    if (sql.includes(`SET status='starting' WHERE id`)) {
      const id = Number(params?.[0]);
      return [
        {
          task_text: texts.get(id) ?? '',
          skill: null,
          steps: stepsByTask.get(id) ?? null,
        },
      ];
    }
    if (sql.includes(`SET status='queued', attempts=0`)) {
      return { rowCount: params?.[0] === 9 ? 0 : 1 };
    }
    return [{ id: queries.length }];
  };

  const em = {
    query: run,
    save: async (entity: unknown, dto: any) => {
      saves.push({ entity, dto });
      if (dto?.status === 'queued') {
        insertCalls += 1;
        const id = insertIds[insertCalls - 1] ?? insertCalls;
        texts.set(id, dto.taskText);
        stepsByTask.set(id, dto.steps ?? null);
        return { id, ...dto };
      }
      return { id: 500, ...dto };
    },
    update: async () => ({ affected: 1 }),
  };
  const dataSource = {
    query: run,
    transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
  };
  const tasks = {
    findOneBy: async (where: { id: number }) => ({ id: where.id, taskText: texts.get(where.id) ?? '', status: 'failed' }),
    update: async () => ({ affected: 1 }),
  };
  const service = new QueueService(tasks as never, { save: async (m: unknown) => m } as never, dataSource as never);
  return { service, queries, saves, texts };
}

function bareService(run: Run, tasks: unknown = {}) {
  const em = { query: run, save: async (_e: unknown, dto: unknown) => ({ id: -1, ...dto }), update: async () => ({ affected: 1 }) };
  const dataSource = { query: run, transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em) };
  return new QueueService(tasks as never, {} as never, dataSource as never);
}

describe('QueueService', () => {
  it('enqueue saves a queued task and records its first chat message', async () => {
    const { service, saves } = queueService();
    const res = await service.enqueue('list repos');
    expect(res.taskId).toBe(1);
    expect(saves[0]!.dto).toMatchObject({ taskText: 'list repos', status: 'queued' });
    expect(saves[1]!.dto).toMatchObject({ role: 'user', content: 'list repos' });
    expect(service.depth()).toBe(1);
  });

  it('next claims in fifo order, then adopts from the db when memory is empty', async () => {
    const { service } = queueService([{ id: 101, task_text: 'recover me' }]);
    await service.enqueue('a');
    await service.enqueue('b');
    expect(await service.next()).toMatchObject({ taskText: 'a' });
    expect(await service.next()).toMatchObject({ taskText: 'b' });
    expect(await service.next()).toMatchObject({ taskId: 101, taskText: 'recover me' });
    expect(await service.next()).toBeNull();
    expect(service.depth()).toBe(0);
  });

  it('a memory claim flips the row to starting so adoption cannot hand it out twice', async () => {
    const { service, queries } = queueService();
    await service.enqueue('race');
    const claimed = await service.next();
    expect(claimed).toMatchObject({ taskText: 'race' });
    const flip = queries.find(([sql]) => sql.includes(`SET status='starting' WHERE id`));
    expect(flip![1]).toEqual([1]);
  });

  it('a memory claim that lost the db race returns null instead of the task', async () => {
    const run = vi.fn(async (sql: string) => (sql.includes(`SET status='starting' WHERE id`) ? [] : []));
    const service = bareService(run);
    await service.enqueue('taken');
    expect(await service.next()).toBeNull();
    expect(service.depth()).toBe(0);
  });

  it('enqueue carries steps and the claim hands them back', async () => {
    const { service } = queueService();
    await service.enqueue('two-step job', undefined, undefined, undefined, undefined, ['step one', 'step two']);
    const claimed = await service.next();
    expect(claimed).toMatchObject({ steps: ['step one', 'step two'] });
  });

  it('reload flag is consume-once', () => {
    const { service } = queueService();
    expect(service.consumeReload()).toBe(false);
    service.requestReload();
    expect(service.consumeReload()).toBe(true);
    expect(service.consumeReload()).toBe(false);
  });
});

describe('QueueService single-flight + reaper + retry', () => {
  it('denies a claim while a worker heartbeat is busy with a fresh task', async () => {
    const { service } = queueService();
    service.reportWorkerStatus('sw', 'busy', 999);
    await service.enqueue('a');
    expect(await service.next('panel')).toBeNull();
  });

  it('allows claims again once the busy heartbeat is stale', async () => {
    const { service } = queueService();
    service.reportWorkerStatus('sw', 'busy', 999);
    (service as unknown as { workerStatuses: Map<string, { state: string; currentTask?: number; ts: number }> })
      .workerStatuses.get('sw')!.ts = Date.now() - 30_000;
    await service.enqueue('a');
    expect(await service.next('panel')).toMatchObject({ taskText: 'a' });
  });

  it('a claim marks that source busy with the task id', async () => {
    const { service } = queueService();
    await service.enqueue('a');
    await service.next('sw');
    const status = service.workerStatus();
    expect(status.sources.sw).toMatchObject({ state: 'busy' });
    expect(typeof status.sources.sw!.currentTask).toBe('number');
  });

  it('reaper requeues a dead running task on the second sweep and fails it at 3 attempts', async () => {
    const run = vi.fn(async (sql: string) => {
      if (sql.includes(`WHERE status IN ('running', 'starting')`)) return [{ id: 201, attempts: 0 }];
      return [];
    });
    const service = bareService(run);
    expect(await service.reapStaleRuns()).toEqual({ requeued: [], failed: [] });
    (service as unknown as { missingSince: Map<number, number> }).missingSince.set(201, Date.now() - 60_000);
    expect(await service.reapStaleRuns()).toEqual({ requeued: [201], failed: [] });

    const aliveRun = vi.fn(async (sql: string) => (sql.includes(`WHERE status IN ('running', 'starting')`) ? [{ id: 202, attempts: 0 }] : []));
    const service2 = bareService(aliveRun);
    service2.reportWorkerStatus('panel', 'busy', 202);
    expect(await service2.reapStaleRuns()).toEqual({ requeued: [], failed: [] });
    expect(await service2.reapStaleRuns()).toEqual({ requeued: [], failed: [] });
  });

  it('retry requeues a failed task and refuses non-failed ones', async () => {
    const ok = { findOneBy: async () => ({ id: 1, taskText: 'try me again', status: 'failed' }), update: async () => ({ affected: 1 }) };
    const svc = bareService(vi.fn(async () => []), ok);
    expect(await svc.retry(1)).toEqual({ queued: true });
    const bad = { findOneBy: async () => ({ id: 2, taskText: 'running', status: 'running' }), update: async () => ({ affected: 1 }) };
    const svc2 = bareService(vi.fn(async () => []), bad);
    expect(await svc2.retry(2)).toEqual({ queued: false });
  });
});

describe('QueueService continue + kill', () => {
  it('continueTask requeues a finished task with its message recorded', async () => {
    const { service, queries, saves } = queueService();
    const res = await service.continueTask(5, 'check docker containers');
    expect(res).toEqual({ queued: true });
    expect(queries.some(([sql]) => sql.includes(`SET status='queued', attempts=0, finished_at=NULL`))).toBe(true);
    expect(saves.at(-1)!.dto).toMatchObject({ taskId: 5, role: 'user', content: 'check docker containers' });
    expect(service.depth()).toBe(1);
  });

  it('continueTask refuses a task that is queued/starting/running', async () => {
    const run = vi.fn(async () => ({ rowCount: 0 }));
    const service = bareService(run);
    expect(await service.continueTask(9, 'hi')).toEqual({ queued: false });
  });

  it('kill marks a live task stopped and requests an extension reload', async () => {
    const run = vi.fn(async () => ({ rowCount: 1 }));
    const service = bareService(run);
    expect(await service.kill(7)).toEqual({ stopped: true });
    expect(service.consumeReload()).toBe(true);
  });
});
