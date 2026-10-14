import type { ElementInfo, Snapshot } from './types';

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="textbox"]',
  '[role="tab"]',
  '[role="switch"]',
  '[onclick]',
].join(', ');

const MAX_ELEMENTS = 80;
const MAX_TEXT = 4000;

export function collectInteractive(root: ParentNode): Element[] {
  const nodes = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));
  return nodes.filter((el) => {
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return el.getClientRects().length > 0;
  });
}

export function countInteractive(root: ParentNode): number {
  return collectInteractive(root).length;
}

function labelFor(el: Element): string {
  const control = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const id = el.getAttribute('id');
  if (id) {
    const label = el.ownerDocument.querySelector(`label[for="${cssEscape(id)}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  const wrapper = el.closest('label');
  if (wrapper?.textContent?.trim()) return wrapper.textContent.trim();
  if (control instanceof HTMLInputElement && control.type === 'submit' && control.value) return control.value;
  return '';
}

function nameFor(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const label = labelFor(el);
  if (label) return label;
  const text = el.textContent?.trim();
  if (text) return text.slice(0, 80);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return placeholder.trim();
  const title = el.getAttribute('title');
  if (title?.trim()) return title.trim();
  return '';
}

function kindFor(el: Element): ElementInfo['kind'] {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  if (tag === 'a' || role === 'link') return 'link';
  if (tag === 'select' || role === 'listbox') return 'select';
  if (tag === 'textarea' || role === 'textbox' || el.getAttribute('contenteditable') === 'true') return 'textbox';
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || role === 'checkbox') return 'checkbox';
    if (el.type === 'radio' || role === 'radio') return 'radio';
    if (['submit', 'button', 'reset'].includes(el.type) || role === 'button') return 'button';
    return 'textbox';
  }
  return 'button';
}

function valueFor(el: Element): string | undefined {
  if (el instanceof HTMLSelectElement) {
    const selected = el.selectedOptions[0];
    return selected?.textContent?.trim() || el.value;
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return el.value ? '********' : '';
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'checked' : '';
    return el.value;
  }
  if (el instanceof HTMLTextAreaElement) return el.value;
  if (el.getAttribute('contenteditable') === 'true') return el.textContent ?? '';
  return undefined;
}

function optionsFor(el: Element): string[] | undefined {
  if (!(el instanceof HTMLSelectElement)) return undefined;
  return Array.from(el.options)
    .map((option) => option.textContent?.trim() || option.value)
    .slice(0, 15);
}

export function describeElement(el: Element, index: number): ElementInfo {
  const expanded = el.getAttribute('aria-expanded');
  return {
    ref: `e${index + 1}`,
    tag: el.tagName.toLowerCase(),
    ...(el.getAttribute('role') ? { role: el.getAttribute('role')! } : {}),
    name: nameFor(el),
    kind: kindFor(el),
    ...('value' in el || el.getAttribute('contenteditable') === 'true'
      ? { value: valueFor(el) }
      : {}),
    ...(expanded === 'true' || expanded === 'false' ? { expanded: expanded === 'true' } : {}),
    ...(optionsFor(el)?.length ? { options: optionsFor(el)! } : {}),
  };
}

export function buildSnapshot(doc: Document, skip = 0): Snapshot {
  const all = collectInteractive(doc);
  const start = Math.min(Math.max(0, Math.floor(skip)), Math.max(0, all.length - 1));
  const window = all.slice(start, start + MAX_ELEMENTS);
  const elements = window.map((el, index) => describeElement(el, start + index));
  const mainRoot = doc.querySelector('main, [role="main"], article') as HTMLElement | null;
  let rawText = mainRoot?.innerText ?? '';
  const mainLen = rawText.trim().length;
  if (doc.body) {
    const bodyText = doc.body.innerText ?? '';
    if (mainLen < 200 && bodyText.trim().length > mainLen * 3) rawText = bodyText;
  }
  const text = rawText.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return {
    url: doc.defaultView?.location.href ?? '',
    title: doc.title ?? '',
    text: text.slice(0, MAX_TEXT),
    textTruncated: text.length > MAX_TEXT,
    elements,
    elementsTruncated: start + window.length < all.length,
    elementStart: start,
    elementTotal: all.length,
  };
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
