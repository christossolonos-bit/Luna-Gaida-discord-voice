export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

export interface WebSearchResponse {
  ok: boolean;
  query?: string;
  results?: WebSearchResult[];
  error?: string;
  source?: 'searxng' | 'duckduckgo';
}

const USER_AGENT = 'giada-assistant/0.1 (Luna research)';

export async function searchWeb(
  searxngUrl: string | undefined,
  query: string,
  limit = 5
): Promise<WebSearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: false, error: 'empty_query' };
  }

  const searx = await searchSearxng(searxngUrl, trimmed, limit);
  if (searx.ok && searx.results?.length) {
    return { ...searx, source: 'searxng' };
  }

  const ddg = await searchDuckDuckGo(trimmed, limit);
  if (ddg.ok && ddg.results?.length) {
    return { ...ddg, source: 'duckduckgo' };
  }

  return searx.ok === false && ddg.ok === false
    ? { ok: false, error: searx.error ?? ddg.error ?? 'search_failed', query: trimmed }
    : { ok: true, query: trimmed, results: [], source: ddg.source ?? 'searxng' };
}

async function searchSearxng(
  searxngUrl: string | undefined,
  query: string,
  limit: number
): Promise<WebSearchResponse> {
  if (!searxngUrl?.trim()) {
    return { ok: false, error: 'searxng_not_configured' };
  }

  const url = new URL('/search', searxngUrl.trim());
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '0');

  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000)
  }).catch((error) => ({ ok: false, error } as const));

  if (!response.ok) {
    const reason = 'error' in response
      ? response.error instanceof Error ? response.error.message : String(response.error)
      : await response.text().catch(() => '');
    return { ok: false, error: 'searxng_request_failed', query };
  }

  const payload = await response.json().catch((error) => ({ error })) as {
    results?: Array<{ title?: unknown; url?: unknown; content?: unknown; engine?: unknown }>;
    error?: unknown;
  };
  if (payload.error) {
    return {
      ok: false,
      error: 'searxng_invalid_json',
      query
    };
  }

  const results = (payload.results ?? [])
    .map((result) => {
      const entry: WebSearchResult = {
        title: typeof result.title === 'string' ? result.title : '',
        url: typeof result.url === 'string' ? result.url : '',
        snippet: typeof result.content === 'string' ? result.content : ''
      };
      if (typeof result.engine === 'string') entry.engine = result.engine;
      return entry;
    })
    .filter((result) => result.title && result.url)
    .slice(0, limit);

  return { ok: true, query, results };
}

async function searchDuckDuckGo(query: string, limit: number): Promise<WebSearchResponse> {
  const response = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(20_000)
  }).catch(() => null);

  if (!response?.ok) {
    return { ok: false, error: 'duckduckgo_request_failed', query };
  }

  const html = await response.text();
  const results: WebSearchResult[] = [];
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) && results.length < limit) {
    const rawUrl = decodeDuckDuckGoUrl(match[1] ?? '');
    const title = stripHtml(match[2] ?? '').trim();
    if (!rawUrl || !title) continue;
    results.push({ title, url: rawUrl, snippet: '' });
  }

  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let snippetIndex = 0;
  while ((match = snippetRe.exec(html)) && snippetIndex < results.length) {
    results[snippetIndex]!.snippet = stripHtml(match[1] ?? '').trim();
    snippetIndex += 1;
  }

  return results.length
    ? { ok: true, query, results, source: 'duckduckgo' }
    : { ok: false, error: 'duckduckgo_no_results', query };
}

function decodeDuckDuckGoUrl(href: string) {
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return uddg;
    if (parsed.hostname === 'duckduckgo.com') return '';
    return parsed.toString();
  } catch {
    return href.startsWith('http') ? href : '';
  }
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
