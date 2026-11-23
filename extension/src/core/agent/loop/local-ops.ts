import type { LocalCall } from '../tools/tools.types';
import { PlaneError, type LocalPlane } from '../../local/plane.types';

export interface LocalOutcome {
  ok: boolean;
  detail: string;
  label?: string;
  text?: string | null;
  path?: string;
  durationMs: number;
}

export async function runLocal(call: LocalCall, plane: LocalPlane, ledger: Set<string>, taskDir: string | null, workspaceRoot?: string): Promise<LocalOutcome> {
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
      case 'fetch_url': {
        const page = await plane.webFetch(call.url);
        return {
          ok: true,
          detail: `"${page.title}" ${page.url} (${page.text.length} chars${page.truncated ? ', truncated' : ''})`,
          label: `fetch ${call.url.slice(0, 80)}`,
          text: `${page.title}\n${page.url}\n\n${page.text}`,
          durationMs: dur(),
        };
      }
      case 'search_web': {
        const { results } = await plane.webSearch(call.query);
        if (results.length === 0) {
          return { ok: true, detail: 'no results', label: `search "${call.query.slice(0, 60)}"`, text: '(no results - reword the query)', durationMs: dur() };
        }
        const text = results.map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`).join('\n');
        return { ok: true, detail: `${results.length} results`, label: `search "${call.query.slice(0, 60)}"`, text, durationMs: dur() };
      }
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
        let cmd = call.cmd;
        if (taskDir) {
          cmd = cmd.split(taskDir + '/').join('./');
          if (workspaceRoot) cmd = cmd.split(`${workspaceRoot}/${taskDir}/`).join('./');
        }
        const res = await plane.exec(cmd, call.timeoutMs, taskDir ?? undefined);
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
