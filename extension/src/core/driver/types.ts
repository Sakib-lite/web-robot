export interface ElementInfo {
  ref: string;
  tag: string;
  role?: string;
  name: string;
  kind: 'link' | 'button' | 'textbox' | 'select' | 'checkbox' | 'radio' | 'other';
  value?: string;
  options?: string[];
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: ElementInfo[];
}

export interface TabInfo {
  id: number;
  url?: string;
  title?: string;
  active: boolean;
}

export type Action =
  | { type: 'goto'; url: string }
  | { type: 'new_tab'; url?: string }
  | { type: 'switch_tab'; tabId: number }
  | { type: 'close_tab'; tabId: number }
  | { type: 'click'; ref: string }
  | { type: 'fill'; ref: string; text: string }
  | { type: 'select'; ref: string; option: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { type: 'wait'; ms: number }
  | { type: 'extract'; goal: string };

export interface ActionResult {
  ok: boolean;
  detail: string;
  data?: unknown;
}

export interface Driver {
  tabs(): Promise<TabInfo[]>;
  snapshot(): Promise<Snapshot>;
  act(action: Action): Promise<ActionResult>;
}
