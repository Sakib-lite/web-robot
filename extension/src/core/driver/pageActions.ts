import type { Action, ActionResult } from './types';

export type ElementRef = (ref: string) => Element | null;

export async function runPageAction(action: Action, resolve: ElementRef, win: Window): Promise<ActionResult> {
  switch (action.type) {
    case 'click':
      return click(resolve, action.ref);
    case 'fill':
      return fill(resolve, action.ref, action.text);
    case 'select':
      return selectOption(resolve, action.ref, action.option);
    case 'press':
      return pressKey(resolve, action.key);
    case 'scroll':
      return scroll(win, action.direction, action.amount);
    case 'wait':
      return sleep(action.ms);
    case 'extract':
      return extractContent(action.goal);
    default:
      return { ok: false, detail: `action ${action.type} is handled by the browser, not the page` };
  }
}

export function mainContentText(doc: Document, limit = 6000): string {
  const root = doc.querySelector('main, [role="main"], article') ?? doc.body;
  return (root?.textContent ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, limit);
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'which', 'any', 'are', 'was', 'has', 'have', 'listed', 'list', 'quote', 'find', 'page', 'section', 'paragraph', 'sentence', 'mention', 'mentions', 'mentioned', 'exact', 'especially', 'after', 'about', 'their', 'them', 'does', 'minimum', 'score', 'scores']);

function goalKeywords(goal: string): string[] {
  return [...new Set(goal.toLowerCase().split(/[^a-z0-9.]+/).filter((word) => word.length > 1 && !STOPWORDS.has(word)))];
}

function pageOutline(doc: Document): string {
  const headings = Array.from(doc.querySelectorAll('h1, h2, h3'))
    .map((h) => `${h.tagName.toLowerCase()}: ${h.textContent?.trim().slice(0, 90)}`)
    .filter((line) => line.length > 5);
  return [...new Set(headings)].slice(0, 25).join('\n');
}

// goal-aware extraction: return lines matching the goal with context, plus a
// page outline so the model can see what else exists instead of re-asking
export function extractForGoal(doc: Document, goal: string): string {
  const root = doc.querySelector('main, [role="main"], article') ?? doc.body;
  const fullText = (root?.textContent ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const keywords = goalKeywords(goal);
  const outline = pageOutline(doc);

  if (keywords.length === 0) {
    return `PAGE OUTLINE:\n${outline}\n\nTEXT (first 3000 chars):\n${fullText.join('\n').slice(0, 3000)}`;
  }

  const scored: Array<{ index: number; hits: number }> = [];
  fullText.forEach((line, index) => {
    const lower = line.toLowerCase();
    const hits = keywords.filter((keyword) => lower.includes(keyword)).length;
    if (hits > 0) scored.push({ index, hits });
  });
  scored.sort((a, b) => b.hits - a.hits);

  if (scored.length === 0) {
    return [
      `NO TEXT MATCHES YOUR GOAL on this page.`,
      `PAGE OUTLINE (navigate to a section or try another page):`,
      outline,
      `TEXT START:\n${fullText.join('\n').slice(0, 1200)}`,
    ].join('\n');
  }

  const chosen = new Set<number>();
  for (const { index } of scored.slice(0, 12)) {
    for (let offset = -2; offset <= 2; offset++) {
      const neighbor = fullText[index + offset];
      if (neighbor) chosen.add(index + offset);
    }
  }
  const matchLines = [...chosen].sort((a, b) => a - b).map((index) => fullText[index]).join('\n');
  return `MATCHING TEXT (for: ${goal.slice(0, 80)}):\n${matchLines.slice(0, 3500)}\n\nPAGE OUTLINE:\n${outline}`;
}

function extractContent(goal: string): Promise<ActionResult> {
  const root = doc_main();
  const hasText = (root?.textContent ?? '').trim().length > 0;
  if (!hasText) return Promise.resolve({ ok: false, detail: 'no readable text found on this page' });
  return Promise.resolve({ ok: true, detail: extractForGoal(document, goal) });
}

function doc_main(): Element | null {
  return document.querySelector('main, [role="main"], article') ?? document.body;
}

function requireElement(resolve: ElementRef, ref: string): { ok: true; el: Element } | { ok: false; detail: string } {
  const el = resolve(ref);
  if (!el || !el.isConnected) return { ok: false, detail: `ref ${ref} not found on the page - take a new snapshot` };
  return { ok: true, el };
}

async function click(resolve: ElementRef, ref: string): Promise<ActionResult> {
  const found = requireElement(resolve, ref);
  if (!found.ok) return found;
  const el = found.el as HTMLElement;
  el.scrollIntoView({ block: 'center' });

  // full input-event sequence: some widget libraries (jQuery UI, Drupal
  // accordions) ignore a bare click() but respond to the pointer/mouse chain
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const pointerInit: PointerEventInit = { bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: y, isPrimary: true };
  const mouseInit: MouseEventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
  el.dispatchEvent(new MouseEvent('mousedown', mouseInit));
  el.focus();
  el.dispatchEvent(new PointerEvent('pointerup', pointerInit));
  el.dispatchEvent(new MouseEvent('mouseup', mouseInit));
  el.click();
  return { ok: true, detail: `clicked ${ref}` };
}

async function fill(resolve: ElementRef, ref: string, text: string): Promise<ActionResult> {
  const found = requireElement(resolve, ref);
  if (!found.ok) return found;
  const el = found.el;
  el.scrollIntoView({ block: 'center' });

  if (el.getAttribute('contenteditable') === 'true') {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, detail: `filled ${ref} (contenteditable)` };
  }

  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    return { ok: false, detail: `ref ${ref} is not a text input (${el.tagName.toLowerCase()})` };
  }

  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setValue) {
    setValue.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, detail: `filled ${ref} with "${text.slice(0, 40)}"` };
}

async function selectOption(resolve: ElementRef, ref: string, option: string): Promise<ActionResult> {
  const found = requireElement(resolve, ref);
  if (!found.ok) return found;
  const el = found.el;
  if (!(el instanceof HTMLSelectElement)) {
    return { ok: false, detail: `ref ${ref} is not a select (${el.tagName.toLowerCase()})` };
  }

  const labelOf = (option: HTMLOptionElement) => option.textContent?.trim() || option.value;
  const wanted = option.trim().toLowerCase();
  const match =
    Array.from(el.options).find((o) => o.value === option) ??
    Array.from(el.options).find((o) => labelOf(o).toLowerCase() === wanted) ??
    Array.from(el.options).find((o) => labelOf(o).toLowerCase().includes(wanted));

  if (!match) {
    return { ok: false, detail: `option "${option}" not in select ${ref}` };
  }

  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, detail: `selected "${labelOf(match)}" in ${ref}` };
}

async function pressKey(resolve: ElementRef, key: string): Promise<ActionResult> {
  const target = (document.activeElement as Element | null) ?? resolve('e1');
  if (!target) return { ok: false, detail: 'nothing focused to press a key on' };

  const eventInit: KeyboardEventInit = { key, bubbles: true, cancelable: true };
  const keydown = new KeyboardEvent('keydown', eventInit);
  target.dispatchEvent(keydown);
  target.dispatchEvent(new KeyboardEvent('keyup', eventInit));

  if (key === 'Enter' && !keydown.defaultPrevented && target instanceof HTMLInputElement && target.form) {
    target.form.requestSubmit();
  }
  return { ok: true, detail: `pressed ${key}` };
}

async function scroll(win: Window, direction: 'up' | 'down', amount?: number): Promise<ActionResult> {
  const distance = amount ?? 600;
  win.scrollBy(0, direction === 'down' ? distance : -distance);
  return { ok: true, detail: `scrolled ${direction} ${distance}px` };
}

function sleep(ms: number): Promise<ActionResult> {
  return new Promise((resolve) => setTimeout(() => resolve({ ok: true, detail: `waited ${ms}ms` }), ms));
}
