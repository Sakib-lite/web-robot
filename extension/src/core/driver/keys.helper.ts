export interface KeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

export const KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

for (let letter = 0; letter < 26; letter++) {
  const char = String.fromCharCode(97 + letter);
  KEYS[char] = { key: char, code: 'Key' + String.fromCharCode(65 + letter), windowsVirtualKeyCode: 65 + letter, text: char };
}
for (let digit = 0; digit <= 9; digit++) {
  const char = String(digit);
  KEYS[char] = { key: char, code: 'Digit' + char, windowsVirtualKeyCode: 48 + digit, text: char };
}
for (let fn = 1; fn <= 12; fn++) {
  const name = 'F' + fn;
  KEYS[name.toLowerCase()] = { key: name, code: name, windowsVirtualKeyCode: 111 + fn };
}

const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, meta: 4, shift: 8 };

export function modifiersMask(mods: string[]): number {
  let mask = 0;
  for (const mod of mods) mask |= MODIFIER_BITS[mod.toLowerCase()] ?? 0;
  return mask;
}

export function resolveKey(name: string): KeyDef {
  const def = KEYS[name.toLowerCase()];
  if (!def) throw new Error(`unknown key: ${name}`);
  return def;
}
