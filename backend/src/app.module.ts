import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { QueueService } from './queue.service';
import { QueueController } from './queue.controller';
import { WorkspaceService } from './workspace.service';
import { WorkspaceController } from './workspace.controller';
import { ProvidersService } from './providers.service';
import { ProvidersController } from './providers.controller';

@Module({
  controllers: [TasksController, QueueController, WorkspaceController, ProvidersController],
  providers: [DbService, TasksService, QueueService, WorkspaceService, ProvidersService],
})
export class AppModule {}
