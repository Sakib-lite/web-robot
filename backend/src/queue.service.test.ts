import { describe, expect, it } from 'vitest';
import { QueueService } from './queue.service';

function queueService() {
  const queries: Array<[string, unknown[]]> = [];
  const service = new QueueService({
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        queries.push([sql, params ?? []]);
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

  it('next claims in fifo order and drains', async () => {
    const { service } = queueService();
    await service.enqueue('a');
    await service.enqueue('b');
    expect(service.next()).toMatchObject({ taskText: 'a' });
    expect(service.next()).toMatchObject({ taskText: 'b' });
    expect(service.next()).toBeNull();
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
