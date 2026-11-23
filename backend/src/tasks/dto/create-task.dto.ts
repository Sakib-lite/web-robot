export class CreateTaskDto {
  taskText!: string;
  skill?: string;
  product?: string;
  model?: string;
  effort?: string;
  steps?: string[];
}
