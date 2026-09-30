import { search } from 'pi-web-access/gemini-search.ts';
import { extractContent } from 'pi-web-access/extract.ts';
import { parse } from 'parse5';
import type { WebFetch, WebSearch } from '../../ports/web-search.ts';

type HtmlNode = {
  nodeName: string;
  value?: string;
  childNodes?: HtmlNode[];
  attrs?: Array<{ name: string; value: string }>;
};

function readableHtml(html: string, base: string) {
  const lines: string[] = [];
  const blocks = new Set([
    'p',
    'div',
    'section',
    'article',
    'main',
    'header',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'li',
    'tr',
    'br',
  ]);
  let title = '';
  const walk = (node: HtmlNode) => {
    if (['script', 'style', 'noscript', 'svg', 'form'].includes(node.nodeName)) return;
    if (node.nodeName === '#text') {
      lines.push(node.value ?? '');
      return;
    }
    if (node.nodeName === 'title') {
      title =
        node.childNodes
          ?.map((item) => item.value ?? '')
          .join('')
          .trim() ?? '';
      return;
    }
    if (node.nodeName === 'head') {
      node.childNodes?.forEach(walk);
      return;
    }
    if (blocks.has(node.nodeName)) lines.push('\n');
    node.childNodes?.forEach(walk);
    if (node.nodeName === 'a') {
      const href = node.attrs?.find((item) => item.name === 'href')?.value;
      if (href) {
        try {
          const url = new URL(href, base);
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
            lines.push(` (${url.href})`);
        } catch {}
      }
    }
    if (blocks.has(node.nodeName)) lines.push('\n');
  };
  walk(parse(html) as HtmlNode);
  return {
    title,
    content: lines
      .join('')
      .replace(/[ \t\r\f]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  };
}

export function createWebFetch(run: typeof extractContent = extractContent): WebFetch {
  return async (value, signal) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Choose a public HTTP or HTTPS URL.');
    }
    if (
      value.length > 2048 ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('Choose a public HTTP or HTTPS URL.');
    const result = await run(url.href, signal, { mode: 'raw' });
    signal.throwIfAborted();
    if (result.error || (result.status && result.status >= 400))
      throw new Error('The public page could not be read. Try the browser.');
    const page = result.mimeType === 'text/html' ? readableHtml(result.content, url.href) : null;
    const content = page?.content ?? result.content;
    if (!content.trim()) throw new Error('The public page could not be read. Try the browser.');
    return {
      url: result.url.slice(0, 2048),
      title: (page?.title || result.title).slice(0, 300),
      content: content.slice(0, 50_000),
    };
  };
}

export function createWebSearch(
  run: typeof search = search,
  fallback: typeof search = search,
): WebSearch {
  return async (query, signal) => {
    try {
      let response: Awaited<ReturnType<typeof search>>;
      try {
        response = await run(query, { numResults: 8, signal });
      } catch (error) {
        signal.throwIfAborted();
        if (
          !(error instanceof Error) ||
          !/^(Auto provider search failed:|No search provider available\.)/.test(error.message)
        ) {
          throw error;
        }
        try {
          response = await fallback(query, { numResults: 8, signal, provider: 'anysearch' });
        } catch {
          signal.throwIfAborted();
          response = await fallback(query, { numResults: 8, signal, provider: 'duckduckgo' });
        }
      }
      return {
        source: response.provider,
        ...(response.answer ? { answer: response.answer.slice(0, 3000) } : {}),
        results: response.results
          .filter((item) => {
            try {
              const url = new URL(item.url);
              return (
                item.url.length <= 2048 &&
                ['http:', 'https:'].includes(url.protocol) &&
                !url.username &&
                !url.password
              );
            } catch {
              return false;
            }
          })
          .slice(0, 8)
          .map((item) => ({
            title: item.title.slice(0, 200),
            url: item.url,
            snippet: item.snippet.slice(0, 600),
          })),
      };
    } catch {
      signal.throwIfAborted();
      throw new Error('Web search is unavailable. Try the browser.');
    }
  };
}
