import type { z } from 'zod';
import type { Action } from '../../driver/types';

export interface ToolSpec {
  description: string;
  schema: z.ZodType;
}

export type AgentCall =
  | { kind: 'action'; action: Action }
  | { kind: 'observe'; skip?: number }
  | { kind: 'note'; text: string }
  | { kind: 'local'; call: LocalCall }
  | { kind: 'sub_agent'; task: string; budget?: number }
  | { kind: 'ask_user'; question: string; recommended?: string }
  | { kind: 'done'; summary: string; data?: unknown }
  | { kind: 'fail'; reason: string };

export type LocalCall =
  | { op: 'fetch_url'; url: string }
  | { op: 'search_web'; query: string }
  | { op: 'list_dir'; path?: string }
  | { op: 'read_file'; path: string; offset?: number; limit?: number }
  | { op: 'write_file'; path: string; content: string }
  | { op: 'edit_file'; path: string; oldString: string; newString: string; replaceAll?: boolean }
  | { op: 'append_file'; path: string; text: string }
  | { op: 'delete_path'; path: string }
  | { op: 'mkdir'; path: string }
  | { op: 'exec'; cmd: string; timeoutMs?: number };
