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
