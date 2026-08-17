import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(Number(process.env.BACKEND_PORT ?? 3010));
  console.log(`[web-robot backend] listening on http://127.0.0.1:${process.env.BACKEND_PORT ?? 3010}`);
}

void bootstrap();
