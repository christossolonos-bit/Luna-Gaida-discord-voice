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

export type SearchProvider = 'duckduckgo' | 'searxng';

export interface SearchWebOptions {
  searxngUrl?: string;
  provider?: SearchProvider;
}

const USER_AGENT = 'giada-assistant/0.1 (Luna research)';

export async function searchWeb(
  query: string,
  limit = 5,
  options: SearchWebOptions = {}
): Promise<WebSearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: false, error: 'empty_query' };
  }

  const provider = options.provider ?? 'duckduckgo';

  if (provider === 'duckduckgo') {
    const ddg = await searchDuckDuckGo(trimmed, limit);
    if (ddg.ok && ddg.results?.length) {
      return { ...ddg, source: 'duckduckgo' };
    }
    const searx = await searchSearxng(options.searxngUrl, trimmed, limit);
    if (searx.ok && searx.results?.length) {
      return { ...searx, source: 'searxng' };
    }
    return ddg.ok === false && searx.ok === false
      ? { ok: false, error: ddg.error ?? searx.error ?? 'search_failed', query: trimmed }
      : { ok: true, query: trimmed, results: [], source: 'duckduckgo' };
  }

  const searx = await searchSearxng(options.searxngUrl, trimmed, limit);
  if (searx.ok && searx.results?.length) {
    return { ...searx, source: 'searxng' };
  }
  const ddg = await searchDuckDuckGo(trimmed, limit);
  if (ddg.ok && ddg.results?.length) {
    return { ...ddg, source: 'duckduckgo' };
  }
  return searx.ok === false && ddg.ok === false
    ? { ok: false, error: searx.error ?? ddg.error ?? 'search_failed', query: trimmed }
    : { ok: true, query: trimmed, results: [], source: searx.source ?? 'searxng' };
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
    return { ok: false, error: reason || 'searxng_request_failed', query };
  }

  const payload = await response.json().catch(() => ({ error: 'invalid_json' })) as {
    results?: Array<{ title?: unknown; url?: unknown; content?: unknown; engine?: unknown }>;
    error?: unknown;
  };
  if (payload.error) {
    return { ok: false, error: 'searxng_invalid_json', query };
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
  const instant = await fetchDuckDuckGoInstantAnswer(query);
  const html = await searchDuckDuckGoHtml(query, limit);
  const lite = html.results?.length ? html : await searchDuckDuckGoLite(query, limit);
  const merged = mergeDuckDuckGoResults(instant, lite.results ?? [], limit);

  return merged.length
    ? { ok: true, query, results: merged, source: 'duckduckgo' }
    : { ok: false, error: 'duckduckgo_no_results', query };
}

interface DuckDuckGoInstantAnswer {
  heading: string;
  abstract: string;
  url: string;
}

async function fetchDuckDuckGoInstantAnswer(query: string): Promise<DuckDuckGoInstantAnswer | null> {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');

  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(12_000)
  }).catch(() => null);

  if (!response?.ok) return null;

  const payload = await response.json().catch(() => null) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
  } | null;
  if (!payload?.AbstractText?.trim()) return null;

  return {
    heading: payload.Heading?.trim() || query,
    abstract: payload.AbstractText.trim(),
    url: payload.AbstractURL?.trim() || ''
  };
}

async function searchDuckDuckGoHtml(query: string, limit: number): Promise<WebSearchResponse> {
  const response = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT
    },
    body: `q=${encodeURIComponent(query)}&kl=us-en`,
    signal: AbortSignal.timeout(20_000)
  }).catch(() => null);

  if (!response?.ok) {
    return { ok: false, error: 'duckduckgo_request_failed', query };
  }

  const html = await response.text();
  return { ok: true, query, results: parseDuckDuckGoHtmlResults(html, limit), source: 'duckduckgo' };
}

async function searchDuckDuckGoLite(query: string, limit: number): Promise<WebSearchResponse> {
  const response = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT
    },
    body: `q=${encodeURIComponent(query)}&kl=us-en`,
    signal: AbortSignal.timeout(20_000)
  }).catch(() => null);

  if (!response?.ok) {
    return { ok: false, error: 'duckduckgo_lite_failed', query };
  }

  const html = await response.text();
  const results = parseDuckDuckGoLiteResults(html, limit);
  return results.length
    ? { ok: true, query, results, source: 'duckduckgo' }
    : { ok: false, error: 'duckduckgo_no_results', query };
}

function parseDuckDuckGoHtmlResults(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) && results.length < limit) {
    pushDuckDuckGoResult(results, match[1] ?? '', stripHtml(match[2] ?? ''), '');
  }

  if (!results.length) {
    const linkRe = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = linkRe.exec(html)) && results.length < limit) {
      pushDuckDuckGoResult(results, match[1] ?? '', stripHtml(match[2] ?? ''), '');
    }
  }

  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let snippetIndex = 0;
  while ((match = snippetRe.exec(html)) && snippetIndex < results.length) {
    results[snippetIndex]!.snippet = stripHtml(match[1] ?? '').trim();
    snippetIndex += 1;
  }

  return results;
}

function parseDuckDuckGoLiteResults(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const rowRe = /<tr[^>]*>[\s\S]*?<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) && results.length < limit) {
    const block = match[0] ?? '';
    const title = stripHtml(match[2] ?? '').trim();
    const snippetMatch = block.match(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i)
      ?? block.match(/<br\s*\/?>\s*([^<]{20,400})/i);
    const snippet = snippetMatch?.[1] ? stripHtml(snippetMatch[1]).trim() : '';
    pushDuckDuckGoResult(results, match[1] ?? '', title, snippet);
  }
  return results;
}

function pushDuckDuckGoResult(
  results: WebSearchResult[],
  href: string,
  title: string,
  snippet: string
) {
  const url = decodeDuckDuckGoUrl(href);
  if (!url || !title) return;
  if (results.some((entry) => entry.url === url)) return;
  results.push({ title, url, snippet, engine: 'duckduckgo' });
}

function mergeDuckDuckGoResults(
  instant: DuckDuckGoInstantAnswer | null,
  htmlResults: WebSearchResult[],
  limit: number
) {
  const merged: WebSearchResult[] = [];
  if (instant?.abstract) {
    merged.push({
      title: instant.heading,
      url: instant.url || `https://duckduckgo.com/?q=${encodeURIComponent(instant.heading)}`,
      snippet: instant.abstract,
      engine: 'duckduckgo_instant'
    });
  }
  for (const result of htmlResults) {
    if (merged.length >= limit) break;
    if (merged.some((entry) => entry.url === result.url)) continue;
    merged.push(result);
  }
  return merged.slice(0, limit);
}

function decodeDuckDuckGoUrl(href: string) {
  try {
    const parsed = new URL(href, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return uddg;
    if (parsed.hostname.includes('duckduckgo.com')) return '';
    return parsed.toString();
  } catch {
    return href.startsWith('http') ? href : '';
  }
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
