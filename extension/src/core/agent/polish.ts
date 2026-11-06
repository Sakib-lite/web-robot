import { chatCompletion } from '../llm/chatClient';
import type { LlmProvider } from '../llm/providers';

export interface PolishedPrompt {
  analysis: string[];
  prompt: string;
}

export function polishSystemPrompt(): string {
  return [
    'You rewrite rough task ideas into polished prompts for web-robot, an autonomous agent working in the user\'s real Chrome (with their logins) plus a local workspace.',
    'Its tools: browser (goto, new_tab, click, fill, select, press, scroll, wait, extract to read page text, snapshot to re-observe - skip=N pages through long element lists, note as working memory), local workspace (read_file/write_file/edit_file/append_file/exec with python3; all files land in one task folder), sub_agent (a one-item read-only research sub-agent with a fresh context: give it exactly one self-contained item and it returns verified facts with quoted lines and source urls), ask_user (only when truly blocked). It cannot install browsers or automation tools - no selenium, no playwright, no downloads.',
    'Polishing rules:',
    '1. Match the task shape: many similar items (a list, each/all/N, per-X research) becomes a sub_agent fan-out - "use sub_agent once per item", each item self-contained (name/url included in the item), parent appends each digest to the deliverable. Data available from an API or JSON endpoint becomes script-first - "write one python script with exec that fetches ..., verify its output, write it to <file>" (faster and more reliable than clicking). A single-page or few-page collection stays direct browsing - extract after each page, snapshot skip to page through long lists.',
    '2. Make the deliverable explicit: exact file name, one line per item in a stated format, append each verified batch instead of rewriting.',
    '3. Add verification: read_file the deliverable before done; report total covered vs total expected; blocked or not-found items are noted in the file, never silently dropped.',
    '4. Facts must come from pages observed during the run, each with a source url - never from model memory.',
    '5. When the task implies all/each, tell the agent to establish the total first (list length or page count) and cover all of it.',
    '6. Keep the polished prompt terse - under 120 words, plain imperative sentences, no markdown headings, no tool explanations beyond the shape guidance.',
    '7. If the input is missing something critical (a url, the list source, credentials), pick the most reasonable assumption, use it, and name it in the analysis instead of asking.',
    'Answer in exactly this format and nothing else:',
    'ANALYSIS:',
    '- <max 4 short lines: task shape, key decisions, assumptions made>',
    'PROMPT:',
    '<the polished prompt>',
  ].join('\n');
}

export function parsePolish(content: string): PolishedPrompt {
  const text = content.trim();
  const promptAt = text.toUpperCase().lastIndexOf('PROMPT:');
  if (promptAt === -1) return { analysis: [], prompt: stripFence(text) };
  const head = text.slice(0, promptAt);
  const analysis = head
    .replace(/^.*?ANALYSIS:/is, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => line.replace(/^-\s*/, ''))
    .filter(Boolean);
  return { analysis, prompt: stripFence(text.slice(promptAt + 'PROMPT:'.length).trim()) };
}

function stripFence(text: string): string {
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text.trim());
  return (fenced ? fenced[1]! : text.trim()).trim();
}

export async function polishPrompt(input: string, provider: LlmProvider, fetchFn: typeof fetch = fetch): Promise<PolishedPrompt> {
  const res = await chatCompletion(provider, {
    messages: [
      { role: 'system', content: polishSystemPrompt() },
      { role: 'user', content: input.trim() },
    ],
    maxTokens: 2048,
  }, fetchFn);
  if (!res.content.trim()) throw new Error('polish reply was empty - try again or switch model');
  return parsePolish(res.content);
}
