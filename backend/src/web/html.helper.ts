export function stripTags(html: string): string {
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

export function cutBlocks(html: string): string {
  return html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
}

export function pickMain(html: string): string {
  for (const tag of ['main', 'article']) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
    const inner = match?.[1] ?? '';
    if (stripTags(inner).length > 200) return inner;
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  return body;
}

export function titleOf(html: string): string {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  return stripTags(raw).slice(0, 200);
}

export function decodeDdgUrl(href: string): string {
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
