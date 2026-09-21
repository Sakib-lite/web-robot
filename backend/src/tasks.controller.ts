import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
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
  async addEvent(@Param('id', ParseIntPipe) id: number, @Body() body: EventDto) {
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
  finish(@Param('id', ParseIntPipe) id: number, @Body() body: FinishTaskDto) {
    return this.tasks.finishTask(id, body);
  }

  @Get('tasks')
  list(@Query('limit') limit?: string) {
    return this.tasks.listTasks(limit ? Number(limit) : 50);
  }

  @Get('tasks/:id/debug')
  debug(@Param('id', ParseIntPipe) id: number) {
    return this.tasks.getDebugReport(id);
  }

  // mid-run clarification loop: the running agent posts a question, the panel
  // prompts the user, the answer flows back before the run proceeds
  @Post('tasks/:id/ask')
  ask(@Param('id', ParseIntPipe) id: number, @Body() body: { step: number; question: string }) {
    if (!body?.question?.trim()) throw new Error('question is required');
    return this.tasks.ask(id, body.step ?? 0, body.question.trim());
  }

  @Get('asks/pending')
  pendingAsk() {
    return this.tasks.pendingQuestion();
  }

  @Post('asks/:id/answer')
  answerAsk(@Param('id', ParseIntPipe) id: number, @Body() body: { answer: string }) {
    if (!body?.answer?.trim()) throw new Error('answer is required');
    return this.tasks.answer(id, body.answer.trim());
  }

  @Get('asks/:id')
  getAsk(@Param('id', ParseIntPipe) id: number) {
    return this.tasks.getAnswer(id);
  }

  @Get('tasks/:id/messages')
  messages(@Param('id', ParseIntPipe) id: number) {
    return { messages: this.tasks.listMessages(id) };
  }
}
