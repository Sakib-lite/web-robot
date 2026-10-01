import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Task } from './task.entity';

@Entity('observations')
export class Observation {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task!: Task;

  @Column({ name: 'task_id' })
  taskId!: number;

  @Column()
  step!: number;

  @Column({ type: 'text', nullable: true })
  url!: string | null;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', name: 'page_text', nullable: true })
  pageText!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  elements!: unknown;

  @Column({ type: 'jsonb', nullable: true })
  tabs!: unknown;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
