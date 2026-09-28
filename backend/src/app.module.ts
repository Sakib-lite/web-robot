import { Module } from '@nestjs/common';
import { DbModule } from './common/db.module';
import { TasksModule } from './tasks/tasks.module';
import { QueueModule } from './queue/queue.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { ProvidersModule } from './providers/providers.module';

@Module({
  imports: [DbModule, TasksModule, QueueModule, WorkspaceModule, ProvidersModule],
})
export class AppModule {}
