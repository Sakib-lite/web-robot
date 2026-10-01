import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { Action } from './entities/action.entity';
import { LlmCall } from './entities/llm-call.entity';
import { Observation } from './entities/observation.entity';
import { Task } from './entities/task.entity';
import { TaskMessage } from './entities/task-message.entity';
import { UserAnswer } from './entities/user-answer.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Task, Observation, LlmCall, Action, UserAnswer, TaskMessage])],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
