export class TaskEventDto {
  type!: 'observation' | 'llm_call' | 'action' | 'user_answer';
  step!: number;
  data!: Record<string, unknown>;
}
