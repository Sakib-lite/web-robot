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
    default:
      return { ok: false, detail: `action ${action.type} is handled by the browser, not the page` };
  }
}

function requireElement(resolve: ElementRef, ref: string): { ok: true; el: Element } | { ok: false; detail: string } {
  const el = resolve(ref);
  if (!el || !el.isConnected) return { ok: false, detail: `ref ${ref} not found on the page - take a new snapshot` };
  return { ok: true, el };
}

async function click(resolve: ElementRef, ref: string): Promise<ActionResult> {
  const found = requireElement(resolve, ref);
  if (!found.ok) return found;
  const el = found.el;
  el.scrollIntoView({ block: 'center' });
  (el as HTMLElement).click();
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
