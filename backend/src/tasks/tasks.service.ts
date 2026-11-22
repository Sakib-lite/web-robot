import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { buildDebugReport, type TaskTrace } from './tasks.debug.report';
import { Action } from './entities/action.entity';
import { LlmCall } from './entities/llm-call.entity';
import { Observation } from './entities/observation.entity';
import { Task } from './entities/task.entity';
import { TaskMessage } from './entities/task-message.entity';
import { UserAnswer } from './entities/user-answer.entity';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task) private readonly tasks: Repository<Task>,
    @InjectRepository(Observation) private readonly observations: Repository<Observation>,
    @InjectRepository(LlmCall) private readonly llmCalls: Repository<LlmCall>,
    @InjectRepository(Action) private readonly actions: Repository<Action>,
    @InjectRepository(UserAnswer) private readonly userAnswers: Repository<UserAnswer>,
    @InjectRepository(TaskMessage) private readonly messages: Repository<TaskMessage>,
  ) {}

  async createTask(input: { taskText: string; product?: string; model?: string; effort?: string; steps?: string[] }) {
    const steps = input.steps?.map((s) => s.trim()).filter(Boolean) ?? [];
    const task = await this.tasks.save({
      taskText: input.taskText,
      product: input.product ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      steps: steps.length ? steps : null,
    });
    await this.messages.save({ taskId: task.id, role: 'user', content: input.taskText });
    return { id: task.id };
  }

  async addObservation(taskId: number, step: number, data: { url?: string; title?: string; pageText?: string; elements?: unknown; tabs?: unknown }) {
    await this.observations.save({
      taskId,
      step,
      url: data.url ?? null,
      title: data.title ?? null,
      pageText: data.pageText ?? null,
      elements: data.elements ?? null,
      tabs: data.tabs ?? null,
    });
  }

  async addLlmCall(taskId: number, step: number, data: { messages: unknown; responseContent?: string; thinking?: string; toolCalls?: unknown; usage?: unknown; durationMs?: number; error?: string }) {
    await this.llmCalls.save({
      taskId,
      step,
      messages: data.messages,
      responseContent: data.responseContent ?? null,
      thinking: data.thinking ?? null,
      toolCalls: data.toolCalls ?? null,
      usage: data.usage ?? null,
      durationMs: data.durationMs ?? null,
      error: data.error ?? null,
    });
  }

  async addAction(taskId: number, step: number, data: { tool: string; args?: unknown; ok: boolean; detail?: string; durationMs?: number }) {
    await this.actions.save({
      taskId,
      step,
      tool: data.tool,
      args: data.args ?? null,
      ok: data.ok,
      detail: data.detail ?? null,
      durationMs: data.durationMs ?? null,
    });
  }

  async addUserAnswer(taskId: number, step: number, data: { question: string; answer?: string }) {
    await this.userAnswers.save({ taskId, step, question: data.question, answer: data.answer ?? null });
  }

  async finishTask(taskId: number, data: { status: string; summary?: string; reason?: string; stepCount: number }) {
    const result = await this.tasks.update({ id: taskId }, {
      status: data.status,
      summary: data.summary ?? null,
      reason: data.reason ?? null,
      stepCount: data.stepCount,
      finishedAt: () => 'now()',
    });
    if ((result.affected ?? 0) === 0) throw new NotFoundException(`task ${taskId} not found`);
    const reply = data.summary?.trim() || data.reason?.trim();
    if (reply) {
      await this.messages.save({ taskId, role: 'agent', content: reply });
    }
  }

  async listTasks(limit = 50) {
    const rows = await this.tasks.find({ order: { createdAt: 'DESC' }, take: limit });
    return rows.map((row) => ({
      id: row.id,
      taskText: row.taskText,
      status: row.status,
      summary: row.summary,
      reason: row.reason,
      product: row.product,
      model: row.model,
      effort: row.effort,
      stepCount: row.stepCount,
      steps: row.steps ?? [],
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    }));
  }

  async liveTrace(taskId: number, limit = 8) {
    const task = await this.tasks.findOneBy({ id: taskId });
    if (!task) throw new NotFoundException(`task ${taskId} not found`);
    const rows = await this.llmCalls.find({ where: { taskId }, order: { id: 'DESC' }, take: limit });
    const calls = rows.reverse().map((row) => ({
      step: row.step,
      thinking: row.thinking ?? null,
      content: row.responseContent ?? '',
      tool: Array.isArray(row.toolCalls) && row.toolCalls.length ? (row.toolCalls as Array<{ name?: string }>)[0]?.name ?? null : null,
      error: row.error ?? null,
      createdAt: row.createdAt,
    }));
    const actionRows = await this.actions.find({ where: { taskId }, order: { id: 'DESC' }, take: 40 });
    const actions = actionRows
      .reverse()
      .map((row) => ({ step: row.step, tool: row.tool, detail: row.detail ?? '', ok: row.ok, durationMs: row.durationMs ?? null }));
    return { id: taskId, status: task.status, stepCount: task.stepCount, calls, actions };
  }

  async getDebugReport(taskId: number) {
    const task = await this.tasks.findOneBy({ id: taskId });
    if (!task) throw new NotFoundException(`task ${taskId} not found`);
    const trace: TaskTrace = {
      task,
      observations: await this.observations.find({ where: { taskId }, order: { step: 'ASC', createdAt: 'ASC' } }),
      llmCalls: await this.llmCalls.find({ where: { taskId }, order: { step: 'ASC', createdAt: 'ASC' } }),
      actions: await this.actions.find({ where: { taskId }, order: { step: 'ASC', createdAt: 'ASC' } }),
      userAnswers: await this.userAnswers.find({ where: { taskId }, order: { step: 'ASC', createdAt: 'ASC' } }),
    };
    return buildDebugReport(trace);
  }

  async ask(taskId: number, step: number, question: string): Promise<{ id: number }> {
    const task = await this.tasks.findOneBy({ id: taskId });
    if (!task) throw new NotFoundException(`task ${taskId} not found`);
    const saved = await this.userAnswers.save({ taskId, step, question });
    return { id: Number(saved.id) };
  }

  async pendingQuestion(): Promise<{ id: number; taskId: number; step: number; question: string; waitedMs: number } | null> {
    const row = await this.userAnswers
      .createQueryBuilder('ua')
      .innerJoin(Task, 't', 't.id = ua.task_id')
      .where('ua.answer IS NULL AND t.status = :running', { running: 'running' })
      .orderBy('ua.id', 'ASC')
      .addSelect('EXTRACT(EPOCH FROM (now() - ua.created_at)) * 1000', 'waited_ms')
      .getRawOne();
    if (!row) return null;
    return { id: Number(row.ua_id), taskId: Number(row.ua_task_id), step: Number(row.ua_step), question: row.ua_question, waitedMs: Number(row.waited_ms) };
  }

  async answer(answerId: number, answer: string): Promise<{ answered: boolean }> {
    const result = await this.userAnswers.createQueryBuilder()
      .update()
      .set({ answer })
      .where('id = :id AND answer IS NULL', { id: answerId })
      .execute();
    return { answered: (result.affected ?? 0) > 0 };
  }

  async getAnswer(answerId: number): Promise<{ answer: string | null }> {
    const row = await this.userAnswers.createQueryBuilder('ua')
      .where('ua.id = :id', { id: answerId })
      .getRawOne();
    return { answer: row?.ua_answer ?? null };
  }

  async listMessages(taskId: number): Promise<Array<{ id: number; role: string; content: string; createdAt: Date }>> {
    const task = await this.tasks.findOneBy({ id: taskId });
    if (!task) throw new NotFoundException(`task ${taskId} not found`);
    const rows = await this.messages.find({ where: { taskId }, order: { id: 'ASC' } });
    return rows.map((r) => ({ id: Number(r.id), role: r.role, content: r.content, createdAt: r.createdAt }));
  }
}
