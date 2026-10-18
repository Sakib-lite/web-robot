import { describe, expect, it } from 'vitest';
import { resumeNoteFor } from './claim';

describe('resumeNoteFor', () => {
  it('points a retry at prior deliverables so it continues instead of redoing', () => {
    const note = resumeNoteFor(92, [
      { name: 'scratch', dir: true },
      { name: 'PLAN.md', dir: false },
      { name: 'phd_unis.md', dir: false },
    ]);
    expect(note).toContain('.web-robot/tasks/92/');
    expect(note).toContain('phd_unis.md');
    expect(note).toContain('never rewrite or redo');
  });

  it('stays silent for a fresh task folder (only scratch/PLAN)', () => {
    expect(resumeNoteFor(93, [{ name: 'PLAN.md', dir: false }, { name: 'scratch', dir: true }])).toBeNull();
    expect(resumeNoteFor(94, [])).toBeNull();
  });
});
