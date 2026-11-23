export function rawRows(res: unknown): any[] {
  if (Array.isArray(res) && Array.isArray(res[0]) && typeof res[1] === 'number') return res[0] as any[];
  return Array.isArray(res) ? (res as any[]) : [];
}

export function rawCount(res: unknown): number {
  if (Array.isArray(res) && typeof res[1] === 'number') return res[1];
  return (res as { rowCount?: number })?.rowCount ?? 0;
}
