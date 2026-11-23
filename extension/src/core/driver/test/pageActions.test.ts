// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { runPageAction } from '../pageActions';
import { buildSnapshot, elementForRef, resetRefMaps } from '../pageSnapshot';

function prepare(html: string) {
  document.body.innerHTML = html;
  resetRefMaps(document);
  buildSnapshot(document);
  const map = new Map<string, Element>();
  buildSnapshot(document).elements.forEach((info) => map.set(info.ref, elementForRef(document, info.ref)!));
  const resolve = (ref: string) => map.get(ref) ?? null;
  return { resolve, map };
}

describe('runPageAction', () => {
  it('clicks an element by ref', async () => {
    const onClick = vi.fn();
    const { resolve, map } = prepare('<button id="go">Go</button>');
    map.get('e1')!.addEventListener('click', onClick);

    const result = await runPageAction({ type: 'click', ref: 'e1' }, resolve, window);
    expect(result).toMatchObject({ ok: true, detail: 'clicked e1' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('fails cleanly on a stale ref', async () => {
    const { resolve } = prepare('<button>Go</button>');
    const result = await runPageAction({ type: 'click', ref: 'e40' }, resolve, window);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('take a new snapshot');
  });

  it('fills inputs through the native setter so frameworks see the change', async () => {
    const seen: string[] = [];
    const { resolve, map } = prepare('<input id="q" type="text" />');
    const input = map.get('e1') as HTMLInputElement;
    input.addEventListener('input', () => seen.push(input.value));

    const result = await runPageAction({ type: 'fill', ref: 'e1', text: 'hello robot' }, resolve, window);
    expect(result.ok).toBe(true);
    expect(input.value).toBe('hello robot');
    expect(seen).toEqual(['hello robot']);
  });

  it('refuses to fill a non-input element', async () => {
    const { resolve } = prepare('<a href="/x">link</a>');
    const result = await runPageAction({ type: 'fill', ref: 'e1', text: 'nope' }, resolve, window);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not a text input');
  });

  it('selects an option by exact value, exact label, then partial label', async () => {
    const { resolve, map } = prepare('<select><option value="bd">Bangladesh</option><option value="de">Germany</option></select>');
    const select = map.get('e1') as HTMLSelectElement;
    const changes: string[] = [];
    select.addEventListener('change', () => changes.push(select.value));

    expect((await runPageAction({ type: 'select', ref: 'e1', option: 'de' }, resolve, window)).ok).toBe(true);
    expect(select.value).toBe('de');
    expect((await runPageAction({ type: 'select', ref: 'e1', option: 'germany' }, resolve, window)).ok).toBe(true);
    expect((await runPageAction({ type: 'select', ref: 'e1', option: 'bangl' }, resolve, window)).ok).toBe(true);
    expect(changes).toEqual(['de', 'de', 'bd']);
  });

  it('reports a missing option', async () => {
    const { resolve } = prepare('<select><option value="a">A</option></select>');
    const result = await runPageAction({ type: 'select', ref: 'e1', option: 'zzz' }, resolve, window);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not in select');
  });

  it('presses Enter and submits the surrounding form like a real browser', async () => {
    const onSubmit = vi.fn();
    document.body.innerHTML = `<form><input id="q" type="text" /></form>`;
    const form = document.querySelector('form')!;
    form.addEventListener('submit', onSubmit);
    const input = document.getElementById('q') as HTMLInputElement;
    input.focus();

    const result = await runPageAction({ type: 'press', key: 'Enter' }, () => document.activeElement ?? null, window);
    expect(result).toMatchObject({ ok: true, detail: 'pressed Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('scrolls the window by a distance', async () => {
    document.body.innerHTML = `<div style="height:5000px"></div>`;
    window.scrollTo(0, 0);
    await runPageAction({ type: 'scroll', direction: 'down', amount: 400 }, () => null, window);
    expect(window.scrollY).toBe(400);
    await runPageAction({ type: 'scroll', direction: 'up', amount: 150 }, () => null, window);
    expect(window.scrollY).toBe(250);
  });

  it('extracts the main content instead of the whole body', async () => {
    document.body.innerHTML = `
      <header>Global nav noise that should not appear in the extract result</header>
      <main><h1>Repos</h1><p>web-robot</p><p>resume-server</p></main>
    `;
    const result = await runPageAction({ type: 'extract', goal: 'repo names' }, () => null, window);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('web-robot');
    expect(result.detail).toContain('resume-server');
    expect(result.detail).not.toContain('Global nav noise');
  });

  it('fails extraction on an empty page', async () => {
    document.body.innerHTML = '';
    const result = await runPageAction({ type: 'extract', goal: 'anything' }, () => null, window);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no readable text');
  });
});
