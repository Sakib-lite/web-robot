import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('tasks')
export class Task {
  @PrimaryGeneratedColumn({ type: 'int' })
  id!: number;

  @Column({ name: 'task_text' })
  taskText!: string;

  @Column({ default: 'running' })
  status!: string;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'text', nullable: true })
  product!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'text', nullable: true })
  effort!: string | null;

  @Column({ type: 'text', nullable: true })
  context!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  steps!: string[] | null;

  @Column({ type: 'text', nullable: true })
  skill!: string | null;

  @Column({ default: 0 })
  attempts!: number;

  @Column({ name: 'step_count', default: 0 })
  stepCount!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}
