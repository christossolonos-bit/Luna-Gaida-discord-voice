const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const MIN_USEFUL_TEXT_CHARS = 200;

export interface ReadWebPageResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  error?: string;
}

export async function readWebPage(url: string, maxChars = 6000): Promise<ReadWebPageResult> {
  const direct = await readWebPageDirect(url, maxChars);
  if (direct.ok && (direct.text?.length ?? 0) >= MIN_USEFUL_TEXT_CHARS) {
    return direct;
  }

  const viaJina = await readWebPageViaJina(url, maxChars);
  if (viaJina.ok && (viaJina.text?.length ?? 0) >= 100) {
    return viaJina;
  }

  return direct.ok ? direct : viaJina;
}

async function readWebPageDirect(url: string, maxChars: number): Promise<ReadWebPageResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'unsupported_protocol' };
  }

  const response = await fetch(parsed.toString(), {
    headers: {
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': USER_AGENT
    },
    signal: AbortSignal.timeout(25_000),
    redirect: 'follow'
  }).catch((error) => ({ ok: false, error } as const));

  if (!response.ok) {
    const reason = 'error' in response
      ? response.error instanceof Error ? response.error.message : String(response.error)
      : `HTTP ${'status' in response ? response.status : 'unknown'}`;
    return { ok: false, error: reason, url: parsed.toString() };
  }

  const contentType = response.headers.get('content-type') ?? '';
  const raw = await response.text();
  if (contentType.includes('text/plain')) {
    return {
      ok: true,
      url: parsed.toString(),
      title: parsed.hostname,
      text: raw.slice(0, maxChars).trim()
    };
  }

  const title = extractTitle(raw) || parsed.hostname;
  const text = htmlToText(raw).slice(0, maxChars).trim();
  if (!text) {
    return { ok: false, error: 'no_readable_text', url: parsed.toString() };
  }

  return { ok: true, url: parsed.toString(), title, text };
}

async function readWebPageViaJina(url: string, maxChars: number): Promise<ReadWebPageResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }

  const jinaUrl = `https://r.jina.ai/${parsed.toString()}`;
  const response = await fetch(jinaUrl, {
    headers: {
      accept: 'text/plain',
      'user-agent': USER_AGENT
    },
    signal: AbortSignal.timeout(35_000),
    redirect: 'follow'
  }).catch((error) => ({ ok: false, error } as const));

  if (!response.ok) {
    const reason = 'error' in response
      ? response.error instanceof Error ? response.error.message : String(response.error)
      : `HTTP ${'status' in response ? response.status : 'unknown'}`;
    return { ok: false, error: reason, url: parsed.toString() };
  }

  const raw = await response.text();
  const text = raw.slice(0, maxChars).trim();
  if (!text) {
    return { ok: false, error: 'no_readable_text', url: parsed.toString() };
  }

  const title = extractJinaTitle(raw) || parsed.hostname;
  return { ok: true, url: parsed.toString(), title, text };
}

function extractJinaTitle(markdown: string) {
  const firstLine = markdown.split('\n').find((line) => line.trim())?.trim() ?? '';
  const heading = firstLine.match(/^#\s+(.+)/);
  if (heading?.[1]) return heading[1].trim();
  const titleLine = markdown.match(/^Title:\s*(.+)$/im);
  return titleLine?.[1]?.trim() ?? '';
}

function extractTitle(html: string) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeEntities(stripTags(match[1])).trim() : '';
}

function htmlToText(html: string) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  cleaned = cleaned
    .replace(/<\/(p|div|section|article|h\d|li|br|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  const text = decodeEntities(stripTags(cleaned))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 2)
    .join('\n');

  return text;
}

function stripTags(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]+>/g, ' ');
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
