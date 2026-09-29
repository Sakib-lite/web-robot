import type { LocalCall } from './tools';
import { PlaneError, type LocalPlane } from '../local/plane';

export interface LocalOutcome {
  ok: boolean;
  detail: string;
  label?: string;
  text?: string | null;
  path?: string;
  durationMs: number;
}

export async function runLocal(call: LocalCall, plane: LocalPlane, ledger: Set<string>, taskDir: string | null): Promise<LocalOutcome> {
  const started = Date.now();
  const dur = () => Date.now() - started;
  const resolve = (p?: string): string | undefined => {
    if (!p) return p;
    const cleaned = p.replace(/^\.\//, '');
    if (!taskDir || cleaned.startsWith(taskDir) || cleaned.startsWith('skills/')) return cleaned;
    return `${taskDir}/${cleaned}`;
  };
  try {
    switch (call.op) {
      case 'list_dir': {
        const path = resolve(call.path);
        const { entries, truncated } = await plane.list(path);
        const text = entries
          .map((e) => `${e.name}${e.dir ? '/' : ''}${e.dir ? '' : ` · ${e.size ?? '?'} B`}${e.mtime ? ` · ${e.mtime}` : ''}`)
          .join('\n');
        return { ok: true, detail: `${entries.length} entries${truncated ? ' (truncated at 200)' : ''}`, label: `list ${path ?? '.'}`, text: text || '(empty directory)', durationMs: dur() };
      }
      case 'read_file': {
        const path = resolve(call.path)!;
        const slice = await plane.read(path, call.offset, call.limit);
        ledger.add(path);
        const end = slice.offset + slice.lines.length - 1;
        const text = slice.lines.map((l) => `${l.n}\t${l.text}`).join('\n');
        return {
          ok: true,
          detail: `lines ${slice.offset}-${end} of ${slice.totalLines}`,
          label: `${path} (lines ${slice.offset}-${end} of ${slice.totalLines})`,
          text: text || '(empty file)',
          durationMs: dur(),
        };
      }
      case 'write_file': {
        const path = resolve(call.path)!;
        if (!ledger.has(path)) {
          try {
            const res = await plane.write(path, call.content, true);
            return { ok: true, detail: `created ${path} (${res.bytes} bytes)`, path, text: null, durationMs: dur() };
          } catch (error) {
            if (error instanceof PlaneError && error.code === 'EXISTS') {
              return { ok: false, detail: error.message, text: null, durationMs: dur() };
            }
            throw error;
          }
        }
        const res = await plane.write(path, call.content);
        return { ok: true, detail: `wrote ${res.bytes} bytes to ${path}`, path, text: null, durationMs: dur() };
      }
      case 'edit_file': {
        const path = resolve(call.path)!;
        if (!ledger.has(path)) {
          return { ok: false, detail: `blocked: read_file ${path} first - blind edits are not allowed`, text: null, durationMs: dur() };
        }
        const res = await plane.edit(path, call.oldString, call.newString, call.replaceAll);
        return { ok: true, detail: `replaced ${res.occurrences} occurrence(s) at line ${res.line}`, path, text: null, durationMs: dur() };
      }
      case 'append_file': {
        const path = resolve(call.path)!;
        const res = await plane.append(path, call.text);
        return { ok: true, detail: `appended ${res.bytes} bytes to ${path} (file now ${res.totalBytes} bytes)`, path, text: null, durationMs: dur() };
      }
      case 'delete_path': {
        const path = resolve(call.path)!;
        await plane.delete(path);
        return { ok: true, detail: `deleted ${path}`, text: null, durationMs: dur() };
      }
      case 'mkdir': {
        const path = resolve(call.path)!;
        await plane.mkdir(path);
        return { ok: true, detail: `created ${path}`, text: null, durationMs: dur() };
      }
      case 'exec': {
        const res = await plane.exec(call.cmd, call.timeoutMs, taskDir ?? undefined);
        const summary = `exit ${res.code} (${(res.durationMs / 1000).toFixed(1)}s)${res.timedOut ? ' - TIMED OUT' : ''}`;
        const text = res.output.trim();
        return { ok: res.code === 0, detail: summary, label: `exec ${call.cmd.slice(0, 80)}`, text: text ? `${summary}\n${text}` : null, durationMs: dur() };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: message.slice(0, 300), text: null, durationMs: dur() };
  }
}
