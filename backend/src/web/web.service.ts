import { Injectable } from '@nestjs/common';

export class WebError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID' | 'FETCH_FAILED' | 'NOT_TEXT' | 'SEARCH_FAILED',
  ) {
    super(message);
  }
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;
const SEARCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 6000;
const MIN_SEARCH_INTERVAL_MS = 1100;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function cutBlocks(html: string): string {
  return html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
}

function pickMain(html: string): string {
  for (const tag of ['main', 'article']) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
    const inner = match?.[1] ?? '';
    if (stripTags(inner).length > 200) return inner;
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  return body;
}

function titleOf(html: string): string {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  return stripTags(raw).slice(0, 200);
}

function decodeDdgUrl(href: string): string {
  const encoded = /[?&]uddg=([^&]+)/.exec(href)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return href;
    }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

@Injectable()
export class WebService {
  private lastSearchAt = 0;

  async fetchUrl(rawUrl: string): Promise<FetchedPage> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new WebError(`not a valid url: ${rawUrl}`, 'INVALID');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new WebError(`only http(s) urls can be fetched: ${rawUrl}`, 'INVALID');
    }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new WebError(`fetch failed: ${error instanceof Error ? error.message : String(error)}`, 'FETCH_FAILED');
    }
    if (!res.ok) throw new WebError(`HTTP ${res.status} for ${rawUrl}`, 'FETCH_FAILED');
    const contentType = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      throw new WebError(`not a text page (content-type ${contentType || 'unknown'})`, 'NOT_TEXT');
    }
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    const text = stripTags(cutBlocks(pickMain(cutBlocks(html))));
    return {
      url: res.url || url.href,
      title: titleOf(html),
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS,
    };
  }

  async search(rawQuery: string, limit = 8): Promise<{ results: SearchHit[] }> {
    const query = rawQuery.trim();
    if (!query) throw new WebError('query must not be empty', 'INVALID');
    const wait = this.lastSearchAt + MIN_SEARCH_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastSearchAt = Date.now();
    let html: string;
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = (await res.text()).slice(0, MAX_HTML_BYTES);
    } catch (error) {
      throw new WebError(`search failed: ${error instanceof Error ? error.message : String(error)}`, 'SEARCH_FAILED');
    }
    const results: SearchHit[] = [];
    for (const block of html.split(/<div[^>]+class="[^"]*result(?:s_links)?\b/).slice(1)) {
      const anchor = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
      if (!anchor) continue;
      const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '';
      const hit: SearchHit = {
        title: stripTags(anchor[2] ?? '').slice(0, 200),
        url: decodeDdgUrl(anchor[1] ?? ''),
        snippet: stripTags(snippet).slice(0, 300),
      };
      if (!hit.url.startsWith('http') || hit.url.includes('duckduckgo.com/y.js')) continue;
      results.push(hit);
      if (results.length >= limit) break;
    }
    return { results };
  }
}
