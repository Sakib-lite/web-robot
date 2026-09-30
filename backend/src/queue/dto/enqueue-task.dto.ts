export class EnqueueTaskDto {
  taskText!: string;
  skill?: string;
  model?: string;
  effort?: string;
  context?: string;
  steps?: string[];
}
