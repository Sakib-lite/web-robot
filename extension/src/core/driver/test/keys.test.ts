import { describe, expect, it } from 'vitest';
import { modifiersMask, resolveKey } from '../keys.helper';

describe('keys', () => {
  it('resolves named keys with their CDP definitions', () => {
    expect(resolveKey('Enter')).toEqual({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    expect(resolveKey('f5').code).toBe('F5');
    expect(resolveKey('a')).toMatchObject({ text: 'a', code: 'KeyA' });
    expect(resolveKey('ARROWDOWN').key).toBe('ArrowDown');
    expect(() => resolveKey('notakey')).toThrow('unknown key');
  });

  it('builds modifier bitmasks for dispatchKeyEvent', () => {
    expect(modifiersMask(['control', 'shift'])).toBe(2 | 8);
    expect(modifiersMask(['alt'])).toBe(1);
    expect(modifiersMask(['meta', 'Control'])).toBe(4 | 2);
    expect(modifiersMask(['bogus'])).toBe(0);
  });
});
