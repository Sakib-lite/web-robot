import { Injectable, OnModuleInit } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import * as fs from 'node:fs/promises';

// caps mirrored from docs/rnd-local-agentic-worker.md §2.1 - every number here
// exists to keep file content from flooding the model context or the db
export const READ_DEFAULT_LIMIT = 300;
export const READ_MAX_LIMIT = 1000;
const READ_LINE_TRUNCATE = 500;
const READ_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WRITE_CHARS = 100 * 1024;
const MAX_EDIT_OLD_CHARS = 2 * 1024;
const MAX_LIST_ENTRIES = 200;
const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
const EXEC_MAX_TIMEOUT_MS = 600_000;
const EXEC_OUTPUT_CAP = 8 * 1024;

// a cheap deny-list of catastrophic classics - the workspace root is the real
// blast-radius boundary; this list just blocks the obviously unrecoverable
const DENY_PATTERNS: Array<[RegExp, string]> = [
  [/\bsudo\b/, 'sudo'],
  [/\bosascript\b/, 'osascript'],
  [/\.ssh\b/, '~/.ssh access'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'piping a download into a shell'],
  [/\brm\s+[^;|&]*-(\w*r\w*f|\w*f\w*r)\w*\s+(\/|~|\$HOME)(\s|['"]|$)/, 'rm -rf on an absolute or home path'],
  [/\bchmod\s+-R\s+777\s+\/(\s|$)/, 'chmod -R 777 /'],
  [/\b(shutdown|reboot|halt)\b/, 'shutdown/reboot'],
];

export type WorkspaceErrorCode =
  | 'ESCAPE'
  | 'NOT_FOUND'
  | 'EXISTS'
  | 'NO_MATCH'
  | 'AMBIGUOUS'
  | 'DENIED'
  | 'TOO_LARGE'
  | 'INVALID';

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DirEntry {
  name: string;
  dir: boolean;
  size?: number;
  mtime?: string;
}

export interface FileSlice {
  path: string;
  totalLines: number;
  offset: number;
  lines: Array<{ n: number; text: string }>;
}

export interface ExecResult {
  code: number;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

@Injectable()
export class WorkspaceService implements OnModuleInit {
  private readonly root: string;
  private realRoot = '';
  private enabled = true;

  constructor() {
    const configured = process.env.WEB_ROBOT_WORKSPACE ?? join(homedir(), 'robots');
    this.root = resolve(configured);
  }

  async onModuleInit() {
    await fs.mkdir(this.root, { recursive: true });
    this.realRoot = await fs.realpath(this.root);
  }

  workspaceRoot(): string {
    return this.root;
  }

  // ---- skills ------------------------------------------------------------
  // a skill is skills/<slug>/SKILL.md with a simple `key: value` frontmatter
  // (name, description, and optional model/effort/maxSteps defaults); only
  // name+description are listed - the body is loaded on selection

  private parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    if (!match) return { meta: {}, body: raw };
    const meta: Record<string, string> = {};
    for (const line of match[1]!.split('\n')) {
      const kv = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1]!] = kv[2]!.trim();
    }
    return { meta, body: match[2] ?? '' };
  }

  async listSkills(): Promise<Array<{ slug: string; name: string; description: string }>> {
    const skillsDir = join(this.root, 'skills');
    let dirents;
    try {
      dirents = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch {
      return []; // no skills yet
    }
    const skills: Array<{ slug: string; name: string; description: string }> = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      try {
        const raw = await fs.readFile(join(skillsDir, dirent.name, 'SKILL.md'), 'utf8');
        const { meta } = this.parseFrontmatter(raw);
        skills.push({
          slug: dirent.name,
          name: meta.name ?? dirent.name,
          description: meta.description ?? '',
        });
      } catch {
        // dir without SKILL.md - skip
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills;
  }

  async getSkill(slug: string): Promise<{ slug: string; name: string; description: string; body: string; defaults: Record<string, string> }> {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new WorkspaceError('INVALID', 'bad skill slug');
    let raw: string;
    try {
      raw = await fs.readFile(join(this.root, 'skills', slug, 'SKILL.md'), 'utf8');
    } catch {
      throw new WorkspaceError('NOT_FOUND', `skill "${slug}" does not exist`);
    }
    const { meta, body } = this.parseFrontmatter(raw);
    const defaults: Record<string, string> = {};
    for (const key of ['model', 'effort', 'maxSteps']) {
      if (meta[key]) defaults[key] = meta[key]!;
    }
    return {
      slug,
      name: meta.name ?? slug,
      description: meta.description ?? '',
      body: body.trim(),
      defaults,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean) {
    this.enabled = value;
  }

  private assertInside(rel: string): string {
    const cleaned = (rel ?? '').toString().trim();
    if (cleaned.includes('\0')) throw new WorkspaceError('INVALID', 'path contains null bytes');
    if (!cleaned) return this.root;
    if (isAbsolute(cleaned)) {
      throw new WorkspaceError('ESCAPE', `"${cleaned}" is absolute - use a path relative to the workspace root`);
    }
    const target = resolve(this.root, cleaned);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new WorkspaceError('ESCAPE', `"${cleaned}" resolves outside the workspace`);
    }
    return target;
  }

  // symlink escape guard: realpath the deepest existing ancestor and make sure
  // it still lives under the real root - the non-existing remainder cannot be
  // a symlink, so the whole target is then provably inside
  private async assertNoSymlinkEscape(target: string, rel: string) {
    if (!this.realRoot) await this.onModuleInit();
    let existing = target;
    for (;;) {
      try {
        existing = await fs.realpath(existing);
        break;
      } catch {
        const parent = dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
    }
    if (existing !== this.realRoot && !existing.startsWith(this.realRoot + sep)) {
      throw new WorkspaceError('ESCAPE', `"${rel}" escapes the workspace via a symlink`);
    }
  }

  private async ensureParent(target: string) {
    await fs.mkdir(dirname(target), { recursive: true });
  }

  async list(rel = '.'): Promise<{ entries: DirEntry[]; truncated: boolean }> {
    const target = this.assertInside(rel);
    await this.assertNoSymlinkEscape(target, rel);
    let dirents;
    try {
      dirents = await fs.readdir(target, { withFileTypes: true });
    } catch {
      throw new WorkspaceError('NOT_FOUND', `"${rel}" does not exist`);
    }
    const entries: DirEntry[] = [];
    for (const dirent of dirents) {
      let size: number | undefined;
      let mtime: string | undefined;
      if (!dirent.isDirectory()) {
        try {
          const stat = await fs.stat(join(target, dirent.name));
          size = stat.size;
          mtime = stat.mtime.toISOString().slice(0, 10);
        } catch {
          // dangling symlink or raced delete - still list the name
        }
      }
      entries.push({ name: dirent.name, dir: dirent.isDirectory(), size, mtime });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { entries: entries.slice(0, MAX_LIST_ENTRIES), truncated: entries.length > MAX_LIST_ENTRIES };
  }

  async read(rel: string, offset = 1, limit = READ_DEFAULT_LIMIT): Promise<FileSlice> {
    const target = this.assertInside(rel);
    await this.assertNoSymlinkEscape(target, rel);
    let content: string;
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) throw new WorkspaceError('INVALID', `"${rel}" is a directory - use list_dir`);
      if (stat.size > READ_MAX_FILE_BYTES) {
        throw new WorkspaceError('TOO_LARGE', `"${rel}" is ${stat.size} bytes - read it with exec (head/tail/sed ranges) instead`);
      }
      content = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('NOT_FOUND', `"${rel}" does not exist`);
    }
    const all = content.split('\n');
    // a trailing newline terminates the last line, it is not an extra empty one
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const totalLines = all.length;
    const start = Math.max(1, Math.floor(offset));
    const count = Math.min(Math.max(1, Math.floor(limit)), READ_MAX_LIMIT);
    const slice = all.slice(start - 1, start - 1 + count);
    return {
      path: rel,
      totalLines,
      offset: start,
      lines: slice.map((text, i) => ({ n: start + i, text: text.length > READ_LINE_TRUNCATE ? text.slice(0, READ_LINE_TRUNCATE) + '…' : text })),
    };
  }

  async write(rel: string, content: string, onlyIfNew = false): Promise<{ bytes: number }> {
    if (content.length > MAX_WRITE_CHARS) {
      throw new WorkspaceError('TOO_LARGE', `content is ${content.length} chars - the cap is ${MAX_WRITE_CHARS}; write in appends`);
    }
    const target = this.assertInside(rel);
    await this.assertNoSymlinkEscape(target, rel);
    if (onlyIfNew) {
      try {
        await fs.stat(target);
        const existing = await this.read(rel, 1, 1);
        throw new WorkspaceError(
          'EXISTS',
          `"${rel}" already exists (${existing.totalLines} lines) - read_file it first, then edit_file or rewrite`,
        );
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'EXISTS') throw error;
        // NOT_FOUND-style errors fall through to the write
      }
    }
    await this.ensureParent(target);
    await fs.writeFile(target, content, 'utf8');
    return { bytes: Buffer.byteLength(content, 'utf8') };
  }

  async edit(rel: string, oldString: string, newString: string, replaceAll = false): Promise<{ line: number; occurrences: number }> {
    if (oldString.length > MAX_EDIT_OLD_CHARS) {
      throw new WorkspaceError('TOO_LARGE', 'old_string is over 2 KB - use a shorter unique anchor');
    }
    if (!oldString) throw new WorkspaceError('INVALID', 'old_string must not be empty');
    const target = this.assertInside(rel);
    await this.assertNoSymlinkEscape(target, rel);
    let content: string;
    try {
      content = await fs.readFile(target, 'utf8');
    } catch {
      throw new WorkspaceError('NOT_FOUND', `"${rel}" does not exist`);
    }
    const count = content.split(oldString).length - 1;
    if (count === 0) throw new WorkspaceError('NO_MATCH', `old_string not found in "${rel}" - re-read the file and copy the text exactly`);
    if (count > 1 && !replaceAll) {
      throw new WorkspaceError('AMBIGUOUS', `old_string matches ${count} locations in "${rel}" - include more surrounding lines or set replace_all`);
    }
    const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    await fs.writeFile(target, updated, 'utf8');
    const line = updated.slice(0, updated.indexOf(newString)).split('\n').length;
    return { line, occurrences: replaceAll ? count : 1 };
  }

  async append(rel: string, text: string): Promise<{ bytes: number; totalBytes: number }> {
    if (text.length > MAX_WRITE_CHARS) {
      throw new WorkspaceError('TOO_LARGE', `text is ${text.length} chars - the cap is ${MAX_WRITE_CHARS}; append in smaller batches`);
    }
    const target = this.assertInside(rel);
    await this.assertNoSymlinkEscape(target, rel);
    await this.ensureParent(target);
    // explicit trailing-newline handling: an append starting mid-line is
    // almost always a model formatting mistake
    const needsNewline = await fileEndsWithoutNewline(target);
    const payload = (needsNewline && !text.startsWith('\n') ? '\n' : '') + text;
    const fh = await fs.open(target, 'a');
    try {
      await fh.writeFile(payload, 'utf8');
    } finally {
      await fh.close();
    }
    const total = (await fs.stat(target)).size;
    return { bytes: Buffer.byteLength(payload, 'utf8'), totalBytes: total };
  }

  async mkdir(rel: string): Promise<{ path: string }> {
    const target = this.assertInside(rel);
    await this.assertNoSymlinkEscape(target, rel);
    await fs.mkdir(target, { recursive: true });
    return { path: rel };
  }

  async delete(rel: string): Promise<{ path: string }> {
    if (!rel?.trim() || rel.trim() === '.') {
      throw new WorkspaceError('INVALID', 'refusing to delete the workspace root');
    }
    const target = this.assertInside(rel);
    await this.assertNoSymlinkEscape(target, rel);
    try {
      await fs.rm(target, { recursive: true });
    } catch {
      throw new WorkspaceError('NOT_FOUND', `"${rel}" does not exist`);
    }
    return { path: rel };
  }

  async exec(cmd: string, timeoutMs = EXEC_DEFAULT_TIMEOUT_MS): Promise<ExecResult> {
    if (!cmd?.trim()) throw new WorkspaceError('INVALID', 'cmd must not be empty');
    for (const [pattern, what] of DENY_PATTERNS) {
      if (pattern.test(cmd)) throw new WorkspaceError('DENIED', `blocked ${what} - commands are jailed to the workspace`);
    }
    if (!this.realRoot) await this.onModuleInit();
    const timeout = Math.min(Math.max(1000, Math.floor(timeoutMs)), EXEC_MAX_TIMEOUT_MS);
    const started = Date.now();

    return await new Promise<ExecResult>((resolve) => {
      // --noprofile --norc: a workspace command must never source the user's
      // shell profile
      const child = spawn('bash', ['--noprofile', '--norc', '-c', cmd], { cwd: this.root });
      let timedOut = false;
      // bounded head+tail capture: unlimited output must never grow memory,
      // and the cap must keep the end (exit errors, last lines) not just the start
      const KEEP = EXEC_OUTPUT_CAP;
      const head: Buffer[] = [];
      let headLen = 0;
      const tail: Buffer[] = [];
      let tailLen = 0;
      let totalSeen = 0;
      const collect = (chunk: Buffer) => {
        totalSeen += chunk.length;
        if (headLen < KEEP) {
          const take = Math.min(chunk.length, KEEP - headLen);
          head.push(chunk.subarray(0, take));
          headLen += take;
          if (take < chunk.length) {
            tail.push(chunk.subarray(take));
            tailLen += chunk.length - take;
          }
        } else {
          tail.push(chunk);
          tailLen += chunk.length;
        }
        while (tailLen > KEEP && tail.length > 0) {
          const excess = tailLen - KEEP;
          const first = tail[0]!;
          if (first.length <= excess) {
            tail.shift();
            tailLen -= first.length;
          } else {
            tail[0] = first.subarray(excess);
            tailLen -= excess;
          }
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 127, output: `spawn failed: ${error.message}`, timedOut, durationMs: Date.now() - started });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const kept = Buffer.concat([...head, ...tail]).toString('utf8');
        resolve({ code: code ?? (timedOut ? 124 : 1), output: capOutput(kept, totalSeen), timedOut, durationMs: Date.now() - started });
      });
    });
  }
}

function capOutput(output: string, totalSeen: number): string {
  if (totalSeen <= EXEC_OUTPUT_CAP) return output;
  const head = output.slice(0, EXEC_OUTPUT_CAP / 2);
  const tail = output.slice(-(EXEC_OUTPUT_CAP / 2));
  return `${head}\n… ${totalSeen - EXEC_OUTPUT_CAP} chars elided …\n${tail}`;
}

async function fileEndsWithoutNewline(target: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(target, 'r');
    const stat = await fh.stat();
    if (stat.size === 0) return false;
    const buffer = Buffer.alloc(1);
    await fh.read(buffer, 0, 1, stat.size - 1);
    return buffer.toString('utf8') !== '\n';
  } catch {
    return false; // file does not exist yet - a fresh file needs no separator
  } finally {
    await fh?.close();
  }
}
