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

  it('returns every visible element (windowing happens in buildSnapshot)', () => {
    withBody(Array.from({ length: 120 }, (_, i) => `<a href="/x${i}">x${i}</a>`).join(''));
    expect(collectInteractive(document)).toHaveLength(120);
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

  it('exposes accordion expansion state', () => {
    withBody(`
      <button aria-expanded="false">FAQ one</button>
      <button aria-expanded="true">FAQ two</button>
      <button>FAQ three</button>
    `);
    const [one, two, three] = buildSnapshot(document).elements;
    expect(one!.expanded).toBe(false);
    expect(two!.expanded).toBe(true);
    expect(three!.expanded).toBeUndefined();
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

describe('truncation + thin-main fallback (the phd.com lesson)', () => {
  it('marks elements as truncated when more than the cap exist', () => {
    withBody(Array.from({ length: 90 }, (_, i) => `<a href="/x${i}">link ${i}</a>`).join(''));
    const snap = buildSnapshot(document);
    expect(snap.elements).toHaveLength(80);
    expect(snap.elementsTruncated).toBe(true);
  });

  it('pages through long element lists with skip and stable absolute refs', () => {
    withBody(Array.from({ length: 120 }, (_, i) => `<a href="/x${i}">link ${i}</a>`).join(''));
    const first = buildSnapshot(document);
    expect(first.elementStart).toBe(0);
    expect(first.elementTotal).toBe(120);
    expect(first.elements[0]!.ref).toBe('e1');
    expect(first.elements[79]!.ref).toBe('e80');

    const second = buildSnapshot(document, 80);
    expect(second.elements).toHaveLength(40);
    expect(second.elements[0]!.ref).toBe('e81');
    expect(second.elements[39]!.ref).toBe('e120');
    expect(second.elementsTruncated).toBe(false);
    expect(second.elementStart).toBe(80);

    const past = buildSnapshot(document, 500);
    expect(past.elements).toHaveLength(1);
    expect(past.elements[0]!.ref).toBe('e120');
  });

  it('does not mark truncation when under the cap', () => {
    withBody('<a href="/a">a</a><button>b</button>');
    const snap = buildSnapshot(document);
    expect(snap.elementsTruncated).toBeFalsy();
  });

  it('marks text as truncated when the page text exceeds the cap', () => {
    withBody(`<main><p>${'word '.repeat(2000)}</p></main>`);
    const snap = buildSnapshot(document);
    expect(snap.text.length).toBeLessThanOrEqual(4000);
    expect(snap.textTruncated).toBe(true);
  });

  it('falls back to body text when <main> is a near-empty shell (SPA detail pane)', () => {
    withBody(`
      <main>Select a position on the left</main>
      <aside>
        <div role="button">Fully Funded PhD Program 2027 - ISTA</div>
        <div role="button">PhD Positions Fall 2027 - Columbia University</div>
        <span>36 new · 288 applied</span>
      </aside>
    `);
    const snap = buildSnapshot(document);
    expect(snap.text).toContain('ISTA');
    expect(snap.text).toContain('36 new');
  });

  it('keeps main content when it is substantial (no noisy body fallback)', () => {
    withBody(`
      <header>notifications avatar settings</header>
      <main>${'<p>substantial article content. </p>'.repeat(20)}</main>
      <footer>footer noise</footer>
    `);
    const snap = buildSnapshot(document);
    expect(snap.text).toContain('article content');
    expect(snap.text).not.toContain('footer noise');
  });

  it('shows a substantial main panel once it opens (the phd.com detail lesson)', () => {
    withBody(`
      <aside>${`<div role="button">Job row with details ${'x'.repeat(120)}</div>`.repeat(48)}</aside>
      <main>Full Funded PhD Programme (ISTA)
Institute of Science and Technology Austria (ISTA)
Field: Computer Science / Data Science
Location: Austria (near Vienna)
Deadline: 8 January 2027, 3:00 PM CET
Funding: €3,053–€3,670 per month (gross)
Contact: prof@example.edu — send CV, transcripts and two referee names before the deadline; English proficiency proof at B2 level or higher is part of the required admission details.</main>
    `);
    const snap = buildSnapshot(document);
    expect(snap.text).toContain('Deadline: 8 January 2027');
    expect(snap.text).toContain('prof@example.edu');
    expect(snap.text).not.toContain('Job row with details');
  });
});
