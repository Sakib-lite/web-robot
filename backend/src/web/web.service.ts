import { Injectable } from '@nestjs/common';

import { WebError, type FetchedPage, type SearchHit } from './web.types';
import { UA, FETCH_TIMEOUT_MS, SEARCH_TIMEOUT_MS, MAX_HTML_BYTES, MAX_TEXT_CHARS, MIN_SEARCH_INTERVAL_MS } from './web.constants';
import { cutBlocks, decodeDdgUrl, pickMain, stripTags, titleOf } from './html.helper';

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
