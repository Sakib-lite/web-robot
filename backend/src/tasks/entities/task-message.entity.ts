import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Task } from './task.entity';

@Entity('task_messages')
export class TaskMessage {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @ManyToOne(() => Task, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'task_id' })
  task!: Task;

  @Column({ name: 'task_id' })
  taskId!: number;

  @Column()
  role!: string;

  @Column()
  content!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
