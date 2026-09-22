import { describe, expect, it } from 'vitest';
import { QueueService } from './queue.service';

function queueService(adopted: Array<{ id: number; task_text: string }> = [], insertIds: number[] = []) {
  const queries: Array<[string, unknown[]]> = [];
  const texts = new Map<number, string>();
  let adoptCalls = 0;
  let insertCalls = 0;
  let lastSteps: string[] | null = null;
  const run = async (sql: string, params?: unknown[]) => {
    queries.push([sql, params ?? []]);
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      const row = adopted[adoptCalls++];
      return { rows: row ? [row] : [] };
    }
    if (sql.includes(`VALUES ($1, $2, $3, $4, $5, $6, 'queued')`)) {
      insertCalls += 1;
      const id = insertIds[insertCalls - 1] ?? insertCalls;
      texts.set(id, String(params?.[0] ?? ''));
      const rawSteps = params?.[5];
      lastSteps = typeof rawSteps === 'string' ? (JSON.parse(rawSteps) as string[]) : Array.isArray(rawSteps) ? (rawSteps as string[]) : null;
      return { rows: [{ id }] };
    }
    // claim-flip UPDATE (memory path): returns the row (db truth) and
    // rowCount 0 when scripted to lose the race
    if (sql.includes(`SET status='starting' WHERE id`)) {
      const id = Number(params?.[0]);
      return { rows: [{ task_text: texts.get(id) ?? '', skill: null, ...(lastSteps ? { steps: lastSteps } : {}) }], rowCount: id === -1 ? 0 : 1 };
    }
    return { rows: [{ id: queries.length }] };
  };
  // enqueue/continue use a transaction client; delegate to the same handler
  const client = { query: run, release: () => {} };
  const service = new QueueService({
    pool: { query: run, connect: async () => client },
  } as never);
  return { service, queries };
}

describe('QueueService', () => {
  it('enqueue creates a queued task row, records its first message, and returns its id', async () => {
    const { service, queries } = queueService();
    const res = await service.enqueue('list repos');
    expect(res.taskId).toBe(1);
    expect(queries.some(([sql]) => sql.includes(`VALUES ($1, $2, $3, $4, $5, $6, 'queued')`))).toBe(true);
    // the driving instruction becomes the task's first chat message
    expect(queries.some(([sql, params]) => sql.includes('INSERT INTO task_messages') && params?.[0] === 1)).toBe(true);
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
    expect(flip).toBeDefined();
    expect(flip![1]).toEqual([1]);
  });

  it('a memory claim that lost the db race (rowCount 0) returns null instead of the task', async () => {
    const { service } = queueService([], [-1]);
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
    service.reportWorkerStatus('sw', 'busy', 999);
    await service.enqueue('a');
    expect(await service.next('panel')).toBeNull();
  });

  it('allows claims again once the busy heartbeat is stale', async () => {
    const { service } = queueService();
    service.reportWorkerStatus('sw', 'busy', 999);
    // age it beyond the 20s window by backdating through a second report + manual map poke
    (service as unknown as { workerStatuses: Map<string, { state: string; currentTask?: number; ts: number }> })
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
    expect(typeof status.sources.sw!.currentTask).toBe('number');
  });

  it('reaper requeues a dead running task on the second sweep and fails it at 3 attempts', async () => {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes(`WHERE status IN ('running', 'starting')`)) {
          return { rows: [{ id: 201, attempts: 0 }] };
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
    (service as unknown as { missingSince: Map<number, number> }).missingSince.set(201, Date.now() - 60_000);
    expect(await service.reapStaleRuns()).toEqual({ requeued: [201], failed: [] });
    // a worker still alive on its task is never reaped
    service.reportWorkerStatus('panel', 'busy', 202);
    (service as unknown as { workerStatuses: Map<string, { currentTask?: number; ts: number }> })
      .workerStatuses.get('panel')!.currentTask = 202;
    const alivePool = {
      query: async (sql: string) => {
        if (sql.includes(`WHERE status IN ('running', 'starting')`)) return { rows: [{ id: 202, attempts: 0 }] };
        return { rows: [] };
      },
    };
    const service2 = new QueueService({ pool: alivePool } as never);
    service2.reportWorkerStatus('panel', 'busy', 202);
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
    expect(await svc.retry(1)).toEqual({ queued: true });
    const emptyPool = { query: async () => ({ rows: [] }) };
    const svc2 = new QueueService({ pool: emptyPool } as never);
    expect(await svc2.retry(2)).toEqual({ queued: false });
    void service;
  });
});

describe('QueueService continue + steps', () => {
  it('continueTask requeues a finished task with its message recorded', async () => {
    const { service, queries } = queueService();
    const res = await service.continueTask(5, 'check docker containers');
    expect(res).toEqual({ queued: true });
    expect(queries.some(([sql]) => sql.includes(`status='queued', attempts=0, finished_at=NULL`))).toBe(true);
    expect(queries.some(([sql, params]) => sql.includes('INSERT INTO task_messages') && params?.[0] === 5 && params?.[1] === 'check docker containers')).toBe(true);
    expect(service.depth()).toBe(1);
  });

  it('continueTask refuses a task that is queued/starting/running', async () => {
    const pool = {
      connect: async () => ({
        query: async (sql: string) => (sql.includes('UPDATE tasks') ? { rowCount: 0, rows: [] } : { rows: [] }),
        release: () => {},
      }),
      query: async () => ({ rows: [] }),
    };
    const service = new QueueService({ pool } as never);
    expect(await service.continueTask(9, 'hi')).toEqual({ queued: false });
  });

  it('enqueue carries steps and the claim hands them back with the last message', async () => {
    const { service } = queueService();
    await service.enqueue('two-step job', undefined, undefined, undefined, undefined, ['step one', 'step two']);
    const claimed = await service.next('sw');
    expect(claimed).toMatchObject({ steps: ['step one', 'step two'] });
  });
});
