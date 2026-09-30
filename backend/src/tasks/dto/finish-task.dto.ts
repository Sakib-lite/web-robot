export class FinishTaskDto {
  status!: 'done' | 'failed' | 'stopped' | 'running';
  summary?: string;
  reason?: string;
  stepCount!: number;
}
