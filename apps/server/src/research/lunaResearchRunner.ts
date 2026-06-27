import type { AppConfig } from '../config/env.js';
import { fetchRssHeadlines, type RssItem } from './rssReader.js';
import { readWebPage } from './readWebPage.js';
import { searchWeb } from './webSearch.js';

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
    return researchFromUrl(input.url.trim());
  }
  if (input.mode === 'search' && input.query?.trim()) {
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
  if (!feeds.length) return null;

  const headlines = await fetchRssHeadlines(feeds, 6, 24);
  if (!headlines.length) return null;

  const filtered = filterHeadlines(headlines, options);
  const pool = filtered.length ? filtered : headlines;
  const normalizedTopic = topic?.trim();
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

async function researchFromSearch(
  config: AppConfig,
  query: string,
  purpose: LunaResearchPurpose = 'general',
  options: LunaResearchOptions = {}
): Promise<LunaResearchFinding | null> {
  const searchQuery = wrapQueryForConversation(query, purpose);
  const search = await searchWeb(config.SEARXNG_URL, searchQuery, 6);
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

async function researchFromUrl(url: string): Promise<LunaResearchFinding | null> {
  const article = await readWebPage(url);
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

export function formatResearchFindingBlock(finding: LunaResearchFinding) {
  const lines = [
    `Title: ${finding.title}`,
    finding.query ? `Query: ${finding.query}` : null,
    finding.url ? `Source: ${finding.url}` : null,
    `Notes: ${finding.summary}`
  ].filter(Boolean);
  return lines.join('\n');
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
