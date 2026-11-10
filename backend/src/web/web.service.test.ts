import { describe, expect, it, vi } from 'vitest';
import { WebService } from './web.service';

interface MockRes {
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

function htmlResponse(html: string, url = 'https://x.dev/page', contentType = 'text/html'): MockRes {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => html,
  };
}

describe('WebService.fetchUrl', () => {
  it('extracts readable main text with title and strips scripts and chrome', async () => {
    const html = `<html><head><title>Group Page</title><script>var x = "secret";</script></head>
      <body><nav>Home About Contact</nav>
      <main><h1>Research</h1><p>We study distributed systems and quantization of large models for training and inference, including low-precision methods, sparsification and compression scaling laws, and space-efficient optimizers for very large neural networks across clusters.</p></main>
      <footer>copyright</footer></body></html>`;
    const service = new WebService();
    globalThis.fetch = vi.fn(async () => htmlResponse(html)) as unknown as typeof fetch;
    const page = await service.fetchUrl('https://x.dev/page');
    expect(page.title).toBe('Group Page');
    expect(page.text).toContain('distributed systems and quantization');
    expect(page.text).not.toContain('secret');
    expect(page.text).not.toContain('copyright');
    expect(page.truncated).toBe(false);
  });

  it('rejects non-http schemes and non-text content types', async () => {
    const service = new WebService();
    await expect(service.fetchUrl('ftp://x.dev')).rejects.toMatchObject({ code: 'INVALID' });
    globalThis.fetch = vi.fn(async () => htmlResponse('binary', 'https://x.dev/x', 'application/pdf')) as unknown as typeof fetch;
    await expect(service.fetchUrl('https://x.dev/x')).rejects.toMatchObject({ code: 'NOT_TEXT' });
  });

  it('marks long pages as truncated', async () => {
    const html = `<html><body><main>${'<p>word </p>'.repeat(3000)}</main></body></html>`;
    const service = new WebService();
    globalThis.fetch = vi.fn(async () => htmlResponse(html, 'https://x.dev/big')) as unknown as typeof fetch;
    const page = await service.fetchUrl('https://x.dev/big');
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThanOrEqual(6000);
  });
});

describe('WebService.search', () => {
  it('parses duckduckgo results and decodes redirect urls', async () => {
    const html = `<html><body>
      <div class="result results_links"><h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fista.ac.at%2Fgroup%2F&amp;rut=abc">DASLab Group</a></h2>
      <a class="result__snippet">Efficient ML and systems <b>research</b>.</a></div>
      <div class="result results_links"><h2 class="result__title">
      <a class="result__a" href="https://example.com/second">Second Hit</a></h2>
      <a class="result__snippet">Another snippet</a></div>
      </body></html>`;
    const service = new WebService();
    globalThis.fetch = vi.fn(async () => htmlResponse(html)) as unknown as typeof fetch;
    const { results } = await service.search('ista daslab');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'DASLab Group', url: 'https://ista.ac.at/group/', snippet: 'Efficient ML and systems research.' });
    expect(results[1]!.url).toBe('https://example.com/second');
  });

  it('returns an empty list instead of failing when nothing matches', async () => {
    const service = new WebService();
    globalThis.fetch = vi.fn(async () => htmlResponse('<html><body>no results here</body></html>')) as unknown as typeof fetch;
    const { results } = await service.search('zzz nothing');
    expect(results).toEqual([]);
  });
});
