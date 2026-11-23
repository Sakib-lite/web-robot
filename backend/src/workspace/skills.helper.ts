export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const kv = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  return { meta, body: match[2] ?? '' };
}
