export interface ClaimedTask {
  taskId: number;
  taskText: string;
  skill?: string;
  model?: string;
  effort?: string;
  context?: string;
  steps?: string[];
  lastMessage?: string;
}

