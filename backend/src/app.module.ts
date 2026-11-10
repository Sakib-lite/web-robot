import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { prepareDatabase, typeormConfig } from './common/db-bootstrap';
import { TasksModule } from './tasks/tasks.module';
import { QueueModule } from './queue/queue.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { ProvidersModule } from './providers/providers.module';
import { WebModule } from './web/web.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: async () => {
        await prepareDatabase();
        return typeormConfig();
      },
    }),
    TasksModule,
    QueueModule,
    WorkspaceModule,
    ProvidersModule,
    WebModule,
  ],
})
export class AppModule {}
