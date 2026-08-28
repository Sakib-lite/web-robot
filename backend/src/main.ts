import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Injectable, Logger, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AppModule } from './app.module';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('http');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    this.logger.log(`${req.method} ${req.url} from ${req.ip ?? 'unknown'}`);
    return next.handle();
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalInterceptors(new LoggingInterceptor());
  await app.listen(Number(process.env.BACKEND_PORT ?? 3010));
  console.log(`[web-robot backend] listening on http://127.0.0.1:${process.env.BACKEND_PORT ?? 3010}`);
}

void bootstrap();
