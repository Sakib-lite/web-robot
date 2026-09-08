import { describe, expect, it } from 'vitest';
import { QueueService } from './queue.service';

function queueService(adopted: Array<{ id: string; task_text: string }> = []) {
  const queries: Array<[string, unknown[]]> = [];
  let adoptCalls = 0;
  const service = new QueueService({
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push([sql, params ?? []]);
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          const row = adopted[adoptCalls++];
          return { rows: row ? [row] : [] };
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
    expect(queries[0]![0]).toContain(`VALUES ($1, 'queued')`);
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

  it('reload flag is consume-once', () => {
    const { service } = queueService();
    expect(service.consumeReload()).toBe(false);
    service.requestReload();
    expect(service.consumeReload()).toBe(true);
    expect(service.consumeReload()).toBe(false);
  });
});
