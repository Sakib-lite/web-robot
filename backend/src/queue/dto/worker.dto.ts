export class WorkerControlDto {
  enabled!: boolean;
}

export class WorkerStatusDto {
  source!: string;
  state!: string;
  currentTask?: number;
}
