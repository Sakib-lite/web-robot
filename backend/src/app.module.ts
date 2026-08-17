import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';

@Module({
  controllers: [TasksController],
  providers: [DbService, TasksService],
})
export class AppModule {}
