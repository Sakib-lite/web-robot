import type { Action, Snapshot, TabInfo } from '../driver/types';

export type ContentRequest =
  | { type: 'PING' }
  | { type: 'SNAPSHOT' }
  | { type: 'ACT'; action: Extract<Action, { type: 'click' | 'fill' | 'select' | 'press' | 'scroll' | 'wait' | 'extract' }> };

export type ContentResponse =
  | { ok: true; url?: string; snapshot?: Snapshot; detail?: string }
  | { ok: false; error: string };

export type PanelRequest =
  | { type: 'GET_TABS' }
  | { type: 'GET_SNAPSHOT' }
  | { type: 'RUN_ACTION'; action: Action };

export type PanelResponse =
  | { ok: true; tabs?: TabInfo[]; snapshot?: Snapshot; detail?: string }
  | { ok: false; error: string };
