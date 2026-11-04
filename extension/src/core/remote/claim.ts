import { createDriver } from '../driver/extensionDriver';
import { createHttpPlane } from '../local/httpPlane';
import { getProduct, catalogModels } from '../llm/products';
import { resolveActiveProvider, createProductStore } from '../llm/providers';
import type { ClaimedTask } from '../common/types';
import { chromeArea } from '../storage/area';
import { runRemoteTask } from '../telemetry/client';

export async function runClaimedTask(
  claim: ClaimedTask,
  backendUrl: string,
  makeDriver: () => ReturnType<typeof createDriver>,
): Promise<void> {
  const { taskId, taskText, skill, context, steps, lastMessage } = claim;
  const taskEffort = claim.effort;
  const store = createProductStore(chromeArea());
  const active = await resolveActiveProvider(store, undefined, { url: backendUrl });
  const product = active ? getProduct(active.productId) : undefined;
  const saved = active?.model ? [active.model] : [];
  const knownModels = product ? catalogModels(product, [...saved, await store.customModelsFor(product.id)]) : [];
  const taskModel = claim.model && active && knownModels.includes(claim.model) ? claim.model : undefined;
  if (!active) {
    await fetch(`${backendUrl}/tasks/${taskId}/finish`, { signal: AbortSignal.timeout(4000),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'failed', reason: 'no llm provider configured', stepCount: 0 }),
    }).catch(() => undefined);
    return;
  }
  let provider = active;
  if (taskModel) provider = { ...provider, model: taskModel };
  if (taskEffort) provider = { ...provider, thinking: taskEffort as 'off' | 'low' | 'high' | 'max' };
  let preamble: string | undefined;
  let maxSteps: number | undefined;
  if (lastMessage && lastMessage !== taskText) {
    try {
      const res = await fetch(`${backendUrl}/tasks/${taskId}/messages`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const body = (await res.json()) as { messages?: Array<{ role: string; content: string }> };
        const lines = (body.messages ?? [])
          .filter((m) => m.content !== lastMessage)
          .map((m) => `[${m.role}] ${m.content.slice(0, 700)}`);
        const digest = lines.slice(-14).join('\n\n');
        preamble = [
          `CONTINUATION of task #${taskId} - it ran before and has prior results (its files live in your task folder; read them instead of redoing work). The full conversation so far:`,
          digest || '(no prior messages)',
          `NOW DO THIS (the user's latest message): "${lastMessage}"`,
        ].join('\n\n').slice(0, 9000);
      }
    } catch {
      preamble = `CONTINUATION of task #${taskId} (prior files live in your task folder). NOW DO THIS: "${lastMessage}"`;
    }
  }
  if (skill) {
    try {
      const res = await fetch(`${backendUrl}/skills/${encodeURIComponent(skill)}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const full = (await res.json()) as { name?: string; body?: string; defaults?: Record<string, string> };
        if (full.defaults?.model && !taskModel) provider = { ...provider, model: full.defaults.model };
        if (full.defaults?.effort && !taskEffort) provider = { ...provider, thinking: full.defaults.effort as 'off' | 'low' | 'high' | 'max' };
        if (full.defaults?.maxSteps) maxSteps = Number(full.defaults.maxSteps);
        if (full.body) preamble = `SKILL "${full.name ?? skill}" - follow this workflow for the whole task:\n\n${full.body}`.slice(0, 8000);
      }
    } catch {
    }
  }
  if (context) {
    try {
      const res = await fetch(`${backendUrl}/contexts/${encodeURIComponent(context)}`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const full = (await res.json()) as { name?: string; body?: string };
        if (full.body) {
          const contextPreamble = `USER CONTEXT "${full.name ?? context}" - this task is about the user described below; apply these facts when searching, filtering, and writing:\n\n${full.body}`.slice(0, 8000);
          preamble = preamble ? `${preamble}\n\n---\n\n${contextPreamble}` : contextPreamble;
        }
      }
    } catch {
    }
  }
  const plane = createHttpPlane(async () => backendUrl);
  const info = await plane.describe().catch(() => null);
  const resume = await buildResumePreamble(taskId, plane);
  if (resume) preamble = preamble ? `${preamble}\n\n${resume}` : resume;
  await runRemoteTask(taskId, taskText, backendUrl, {
    provider,
    makeDriver,
    ...(maxSteps ? { maxSteps } : {}),
    ...(preamble ? { preamble } : {}),
    ...(steps?.length ? { steps } : {}),
    ...(info?.enabled ? { workspace: { plane, root: info.root } } : {}),
  });
}

export function resumeNoteFor(taskId: number, entries: Array<{ name: string; dir: boolean }>): string | null {
  const progress = entries.filter((e) => !e.dir && !['PLAN.md'].includes(e.name));
  if (progress.length === 0) return null;
  return `RESUME: a previous attempt of this task left ${progress.length} file(s) in .web-robot/tasks/${taskId}/ (${progress.map((e) => e.name).join(', ')}). read_file them FIRST, continue exactly where they end (append_file, never rewrite or redo collected rows), then proceed with the remaining work.`;
}

async function buildResumePreamble(taskId: number, plane: import('../local/plane').LocalPlane): Promise<string | null> {
  try {
    const listing = await plane.list(`.web-robot/tasks/${taskId}`);
    return resumeNoteFor(taskId, listing.entries ?? []);
  } catch {
    return null;
  }
}
