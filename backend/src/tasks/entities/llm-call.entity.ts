import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Task } from './task.entity';

@Entity('llm_calls')
export class LlmCall {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task!: Task;

  @Column({ name: 'task_id' })
  taskId!: number;

  @Column()
  step!: number;

  @Column({ type: 'jsonb' })
  messages!: unknown;

  @Column({ name: 'response_content', type: 'text', nullable: true })
  responseContent!: string | null;

  @Column({ name: 'tool_calls', type: 'jsonb', nullable: true })
  toolCalls!: unknown;

  @Column({ type: 'jsonb', nullable: true })
  usage!: unknown;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs!: number | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
