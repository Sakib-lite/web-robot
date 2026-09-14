// LocalPlane: the agent's local hands. The loop only ever sees this interface;
// the transport (backend http today, native messaging later) is swappable.

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

// carries the backend's machine-readable code (EXISTS, DENIED, …) so the loop
// can branch on it without parsing messages
export class PlaneError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface LocalPlane {
  describe(): Promise<WorkspaceInfo>;
  list(path?: string): Promise<{ entries: DirEntry[]; truncated: boolean }>;
  read(path: string, offset?: number, limit?: number): Promise<FileSlice>;
  write(path: string, content: string, onlyIfNew?: boolean): Promise<{ bytes: number }>;
  edit(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<{ line: number; occurrences: number }>;
  append(path: string, text: string): Promise<{ bytes: number; totalBytes: number }>;
  delete(path: string): Promise<{ path: string }>;
  mkdir(path: string): Promise<{ path: string }>;
  exec(cmd: string, timeoutMs?: number): Promise<ExecResult>;
}
