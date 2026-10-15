import type { Action, Snapshot, TabInfo } from '../driver/types';

export type ContentRequest =
  | { type: 'PING' }
  | { type: 'SNAPSHOT'; skip?: number }
  | { type: 'ACT'; action: Extract<Action, { type: 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'wait' | 'extract' }> };

export type ContentResponse =
  | { ok: true; url?: string; snapshot?: Snapshot; detail?: string }
  | { ok: false; error: string };

export type PanelRequest =
  | { type: 'GET_TABS' }
  | { type: 'GET_SNAPSHOT'; skip?: number; tabId?: number }
  | { type: 'RUN_ACTION'; action: Action; tabId?: number };

export type PanelResponse =
  | { ok: true; tabs?: TabInfo[]; snapshot?: Snapshot; detail?: string; data?: unknown }
  | { ok: false; error: string };
