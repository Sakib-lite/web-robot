import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { buildDebugReport, type TaskTrace } from './tasks.debug.report';

@Injectable()
export class TasksService {
  constructor(private readonly db: DbService) {}

  async createTask(input: { taskText: string; product?: string; model?: string; effort?: string }) {
    const res = await this.db.pool.query(
      `INSERT INTO tasks (task_text, product, model, effort) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [input.taskText, input.product ?? null, input.model ?? null, input.effort ?? null],
    );
    return { id: res.rows[0].id as number };
  }

  async addObservation(taskId: number, step: number, data: { url?: string; title?: string; pageText?: string; elements?: unknown; tabs?: unknown }) {
    await this.db.pool.query(
      `INSERT INTO observations (task_id, step, url, title, page_text, elements, tabs) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [taskId, step, data.url ?? null, data.title ?? null, data.pageText ?? null, JSON.stringify(data.elements ?? null), JSON.stringify(data.tabs ?? null)],
    );
  }

  async addLlmCall(taskId: number, step: number, data: { messages: unknown; responseContent?: string; toolCalls?: unknown; usage?: unknown; durationMs?: number; error?: string }) {
    await this.db.pool.query(
      `INSERT INTO llm_calls (task_id, step, messages, response_content, tool_calls, usage, duration_ms, error) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [taskId, step, JSON.stringify(data.messages), data.responseContent ?? null, JSON.stringify(data.toolCalls ?? null), JSON.stringify(data.usage ?? null), data.durationMs ?? null, data.error ?? null],
    );
  }

  async addAction(taskId: number, step: number, data: { tool: string; args?: unknown; ok: boolean; detail?: string; durationMs?: number }) {
    await this.db.pool.query(
      `INSERT INTO actions (task_id, step, tool, args, ok, detail, duration_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [taskId, step, data.tool, JSON.stringify(data.args ?? null), data.ok, data.detail ?? null, data.durationMs ?? null],
    );
  }

  async addUserAnswer(taskId: number, step: number, data: { question: string; answer?: string }) {
    await this.db.pool.query(
      `INSERT INTO user_answers (task_id, step, question, answer) VALUES ($1, $2, $3, $4)`,
      [taskId, step, data.question, data.answer ?? null],
    );
  }

  async finishTask(taskId: number, data: { status: string; summary?: string; reason?: string; stepCount: number }) {
    const res = await this.db.pool.query(
      `UPDATE tasks SET status = $2, summary = $3, reason = $4, step_count = $5, finished_at = now() WHERE id = $1`,
      [taskId, data.status, data.summary ?? null, data.reason ?? null, data.stepCount],
    );
    if (res.rowCount === 0) throw new NotFoundException(`task ${taskId} not found`);

    const reply = data.summary?.trim() || data.reason?.trim();
    if (reply) {
      await this.db.pool.query(`INSERT INTO task_messages (task_id, role, content) VALUES ($1, 'agent', $2)`, [taskId, reply]);
    }
  }

  async ask(taskId: number, step: number, question: string): Promise<{ id: number }> {
    const task = await this.db.pool.query(`SELECT id FROM tasks WHERE id = $1`, [taskId]);
    if (task.rowCount === 0) throw new NotFoundException(`task ${taskId} not found`);
    const res = await this.db.pool.query(
      `INSERT INTO user_answers (task_id, step, question) VALUES ($1, $2, $3) RETURNING id`,
      [taskId, step, question],
    );
    return { id: res.rows[0].id as number };
  }

  async pendingQuestion(): Promise<{ id: number; taskId: number; step: number; question: string; waitedMs: number } | null> {
    const res = await this.db.pool.query(
      `SELECT ua.id, ua.task_id, ua.step, ua.question, EXTRACT(EPOCH FROM (now() - ua.created_at)) * 1000 AS waited_ms
       FROM user_answers ua JOIN tasks t ON t.id = ua.task_id
       WHERE ua.answer IS NULL AND t.status = 'running'
       ORDER BY ua.id LIMIT 1`,
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return { id: row.id, taskId: row.task_id, step: row.step, question: row.question, waitedMs: Number(row.waited_ms) };
  }

  async answer(answerId: number, answer: string): Promise<{ answered: boolean }> {
    const res = await this.db.pool.query(
      `UPDATE user_answers SET answer = $2 WHERE id = $1 AND answer IS NULL`,
      [answerId, answer],
    );
    return { answered: (res.rowCount ?? 0) > 0 };
  }

  async getAnswer(answerId: number): Promise<{ answer: string | null }> {
    const res = await this.db.pool.query(`SELECT answer FROM user_answers WHERE id = $1`, [answerId]);
    if (res.rowCount === 0) return { answer: null };
    return { answer: res.rows[0].answer ?? null };
  }

  async listMessages(taskId: number): Promise<Array<{ id: number; role: string; content: string; createdAt: Date }>> {
    const task = await this.db.pool.query(`SELECT id FROM tasks WHERE id = $1`, [taskId]);
    if (task.rowCount === 0) throw new NotFoundException(`task ${taskId} not found`);
    const res = await this.db.pool.query(
      `SELECT id, role, content, created_at FROM task_messages WHERE task_id = $1 ORDER BY id`,
      [taskId],
    );
    return res.rows.map((r) => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at }));
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

  async getDebugReport(taskId: number) {
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
