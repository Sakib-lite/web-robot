import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from './db.service';
import { buildDebugReport, type TaskTrace } from './debug.report';

@Injectable()
export class TasksService {
  constructor(private readonly db: DbService) {}

  async createTask(input: { taskText: string; product?: string; model?: string; effort?: string }) {
    const res = await this.db.pool.query(
      `INSERT INTO tasks (task_text, product, model, effort) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [input.taskText, input.product ?? null, input.model ?? null, input.effort ?? null],
    );
    return { id: res.rows[0].id as string };
  }

  async addObservation(taskId: string, step: number, data: { url?: string; title?: string; pageText?: string; elements?: unknown; tabs?: unknown }) {
    await this.db.pool.query(
      `INSERT INTO observations (task_id, step, url, title, page_text, elements, tabs) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [taskId, step, data.url ?? null, data.title ?? null, data.pageText ?? null, JSON.stringify(data.elements ?? null), JSON.stringify(data.tabs ?? null)],
    );
  }

  async addLlmCall(taskId: string, step: number, data: { messages: unknown; responseContent?: string; toolCalls?: unknown; usage?: unknown; durationMs?: number; error?: string }) {
    await this.db.pool.query(
      `INSERT INTO llm_calls (task_id, step, messages, response_content, tool_calls, usage, duration_ms, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [taskId, step, JSON.stringify(data.messages), data.responseContent ?? null, JSON.stringify(data.toolCalls ?? null), JSON.stringify(data.usage ?? null), data.durationMs ?? null, data.error ?? null],
    );
  }

  async addAction(taskId: string, step: number, data: { tool: string; args?: unknown; ok: boolean; detail?: string; durationMs?: number }) {
    await this.db.pool.query(
      `INSERT INTO actions (task_id, step, tool, args, ok, detail, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [taskId, step, data.tool, JSON.stringify(data.args ?? null), data.ok, data.detail ?? null, data.durationMs ?? null],
    );
  }

  async addUserAnswer(taskId: string, step: number, data: { question: string; answer?: string }) {
    await this.db.pool.query(
      `INSERT INTO user_answers (task_id, step, question, answer) VALUES ($1, $2, $3, $4)`,
      [taskId, step, data.question, data.answer ?? null],
    );
  }

  async finishTask(taskId: string, data: { status: string; summary?: string; reason?: string; stepCount: number }) {
    const res = await this.db.pool.query(
      `UPDATE tasks SET status = $2, summary = $3, reason = $4, step_count = $5, finished_at = now() WHERE id = $1`,
      [taskId, data.status, data.summary ?? null, data.reason ?? null, data.stepCount],
    );
    if (res.rowCount === 0) throw new NotFoundException(`task ${taskId} not found`);
  }

  async listTasks(limit = 50) {
    const res = await this.db.pool.query(
      `SELECT id, task_text, status, summary, reason, product, model, effort, step_count, created_at, finished_at FROM tasks ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows.map((row) => ({
      id: row.id,
      taskText: row.task_text,
      status: row.status,
      summary: row.summary,
      reason: row.reason,
      product: row.product,
      model: row.model,
      effort: row.effort,
      stepCount: row.step_count,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    }));
  }

  async getDebugReport(taskId: string) {
    const [taskRes, obsRes, llmRes, actRes, ansRes] = await Promise.all([
      this.db.pool.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]),
      this.db.pool.query(`SELECT * FROM observations WHERE task_id = $1 ORDER BY step, created_at`, [taskId]),
      this.db.pool.query(`SELECT * FROM llm_calls WHERE task_id = $1 ORDER BY step, created_at`, [taskId]),
      this.db.pool.query(`SELECT * FROM actions WHERE task_id = $1 ORDER BY step, created_at`, [taskId]),
      this.db.pool.query(`SELECT * FROM user_answers WHERE task_id = $1 ORDER BY step, created_at`, [taskId]),
    ]);
    if (taskRes.rowCount === 0) throw new NotFoundException(`task ${taskId} not found`);

    const trace: TaskTrace = {
      task: taskRes.rows[0],
      observations: obsRes.rows,
      llmCalls: llmRes.rows,
      actions: actRes.rows,
      userAnswers: ansRes.rows,
    };
    return buildDebugReport(trace);
  }
}
