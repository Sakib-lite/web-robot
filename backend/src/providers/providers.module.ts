import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { LlmProvider } from './entities/llm-provider.entity';

@Module({
  imports: [TypeOrmModule.forFeature([LlmProvider])],
  controllers: [ProvidersController],
  providers: [ProvidersService],
})
export class ProvidersModule {}
