import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';

@Module({
  controllers: [TasksController, QueueController],
  providers: [DbService, TasksService, QueueService],
})
export class AppModule {}
