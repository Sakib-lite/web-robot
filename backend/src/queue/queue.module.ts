import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';
import { Task } from '../tasks/entities/task.entity';
import { TaskMessage } from '../tasks/entities/task-message.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Task, TaskMessage])],
  controllers: [QueueController],
  providers: [QueueService],
})
export class QueueModule {}
