import type { AppConfig } from '../config/env.js';
import { fetchRssHeadlines, type RssItem } from './rssReader.js';
import { readWebPage } from './readWebPage.js';
import { searchWeb, type SearchWebOptions } from './webSearch.js';
import { isVideoUrl, watchSharedVideo } from './watchVideo.js';

export type LunaResearchMode = 'search' | 'rss' | 'read';
export type LunaResearchPurpose = 'conversation' | 'general';

export interface LunaResearchInput {
  mode: LunaResearchMode;
  query?: string;
  url?: string;
}

export interface LunaResearchOptions {
  purpose?: LunaResearchPurpose;
  excludeUrls?: string[];
  excludeKeywords?: string[];
  preferDigest?: boolean;
  deep?: boolean;
  userQuestion?: string;
}

export interface LunaResearchFinding {
  mode: LunaResearchMode;
  query: string | null;
  url: string | null;
  title: string;
  summary: string;
  source: string;
}

export async function runLunaResearch(
  config: AppConfig,
  input: LunaResearchInput,
  options: LunaResearchOptions = {}
): Promise<LunaResearchFinding | null> {
  const purpose = options.purpose ?? 'general';
  if (input.mode === 'rss') {
    return researchFromRss(config, input.query, purpose, options);
  }
  if (input.mode === 'read' && input.url?.trim()) {
    return researchFromUrl(config, input.url.trim());
  }
  if (input.mode === 'search' && input.query?.trim()) {
    if (options.deep ?? config.lunaDeepResearch) {
      return researchFromSearchDeep(config, input.query.trim(), purpose, options);
    }
    return researchFromSearch(config, input.query.trim(), purpose, options);
  }
  return null;
}

async function researchFromRss(
  config: AppConfig,
  topic?: string,
  purpose: LunaResearchPurpose = 'general',
  options: LunaResearchOptions = {}
): Promise<LunaResearchFinding | null> {
  const feeds = config.lunaRssFeeds;
  const normalizedTopic = topic?.trim();
  const headlines = feeds.length ? await fetchRssHeadlines(feeds, 6, 24) : [];

  if (!headlines.length) {
    const query = normalizedTopic ? `${normalizedTopic} news` : 'latest world news headlines today';
    return researchFromSearchDeep(config, query, purpose, options);
  }
  const filtered = filterHeadlines(headlines, options);
  const pool = filtered.length ? filtered : headlines;
  const wantsDigest = Boolean(options.preferDigest) || /^recent headlines?$/i.test(normalizedTopic ?? '');

  if (wantsDigest) {
    return buildHeadlinesDigest(pool, normalizedTopic);
  }

  const picked = normalizedTopic
    ? pickRssItem(pool, normalizedTopic, options.excludeKeywords ?? [])
    : pickDiverseRssItems(pool, 1, options.excludeKeywords ?? [])[0] ?? pool[0]!;

  const article = await readWebPage(picked.link, config.lunaResearchMaxReadChars);
  const summary = article.ok && article.text
    ? `${picked.title}. ${article.text.slice(0, 1200)}`
    : picked.summary?.trim() || picked.title;

  return {
    mode: 'rss',
    query: normalizedTopic || 'recent headlines',
    url: picked.link,
    title: picked.title,
    summary: summary.slice(0, 1800),
    source: 'rss'
  };
}

function searchOptions(config: AppConfig): SearchWebOptions {
  return {
    searxngUrl: config.SEARXNG_URL,
    provider: config.lunaSearchProvider
  };
}

const MIN_PAGE_TEXT_CHARS = 250;
const SEARCH_RESULT_LIMIT = 12;
const READ_BATCH_SIZE = 3;

const LOW_VALUE_HOST_RE = /^(?:www\.)?(facebook|fb|twitter|x|instagram|tiktok|pinterest|linkedin)\./i;

interface PageExcerpt {
  url: string;
  title: string;
  body: string;
}

function shouldSkipSearchUrl(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOW_VALUE_HOST_RE.test(host) || host.includes('login') || host.includes('accounts.');
  } catch {
    return true;
  }
}

async function researchFromSearchDeep(
  config: AppConfig,
  query: string,
  purpose: LunaResearchPurpose = 'general',
  options: LunaResearchOptions = {}
): Promise<LunaResearchFinding | null> {
  const searchQuery = wrapQueryForConversation(query, purpose);
  const search = await searchWeb(searchQuery, SEARCH_RESULT_LIMIT, searchOptions(config));
  if (!search.ok || !search.results?.length) {
    return researchFromSearch(config, query, purpose, options);
  }

  const excludeUrls = new Set(options.excludeUrls ?? []);
  const pageBudget = config.lunaDeepResearchPages ?? 5;
  const maxCharsPerPage = Math.max(
    1500,
    Math.floor(config.lunaResearchMaxReadChars / Math.max(pageBudget, 2))
  );
  const candidates = search.results.filter(
    (result) => !excludeUrls.has(result.url) && !shouldSkipSearchUrl(result.url)
  );

  const excerpts: PageExcerpt[] = [];

  for (let index = 0; index < candidates.length && excerpts.length < pageBudget; index += READ_BATCH_SIZE) {
    const batch = candidates.slice(index, index + READ_BATCH_SIZE);
    const reads = await Promise.all(
      batch.map((result) => fetchPageExcerpt(config, result, maxCharsPerPage))
    );
    for (const excerpt of reads) {
      if (excerpt && excerpt.body.length >= MIN_PAGE_TEXT_CHARS && excerpts.length < pageBudget) {
        excerpts.push(excerpt);
      }
    }
  }

  if (!excerpts.length) {
    return researchFromSearch(config, query, purpose, options);
  }

  const summary = excerpts
    .map((excerpt) => `### ${excerpt.title}\nSource: ${excerpt.url}\n\n${excerpt.body}`)
    .join('\n\n---\n\n')
    .slice(0, config.lunaResearchMaxReadChars);

  return {
    mode: 'search',
    query: searchQuery,
    url: excerpts[0]?.url ?? null,
    title: `Deep research: ${query}`,
    summary,
    source: search.source ?? 'search'
  };
}

async function fetchPageExcerpt(
  config: AppConfig,
  result: { url: string; title: string; snippet?: string },
  maxChars: number
): Promise<PageExcerpt | null> {
  if (isVideoUrl(result.url)) {
    const watched = await watchSharedVideo(config, result.url);
    if (!watched.ok || !watched.transcript.trim()) {
      return null;
    }
    return {
      url: result.url,
      title: watched.title || result.title,
      body: watched.transcript.slice(0, maxChars)
    };
  }

  const article = await readWebPage(result.url, maxChars);
  if (article.ok && article.text && article.text.length >= MIN_PAGE_TEXT_CHARS) {
    return {
      url: result.url,
      title: article.title ?? result.title,
      body: article.text
    };
  }

  return null;
}

async function researchFromSearch(
  config: AppConfig,
  query: string,
  purpose: LunaResearchPurpose = 'general',
  options: LunaResearchOptions = {}
): Promise<LunaResearchFinding | null> {
  const searchQuery = wrapQueryForConversation(query, purpose);
  const search = await searchWeb(searchQuery, 6, searchOptions(config));
  if (!search.ok || !search.results?.length) {
    return null;
  }

  const excludeUrls = new Set(options.excludeUrls ?? []);
  const top = search.results.find((result) => !excludeUrls.has(result.url)) ?? search.results[0]!;
  const article = await readWebPage(top.url, config.lunaResearchMaxReadChars);
  const summary = article.ok && article.text
    ? `${top.title}. ${article.text.slice(0, 1200)}`
    : [top.title, top.snippet].filter(Boolean).join(' — ');

  return {
    mode: 'search',
    query: searchQuery,
    url: top.url,
    title: article.title ?? top.title,
    summary: summary.slice(0, 1800),
    source: search.source ?? 'search'
  };
}

function filterHeadlines(items: RssItem[], options: LunaResearchOptions) {
  const excludeUrls = new Set(options.excludeUrls ?? []);
  const excludeKeywords = (options.excludeKeywords ?? []).map((word) => word.toLowerCase());
  return items.filter((item) => {
    if (excludeUrls.has(item.link)) return false;
    const haystack = `${item.title} ${item.summary ?? ''}`.toLowerCase();
    const overlap = excludeKeywords.filter((keyword) => haystack.includes(keyword)).length;
    return overlap < 2;
  });
}

function buildHeadlinesDigest(items: RssItem[], topic?: string): LunaResearchFinding {
  const picked = pickDiverseRssItems(items, 4);
  const summary = picked
    .map((item) => `• ${item.title}${item.summary ? ` — ${item.summary.slice(0, 120).trim()}` : ''}`)
    .join('\n');

  return {
    mode: 'rss',
    query: topic?.trim() || 'recent headlines',
    url: null,
    title: topic?.trim() ? `Headlines related to ${topic}` : 'Recent headlines (varied topics)',
    summary: summary.slice(0, 1800),
    source: 'rss'
  };
}

function pickDiverseRssItems(items: RssItem[], count: number, penaltyKeywords: string[] = []) {
  const picked: RssItem[] = [];
  const usedTokens = new Set<string>();

  for (const item of items) {
    if (picked.length >= count) break;
    const score = scoreRssItem(item, '', penaltyKeywords);
    if (score < -5) continue;
    const tokens = titleTokens(item.title);
    if (tokens.some((token) => usedTokens.has(token))) continue;
    picked.push(item);
    for (const token of tokens) usedTokens.add(token);
  }

  for (const item of items) {
    if (picked.length >= count) break;
    if (picked.includes(item)) continue;
    picked.push(item);
  }

  return picked;
}

function titleTokens(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 5);
}

function scoreRssItem(item: RssItem, topic: string, penaltyKeywords: string[]) {
  const hay = `${item.title} ${item.summary ?? ''}`.toLowerCase();
  let score = 0;
  if (topic) {
    const needle = topic.toLowerCase();
    const words = needle.split(/\s+/).filter((word) => word.length > 2);
    score += hay.includes(needle) ? 10 : 0;
    for (const word of words) {
      if (hay.includes(word)) score += 1;
    }
  }
  for (const keyword of penaltyKeywords) {
    if (keyword.length >= 4 && hay.includes(keyword.toLowerCase())) {
      score -= 2;
    }
  }
  return score;
}

async function researchFromUrl(config: AppConfig, url: string): Promise<LunaResearchFinding | null> {
  if (isVideoUrl(url)) {
    const watched = await watchSharedVideo(config, url);
    if (!watched.ok && !watched.transcript.trim() && !watched.visualDescription?.trim()) {
      return null;
    }
    return {
      mode: 'read',
      query: null,
      url: watched.url,
      title: watched.title,
      summary: [
        watched.visualDescription ? `What Luna saw on screen:\n${watched.visualDescription}` : null,
        watched.transcript || watched.error || 'No transcript available.'
      ].filter(Boolean).join('\n\n'),
      source: `video_${watched.method}`
    };
  }

  const article = await readWebPage(url, config.lunaResearchMaxReadChars);
  if (!article.ok || !article.text) {
    return null;
  }
  return {
    mode: 'read',
    query: null,
    url: article.url ?? url,
    title: article.title ?? url,
    summary: article.text.slice(0, 1800),
    source: 'read'
  };
}

function pickRssItem(items: RssItem[], topic: string, penaltyKeywords: string[] = []) {
  const needle = topic.toLowerCase();
  const words = needle.split(/\s+/).filter((word) => word.length > 2);
  let best = items[0]!;
  let bestScore = -Infinity;
  for (const item of items) {
    const score = scoreRssItem(item, topic, penaltyKeywords);
    const hay = `${item.title} ${item.summary ?? ''}`.toLowerCase();
    const direct = hay.includes(needle) ? 10 : 0;
    let wordScore = 0;
    for (const word of words) {
      if (hay.includes(word)) wordScore += 1;
    }
    const total = score + direct + wordScore;
    if (total > bestScore) {
      bestScore = total;
      best = item;
    }
  }
  return best;
}

export function formatResearchFindingBlock(finding: LunaResearchFinding, userQuestion?: string) {
  const lines: string[] = [];
  if (userQuestion?.trim()) {
    lines.push(`User question: ${userQuestion.trim()}`);
    lines.push(
      'Answer that question directly using the article excerpts below. Give specific facts, numbers, names, and dates. Do not reply with only headlines, link lists, or "here are some results".'
    );
  }
  lines.push(
    `Title: ${finding.title}`,
    finding.query ? `Query: ${finding.query}` : null,
    finding.url ? `Primary source: ${finding.url}` : null,
    `Article excerpts:\n${finding.summary}`
  );
  return lines.filter(Boolean).join('\n');
}

export function wrapQueryForConversation(query: string, purpose: LunaResearchPurpose = 'conversation') {
  if (purpose !== 'conversation') return query.trim();
  const trimmed = query.trim();
  if (!trimmed) return 'interesting conversation topics things to discuss';
  if (/conversation|talk about|discussion starter|things to discuss/i.test(trimmed)) {
    return trimmed;
  }
  return `interesting conversation topics ${trimmed} things to discuss`;
}
