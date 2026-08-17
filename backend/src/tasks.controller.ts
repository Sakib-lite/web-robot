import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { TasksService } from './tasks.service';

interface CreateTaskDto {
  taskText: string;
  product?: string;
  model?: string;
  effort?: string;
}

interface EventDto {
  type: 'observation' | 'llm_call' | 'action' | 'user_answer';
  step: number;
  data: Record<string, unknown>;
}

interface FinishTaskDto {
  status: 'done' | 'failed' | 'stopped' | 'running';
  summary?: string;
  reason?: string;
  stepCount: number;
}

@Controller()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post('tasks')
  create(@Body() body: CreateTaskDto) {
    return this.tasks.createTask(body);
  }

  @Post('tasks/:id/events')
  async addEvent(@Param('id', ParseUUIDPipe) id: string, @Body() body: EventDto) {
    switch (body.type) {
      case 'observation':
        await this.tasks.addObservation(id, body.step, body.data as never);
        break;
      case 'llm_call':
        await this.tasks.addLlmCall(id, body.step, body.data as never);
        break;
      case 'action':
        await this.tasks.addAction(id, body.step, body.data as never);
        break;
      case 'user_answer':
        await this.tasks.addUserAnswer(id, body.step, body.data as never);
        break;
      default:
        throw new Error(`unknown event type`);
    }
    return { saved: true };
  }

  @Post('tasks/:id/finish')
  finish(@Param('id', ParseUUIDPipe) id: string, @Body() body: FinishTaskDto) {
    return this.tasks.finishTask(id, body);
  }

  @Get('tasks')
  list(@Query('limit') limit?: string) {
    return this.tasks.listTasks(limit ? Number(limit) : 50);
  }

  @Get('tasks/:id/debug')
  debug(@Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.getDebugReport(id);
  }
}
