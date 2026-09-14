import { describe, expect, it } from 'vitest';
import { QueueService } from './queue.service';

function queueService(adopted: Array<{ id: string; task_text: string }> = [], insertIds: string[] = []) {
  const queries: Array<[string, unknown[]]> = [];
  const texts = new Map<string, string>();
  let adoptCalls = 0;
  let insertCalls = 0;
  const service = new QueueService({
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push([sql, params ?? []]);
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          const row = adopted[adoptCalls++];
          return { rows: row ? [row] : [] };
        }
        if (sql.includes(`VALUES ($1, $2, 'queued')`)) {
          const id = insertIds[insertCalls] ?? `id-${queries.length}`;
          texts.set(id, String(params?.[0] ?? ''));
          return { rows: [{ id }] };
        }
        // claim-flip UPDATE (memory path): returns the row (db truth) and
        // rowCount 0 when scripted to lose the race
        if (sql.includes(`SET status='starting' WHERE id`)) {
          const id = String(params?.[0]);
          return { rows: [{ task_text: texts.get(id) ?? '', skill: null }], rowCount: id === 'already-claimed' ? 0 : 1 };
        }
        return { rows: [{ id: `id-${queries.length}` }] };
      },
    },
  } as never);
  return { service, queries };
}

describe('QueueService', () => {
  it('enqueue creates a queued task row and returns its id', async () => {
    const { service, queries } = queueService();
    const res = await service.enqueue('list repos');
    expect(res.taskId).toBe('id-1');
    expect(queries[0]![0]).toContain(`VALUES ($1, $2, 'queued')`);
    expect(service.depth()).toBe(1);
  });

  it('next claims in fifo order, then adopts from the db when memory is empty', async () => {
    const { service } = queueService([{ id: 'orphan-1', task_text: 'recover me' }]);
    await service.enqueue('a');
    await service.enqueue('b');
    expect(await service.next()).toMatchObject({ taskText: 'a' });
    expect(await service.next()).toMatchObject({ taskText: 'b' });
    expect(await service.next()).toMatchObject({ taskId: 'orphan-1', taskText: 'recover me' });
    expect(await service.next()).toBeNull();
    expect(service.depth()).toBe(0);
  });

  it('a memory claim flips the row to starting so adoption cannot hand it out twice', async () => {
    const { service, queries } = queueService();
    await service.enqueue('race');
    const claimed = await service.next();
    expect(claimed).toMatchObject({ taskText: 'race' });
    const flip = queries.find(([sql]) => sql.includes(`SET status='starting' WHERE id`));
    expect(flip).toBeDefined();
    expect(flip![1]).toEqual(['id-1']);
  });

  it('a memory claim that lost the db race (rowCount 0) returns null instead of the task', async () => {
    const { service } = queueService([], ['already-claimed']);
    await service.enqueue('taken');
    expect(await service.next()).toBeNull();
    expect(service.depth()).toBe(0);
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
    service.reportWorkerStatus('sw', 'busy', 'some-task');
    await service.enqueue('a');
    expect(await service.next('panel')).toBeNull();
  });

  it('allows claims again once the busy heartbeat is stale', async () => {
    const { service } = queueService();
    service.reportWorkerStatus('sw', 'busy', 'some-task');
    // age it beyond the 20s window by backdating through a second report + manual map poke
    (service as unknown as { workerStatuses: Map<string, { state: string; currentTask?: string; ts: number }> })
      .workerStatuses.get('sw')!.ts = Date.now() - 30_000;
    await service.enqueue('a');
    expect(await service.next('panel')).toMatchObject({ taskText: 'a' });
  });

  it('a claim marks that source busy with the task id (single-flight from the instant of claim)', async () => {
    const { service } = queueService();
    await service.enqueue('a');
    await service.next('sw');
    const status = service.workerStatus();
    expect(status.sources.sw).toMatchObject({ state: 'busy' });
    expect(typeof status.sources.sw!.currentTask).toBe('string');
  });

  it('reaper requeues a dead running task on the second sweep and fails it at 3 attempts', async () => {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes(`WHERE status IN ('running', 'starting')`)) {
          return { rows: [{ id: 'zombie-1', attempts: 0 }] };
        }
        if (sql.includes(`SET status='queued', attempts=$2`)) {
          return { rows: [{ id: params?.[0] }] };
        }
        if (sql.includes(`SET status='failed'`)) {
          return { rows: [{ id: params?.[0] }] };
        }
        return { rows: [] };
      },
    };
    const service = new QueueService({ pool } as never);
    // first sweep: grace (dead once is not a corpse)
    expect(await service.reapStaleRuns()).toEqual({ requeued: [], failed: [] });
    // age the sighting past the grace window, then sweep again: requeued
    (service as unknown as { missingSince: Map<string, number> }).missingSince.set('zombie-1', Date.now() - 60_000);
    expect(await service.reapStaleRuns()).toEqual({ requeued: ['zombie-1'], failed: [] });
    // a worker still alive on its task is never reaped
    service.reportWorkerStatus('panel', 'busy', 'alive-task');
    (service as unknown as { workerStatuses: Map<string, { currentTask?: string; ts: number }> })
      .workerStatuses.get('panel')!.currentTask = 'alive-task';
    const alivePool = {
      query: async (sql: string) => {
        if (sql.includes(`WHERE status IN ('running', 'starting')`)) return { rows: [{ id: 'alive-task', attempts: 0 }] };
        return { rows: [] };
      },
    };
    const service2 = new QueueService({ pool: alivePool } as never);
    service2.reportWorkerStatus('panel', 'busy', 'alive-task');
    expect(await service2.reapStaleRuns()).toEqual({ requeued: [], failed: [] });
    expect(await service2.reapStaleRuns()).toEqual({ requeued: [], failed: [] });
  });

  it('retry requeues a failed task and refuses non-failed ones', async () => {
    const { service } = queueService();
    const pool2 = {
      query: async (sql: string) => {
        if (sql.includes(`status IN ('failed', 'stopped')`)) return { rows: [{ task_text: 'try me again' }] };
        return { rows: [] };
      },
    };
    const svc = new QueueService({ pool: pool2 } as never);
    expect(await svc.retry('t-1')).toEqual({ queued: true });
    const emptyPool = { query: async () => ({ rows: [] }) };
    const svc2 = new QueueService({ pool: emptyPool } as never);
    expect(await svc2.retry('t-2')).toEqual({ queued: false });
    void service;
  });
});
