import type { Action, Snapshot } from '../../driver/types';
import type { LocalCall } from '../tools/tools.types';
import { EXEC_TOTAL_SOFT, FILE_OPS_BLOCK, FILE_OPS_NUDGE } from './loop.constants';

const DANGER_PATTERN = /\b(pay|purchase|buy|checkout|delete|remove|submit|post|send|confirm)\b|\bplace (?:an )?order\b/i;

export function isDangerous(action: Action, snapshot: Snapshot | null): string | null {
  if (action.type !== 'click') return null;
  const el = snapshot?.elements.find((e) => e.ref === action.ref);
  if (el && DANGER_PATTERN.test(el.name)) return `click "${el.name.slice(0, 60)}"`;
  return null;
}

function normalizeUrlForCompare(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    const params = [...url.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}${params.length ? `?${params.join('&')}` : ''}`;
  } catch {
    return raw;
  }
}

export function actionKey(action: Action, snapshot: Snapshot | null): string {
  const state = snapshot
    ? [
        snapshot.url,
        snapshot.title,
        snapshot.text.slice(0, 1500),
        snapshot.text.length,
        snapshot.elements.map((el) => `${el.ref}:${el.expanded ?? ''}:${el.value ?? ''}`).join(','),
      ].join('|')
    : 'none';

  if (action.type === 'goto') return `nav:${normalizeUrlForCompare(action.url)}|${state}`;
  if (action.type === 'new_tab') return `nav:${action.url ? normalizeUrlForCompare(action.url) : 'about:blank'}|${state}`;
  if (action.type === 'switch_tab' || action.type === 'close_tab') return `nav:tab:${action.tabId}|${state}`;
  if (action.type === 'extract') return `extract|${action.goal.trim().toLowerCase().slice(0, 80)}|${state}`;
  return `${JSON.stringify(action)}|${state}`;
}

export function execSpiralGuard(
  call: LocalCall,
  execCount: { total: number },
  fileOps: Map<string, number>,
  notes: string[],
): 'ok' | 'blocked' {
  const targets = new Set<string>();
  if ('path' in call && typeof call.path === 'string') targets.add(call.path);
  if (call.op === 'exec') {
    execCount.total++;
    for (const token of call.cmd.match(/[\w./-]+\.(?:txt|html?|md|json|csv|tsv|xml)\b/gi) ?? []) targets.add(token.toLowerCase());
  }
  for (const target of targets) {
    const seen = (fileOps.get(target) ?? 0) + 1;
    fileOps.set(target, seen);
    if (seen === FILE_OPS_NUDGE) {
      notes.push(
        `You have now run ${seen} commands against "${target}". Slicing a big file through exec burns a step per slice and earlier outputs are dropped from context. Instead: write ONE python script that parses "${target}" fully and writes the final structured output to a new file, then read_file that result once.`,
      );
    }
    if (seen >= FILE_OPS_BLOCK && call.op === 'exec') {
      notes.push(`"${target}" is fenced off: further exec touching it is blocked. Transform it with one script or use read_file.`);
      return 'blocked';
    }
  }
  if (execCount.total === EXEC_TOTAL_SOFT) {
    notes.push(
      `You have used ${execCount.total} exec calls. Each is a full agent step - consolidate all remaining parsing/transformation into as few scripts as possible and produce the deliverable now.`,
    );
  }
  return 'ok';
}
