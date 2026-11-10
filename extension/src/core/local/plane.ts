
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

export interface WorkspaceInfo {
  enabled: boolean;
  root: string;
}

export class PlaneError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface LocalPlane {
  describe(): Promise<WorkspaceInfo>;
  list(path?: string): Promise<{ entries: DirEntry[]; truncated: boolean }>;
  read(path: string, offset?: number, limit?: number): Promise<FileSlice>;
  write(path: string, content: string, onlyIfNew?: boolean, encoding?: 'base64'): Promise<{ bytes: number }>;
  edit(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<{ line: number; occurrences: number }>;
  append(path: string, text: string): Promise<{ bytes: number; totalBytes: number }>;
  delete(path: string): Promise<{ path: string }>;
  mkdir(path: string): Promise<{ path: string }>;
  exec(cmd: string, timeoutMs?: number, cwd?: string): Promise<ExecResult>;
  webFetch(url: string): Promise<{ url: string; title: string; text: string; truncated: boolean }>;
  webSearch(query: string): Promise<{ results: WebSearchHit[] }>;
}
