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

const REF_FORWARD = Symbol('web-robot-refs');
const REF_BACKWARD = Symbol('web-robot-refs-inverse');

function refMaps(doc: Document): { fwd: Map<Element, string>; back: Map<string, Element> } {
  const body = doc.body;
  if (!body) return { fwd: new Map(), back: new Map() };
  let fwd = (body as unknown as Record<symbol, Map<Element, string> | undefined>)[REF_FORWARD];
  let back = (body as unknown as Record<symbol, Map<string, Element> | undefined>)[REF_BACKWARD];
  if (!fwd || !back) {
    fwd = new Map();
    back = new Map();
    (body as unknown as Record<symbol, Map<Element, string>>)[REF_FORWARD] = fwd;
    (body as unknown as Record<symbol, Map<string, Element>>)[REF_BACKWARD] = back;
  }
  return { fwd, back };
}

export function resetRefMaps(doc: Document): void {
  const body = doc.body as unknown as Record<symbol, unknown> | null;
  if (body) {
    delete body[REF_FORWARD];
    delete body[REF_BACKWARD];
  }
}

export function elementForRef(doc: Document, ref: string): Element | null {
  return refMaps(doc).back.get(ref) ?? null;
}

function refFor(doc: Document, el: Element): string {
  const { fwd, back } = refMaps(doc);
  const existing = fwd.get(el);
  if (existing) return existing;
  const ref = `e${back.size + 1}`;
  fwd.set(el, ref);
  back.set(ref, el);
  return ref;
}

export function collectInteractive(root: ParentNode): Element[] {
  const nodes = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));
  const base = nodes.filter((el) => {
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return el.getClientRects().length > 0;
  });
  const included = new Set(base);
  const withRole = Array.from(root.querySelectorAll('[role]')).filter((el) => {
    const role = el.getAttribute('role')!;
    if (role === 'none' || role === 'presentation') return false;
    return !included.has(el) && el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true';
  });
  const pointerTargets = withRole.filter((el) => hasPointerCursor(el) || ['button', 'link', 'option', 'menuitem', 'tab', 'switch', 'treeitem', 'gridcell'].includes(el.getAttribute('role')!));
  return [...base, ...pointerTargets];
}

export function countInteractive(root: ParentNode): number {
  return collectInteractive(root).length;
}

function hasPointerCursor(el: Element): boolean {
  try {
    return el instanceof Element && (el.ownerDocument.defaultView?.getComputedStyle(el).cursor === 'pointer');
  } catch {
    return false;
  }
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

export function describeElement(el: Element, ref: string): ElementInfo {
  const expanded = el.getAttribute('aria-expanded');
  const input = el as HTMLInputElement;
  const checked = input instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'radio')
    ? input.checked
    : el.getAttribute('aria-checked') === 'true' ? true : el.getAttribute('aria-checked') === 'false' ? false : undefined;
  return {
    ref,
    tag: el.tagName.toLowerCase(),
    ...(el.getAttribute('role') ? { role: el.getAttribute('role')! } : {}),
    name: nameFor(el),
    kind: kindFor(el),
    ...('value' in el || el.getAttribute('contenteditable') === 'true'
      ? { value: valueFor(el) }
      : {}),
    ...(expanded === 'true' || expanded === 'false' ? { expanded: expanded === 'true' } : {}),
    ...(checked !== undefined ? { checked } : {}),
    ...(optionsFor(el)?.length ? { options: optionsFor(el)! } : {}),
  };
}

export function buildSnapshot(doc: Document, skip = 0): Snapshot {
  const all = collectInteractive(doc);
  const start = Math.min(Math.max(0, Math.floor(skip)), Math.max(0, all.length - 1));
  const window = all.slice(start, start + MAX_ELEMENTS);
  const elements = window.map((el) => describeElement(el, refFor(doc, el)));
  const ariaTree = buildAriaTree(doc, window);
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
    ariaTree,
  };
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

const REGION_SELECTOR = 'main, [role="main"], nav, aside, header, footer, [role="complementary"], [role="banner"], dialog, [role="dialog"], article';

const MAX_TREE_LINES = 120;

export function buildAriaTree(doc: Document, interactiveWindow: Element[]): string {
  const regionEls = Array.from(doc.querySelectorAll(REGION_SELECTOR));
  const interactiveSet = new Set(interactiveWindow);
  const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter((h) => (h.textContent ?? '').trim());

  type Entry = { el: Element; ref?: string; kind: 'node' | 'heading' };
  const entries: Entry[] = [
    ...interactiveWindow.map((el) => ({ el, ref: refFor(doc, el), kind: 'node' as const })),
    ...headings.map((el) => ({ el, kind: 'heading' as const })),
  ];
  entries.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  const emittedRegions = new Set<Element>();
  const lines: string[] = [];
  const regionDepth = (el: Element): number => {
    let d = 0;
    let p = el.parentElement;
    while (p) {
      if (regionEls.includes(p)) d++;
      p = p.parentElement;
    }
    return d;
  };
  const labelRegion = (el: Element): string => {
    const role = el.getAttribute('role');
    const label = el.getAttribute('aria-label')?.trim();
    const tag = el.tagName.toLowerCase();
    const name = role && role !== tag ? role : tag;
    return label ? `${name} "${label.slice(0, 40)}"` : name;
  };

  for (const entry of entries) {
    const ancestors = regionEls.filter((r) => r !== entry.el && r.contains(entry.el));
    for (const region of ancestors) {
      if (!emittedRegions.has(region)) {
        emittedRegions.add(region);
        lines.push(`${'  '.repeat(regionDepth(region))}- ${labelRegion(region)}`);
      }
    }
    let depth = ancestors.length;
    let p = entry.el.parentElement;
    while (p) {
      if (interactiveSet.has(p)) depth++;
      p = p.parentElement;
    }
    if (entry.kind === 'heading') {
      const level = Number(entry.el.tagName[1]);
      lines.push(`${'  '.repeat(depth)}- heading "${(entry.el.textContent ?? '').trim().slice(0, 70)}" [level=${level}]`);
    } else {
      const info = describeElement(entry.el, entry.ref!);
      const name = info.name ? ` "${info.name.slice(0, 80)}"` : '';
      lines.push(`${'  '.repeat(depth)}- ${info.kind}${name} [${entry.ref}]`);
    }
    if (lines.length >= MAX_TREE_LINES) {
      lines.push('… (tree truncated - snapshot with skip for the next window)');
      return lines.join('\n');
    }
  }
  return lines.join('\n');
}
