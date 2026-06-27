const USER_AGENT = 'giada-assistant/0.1 (Luna read)';

export interface ReadWebPageResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  error?: string;
}

export async function readWebPage(url: string, maxChars = 6000): Promise<ReadWebPageResult> {
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
      accept: 'text/html,application/xhtml+xml,text/plain',
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
