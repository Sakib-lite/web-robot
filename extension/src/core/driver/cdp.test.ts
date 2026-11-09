import { describe, expect, it, vi } from 'vitest';
import { cdpFor } from './cdp';

function fakeDebugger(over: Partial<Record<'attach' | 'detach' | 'sendCommand', (...args: never[]) => unknown>> = {}) {
  return {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => ({})),
    onDetach: { addListener: vi.fn() },
    ...over,
  } as unknown as typeof chrome.debugger;
}

describe('cdpFor', () => {
  it('attaches once per tab and reuses it across calls', async () => {
    const api = fakeDebugger();
    const cdp = cdpFor(api);
    await cdp.withDebugger(7, (send) => send('Page.reload'));
    await cdp.withDebugger(7, (send) => send('Page.reload'));
    expect(api.attach).toHaveBeenCalledTimes(1);
    expect(api.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    expect(api.sendCommand).toHaveBeenCalledTimes(2);
    expect(api.onDetach.addListener).toHaveBeenCalled();
  });

  it('sends commands with the tab target and passes results through', async () => {
    const api = fakeDebugger({ sendCommand: vi.fn(async () => ({ data: 'png' })) as never });
    const cdp = cdpFor(api);
    const res = await cdp.withDebugger(3, (send) => send('Page.captureScreenshot', { format: 'png' }));
    expect(res).toEqual({ data: 'png' });
    expect(api.sendCommand).toHaveBeenCalledWith({ tabId: 3 }, 'Page.captureScreenshot', { format: 'png' });
  });

  it('translates an already-attached debugger into a friendly error', async () => {
    const api = fakeDebugger({ attach: vi.fn(async () => {
      throw new Error('Another debugger is already attached');
    }) as never });
    const cdp = cdpFor(api);
    await expect(cdp.withDebugger(5, (send) => send('x'))).rejects.toThrow('another debugger client already holds tab 5');
  });

  it('detaches every attached tab on detachAll', async () => {
    const api = fakeDebugger();
    const cdp = cdpFor(api);
    await cdp.withDebugger(1, (send) => send('a'));
    await cdp.withDebugger(2, (send) => send('b'));
    cdp.detachAll();
    expect(api.detach).toHaveBeenCalledTimes(2);
  });
});
