import * as fs from 'node:fs/promises';
import { EXEC_OUTPUT_CAP } from './workspace.constants';

export function capOutput(output: string, totalSeen: number): string {
  if (totalSeen <= EXEC_OUTPUT_CAP) return output;
  const head = output.slice(0, EXEC_OUTPUT_CAP / 2);
  const tail = output.slice(-(EXEC_OUTPUT_CAP / 2));
  return `${head}\n… ${totalSeen - EXEC_OUTPUT_CAP} chars elided …\n${tail}`;
}

export async function fileEndsWithoutNewline(target: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(target, 'r');
    const stat = await fh.stat();
    if (stat.size === 0) return false;
    const buffer = Buffer.alloc(1);
    await fh.read(buffer, 0, 1, stat.size - 1);
    return buffer.toString('utf8') !== '\n';
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}
