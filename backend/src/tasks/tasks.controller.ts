import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { TaskEventDto } from './dto/task-event.dto';
import { FinishTaskDto } from './dto/finish-task.dto';
import { AskQuestionDto } from './dto/ask-question.dto';
import { AnswerQuestionDto } from './dto/answer-question.dto';

@Controller()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post('tasks')
  create(@Body() body: CreateTaskDto) {
    return this.tasks.createTask(body);
  }

  @Post('tasks/:id/events')
  async addEvent(@Param('id', ParseIntPipe) id: number, @Body() body: TaskEventDto) {
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

  @Post('tasks/:id/ask')
  ask(@Param('id', ParseIntPipe) id: number, @Body() body: AskQuestionDto) {
    if (!body?.question?.trim()) throw new Error('question is required');
    return this.tasks.ask(id, body.step ?? 0, body.question.trim());
  }

  @Get('asks/pending')
  pendingAsk() {
    return this.tasks.pendingQuestion();
  }

  @Post('asks/:id/answer')
  answerAsk(@Param('id', ParseIntPipe) id: number, @Body() body: AnswerQuestionDto) {
    if (!body?.answer?.trim()) throw new Error('answer is required');
    return this.tasks.answer(id, body.answer.trim());
  }

  @Get('asks/:id')
  getAsk(@Param('id', ParseIntPipe) id: number) {
    return this.tasks.getAnswer(id);
  }

  @Get('tasks/:id/messages')
  async messages(@Param("id", ParseIntPipe) id: number) {
    return { messages: await this.tasks.listMessages(id) };
  }
}
