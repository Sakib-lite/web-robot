import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Task } from './task.entity';

@Entity('user_answers')
export class UserAnswer {
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
  question!: string;

  @Column({ type: 'text', nullable: true })
  answer!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
