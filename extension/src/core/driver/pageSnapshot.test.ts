// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { buildSnapshot, collectInteractive } from './pageSnapshot';

function withBody(html: string) {
  document.body.innerHTML = html;
  return document;
}

describe('collectInteractive', () => {
  it('collects links, buttons, inputs and selects', () => {
    withBody(`
      <a href="/about">About</a>
      <button>Save</button>
      <input type="text" placeholder="Search" />
      <select><option>a</option></select>
      <textarea></textarea>
    `);
    const tags = collectInteractive(document).map((el) => el.tagName.toLowerCase());
    expect(tags).toEqual(['a', 'button', 'input', 'select', 'textarea']);
  });

  it('skips hidden inputs and aria-hidden elements', () => {
    withBody(`
      <input type="hidden" name="csrf" />
      <input type="text" aria-hidden="true" />
      <input type="text" id="visible" />
    `);
    const collected = collectInteractive(document);
    expect(collected).toHaveLength(1);
    expect(collected[0]!.id).toBe('visible');
  });

  it('caps the element list', () => {
    withBody(Array.from({ length: 120 }, (_, i) => `<a href="/x${i}">x${i}</a>`).join(''));
    expect(collectInteractive(document)).toHaveLength(80);
  });
});

describe('buildSnapshot', () => {
  it('describes elements with refs, kinds, names and values', () => {
    withBody(`
      <form>
        <label for="email">Email</label>
        <input id="email" type="text" value="a@b.dev" />
        <input type="password" value="secret" />
        <a href="/next">Next page</a>
        <button type="submit">Place order</button>
        <select id="size">
          <option value="s">Small</option>
          <option value="m" selected>Medium</option>
        </select>
      </form>
    `);
    const snap = buildSnapshot(document);

    expect(snap.elements.map((e) => e.ref)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    const [email, password, link, button, select] = snap.elements;

    expect(email).toMatchObject({ kind: 'textbox', name: 'Email', value: 'a@b.dev' });
    expect(password).toMatchObject({ kind: 'textbox', value: '********' });
    expect(link).toMatchObject({ kind: 'link', name: 'Next page' });
    expect(button).toMatchObject({ kind: 'button', name: 'Place order' });
    expect(select).toMatchObject({ kind: 'select', options: ['Small', 'Medium'] });
  });

  it('uses aria-label and placeholder as fallback names', () => {
    withBody(`
      <input type="text" aria-label="Coupon code" />
      <input type="text" placeholder="Your name" />
    `);
    const snap = buildSnapshot(document);
    expect(snap.elements[0]!.name).toBe('Coupon code');
    expect(snap.elements[1]!.name).toBe('Your name');
  });

  it('truncates page text and collapses blank lines', () => {
    withBody(`<p>${'x'.repeat(6000)}</p><p>tail</p>`);
    const snap = buildSnapshot(document);
    expect(snap.text.length).toBeLessThanOrEqual(4000);
  });

  it('carries the page url and title', () => {
    withBody('<p>hi</p>');
    document.title = 'Shop';
    const snap = buildSnapshot(document);
    expect(snap.title).toBe('Shop');
    expect(snap.url).toContain('http');
  });

  it('prefers main content over body noise in the page text', () => {
    withBody(`
      <header>Sign up Sign in Dashboard notifications</header>
      <main><h1>Repositories</h1><p>web-robot</p><p>stopwatch</p></main>
    `);
    const snap = buildSnapshot(document);
    expect(snap.text).toContain('web-robot');
    expect(snap.text).toContain('Repositories');
    expect(snap.text).not.toContain('notifications');
  });
});
