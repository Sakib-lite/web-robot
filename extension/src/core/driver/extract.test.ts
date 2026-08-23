// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractForGoal, mainContentText } from './pageActions';

function withPage(html: string) {
  document.body.innerHTML = html;
}

const FSU_LIKE_PAGE = `
  <main>
    <h1>Minimum Admissions Requirements</h1>
    <h2>Academic Requirements</h2>
    <p>An undergraduate GPA of 3.0 or better is required for admission consideration.</p>
    <h2>English Proficiency Scores for admission consideration</h2>
    <p>Applicants must score at least 550 on the paper-based TOEFL or 80 on the internet-based TOEFL.</p>
    <p>The university also accepts an IELTS score of 6.5 overall.</p>
    <p>Pearson Test of English (PTE Academic) with a minimum score of 55 is accepted.</p>
    <p>Applicants may also submit a Duolingo English Test score of 120.</p>
    <h2>Application Deadlines</h2>
    <p>Applications open in October for fall admission.</p>
  </main>
`;

describe('extractForGoal', () => {
  it('returns the lines around goal keyword matches', () => {
    withPage(FSU_LIKE_PAGE);
    const result = extractForGoal(document, 'What is the PTE Academic minimum score for admission?');
    expect(result).toContain('MATCHING TEXT');
    expect(result).toContain('Pearson Test of English (PTE Academic) with a minimum score of 55');
    // context lines around the match are included
    expect(result).toContain('IELTS score of 6.5');
  });

  it('includes a page outline so the model can navigate sections', () => {
    withPage(FSU_LIKE_PAGE);
    const result = extractForGoal(document, 'PTE minimum');
    expect(result).toContain('PAGE OUTLINE');
    expect(result).toContain('English Proficiency Scores');
    expect(result).toContain('Application Deadlines');
  });

  it('reports a miss with the outline instead of silent emptiness', () => {
    withPage(FSU_LIKE_PAGE);
    const result = extractForGoal(document, 'What chess programs are offered?');
    expect(result).toContain('NO TEXT MATCHES YOUR GOAL');
    expect(result).toContain('PAGE OUTLINE');
    expect(result).toContain('Minimum Admissions Requirements');
  });

  it('prefers main content over body noise', () => {
    withPage(`
      <header>SIGN UP LOGIN MENU MENU MENU</header>
      <main><p>The PTE Academic minimum is 55.</p></main>
    `);
    const result = extractForGoal(document, 'pte');
    expect(result).not.toContain('MENU MENU');
    expect(result).toContain('PTE Academic minimum is 55');
  });

  it('mainContentText still returns plain main text', () => {
    withPage(`<header>noise</header><main><p>clean text here</p></main>`);
    expect(mainContentText(document)).toBe('clean text here');
  });
});
