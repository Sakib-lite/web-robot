import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Task } from './task.entity';

@Entity('actions')
export class Action {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task!: Task;

  @Column({ name: 'task_id' })
  taskId!: number;

  @Column()
  step!: number;

  @Column()
  tool!: string;

  @Column({ type: 'jsonb', nullable: true })
  args!: unknown;

  @Column()
  ok!: boolean;

  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs!: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
