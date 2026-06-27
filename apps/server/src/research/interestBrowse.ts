import type { LunaResearchStore } from '../memory/lunaResearchStore.js';
import type { LunaResearchMode } from './lunaResearchRunner.js';
import {
  type ConversationResearchContext,
  extractTopicsFromConversation,
  getRecentlyCoveredKeywords
} from './conversationResearch.js';

export interface InterestBrowsePlan {
  mode: LunaResearchMode;
  query: string;
  category: string;
  label: string;
}

export const INTEREST_BROWSE_CATEGORIES = [
  {
    id: 'ai',
    label: 'AI and machine learning',
    mode: 'search' as const,
    query: (year: number) => `interesting AI artificial intelligence news and trends ${year} discussion`
  },
  {
    id: 'gaming',
    label: 'Gaming',
    mode: 'search' as const,
    query: (year: number) => `gaming news releases indie drama ${year} community`
  },
  {
    id: 'vtubers',
    label: 'VTubers and streaming',
    mode: 'search' as const,
    query: (year: number) => `vtuber virtual youtuber twitch youtube streaming culture ${year}`
  },
  {
    id: 'tech',
    label: 'Tech and internet culture',
    mode: 'search' as const,
    query: (year: number) => `tech internet culture apps startups ${year} interesting`
  },
  {
    id: 'science',
    label: 'Science and space',
    mode: 'search' as const,
    query: (year: number) => `science space discovery research ${year} fascinating`
  },
  {
    id: 'entertainment',
    label: 'Movies, TV, and anime',
    mode: 'search' as const,
    query: (year: number) => `movies tv anime entertainment ${year} worth discussing`
  },
  {
    id: 'world',
    label: 'World news digest',
    mode: 'rss' as const,
    query: () => 'recent headlines'
  },
  {
    id: 'trivia',
    label: 'Fun facts and common knowledge',
    mode: 'search' as const,
    query: () => 'interesting fun facts common knowledge topics to discuss today'
  }
] as const;

export function planInterestBrowse(
  dmLines: string[],
  voiceSnippets: string[],
  researchStore: LunaResearchStore
): InterestBrowsePlan {
  const context: ConversationResearchContext = {
    recentLines: dmLines,
    voiceMemorySummary: voiceSnippets.join('\n')
  };
  const userTopics = extractTopicsFromConversation(context);
  const covered = new Set(getRecentlyCoveredKeywords(researchStore));
  const year = new Date().getFullYear();

  const freshUserTopic = userTopics.find((topic) => (
    !tokenize(topic).some((token) => covered.has(token))
  ));
  if (freshUserTopic) {
    return {
      mode: 'search',
      category: 'user_interest',
      label: `Something ${freshUserTopic} related`,
      query: `latest ${freshUserTopic} news and discussion ${year}`
    };
  }

  const recentCategories = researchStore.recent(10)
    .map((record) => inferCategoryId(record.query ?? '', record.title))
    .filter(Boolean) as string[];

  let best = INTEREST_BROWSE_CATEGORIES[0]!;
  let bestScore = -Infinity;
  for (const category of INTEREST_BROWSE_CATEGORIES) {
    const query = category.query(year);
    const score = scoreCategoryFreshness(category.id, query, covered, recentCategories);
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }

  return {
    mode: best.mode,
    category: best.id,
    label: best.label,
    query: best.query(year)
  };
}

export function formatInterestBrowseHint(plan: InterestBrowsePlan) {
  return `${plan.label}: ${plan.query}`;
}

export function buildVoiceConversationStarterQuery(
  recentExchanges: string[],
  participantNames: string[]
) {
  const context: ConversationResearchContext = {
    recentLines: recentExchanges,
    displayName: participantNames[0]
  };
  const topics = extractTopicsFromConversation(context);
  const year = new Date().getFullYear();

  if (topics.length) {
    return `interesting ${topics[0]} discussion ${year}`;
  }

  const starter = INTEREST_BROWSE_CATEGORIES[Math.floor(Math.random() * 5)]!;
  return starter.query(year);
}

function inferCategoryId(query: string, title: string) {
  const haystack = `${query} ${title}`.toLowerCase();
  for (const category of INTEREST_BROWSE_CATEGORIES) {
    if (haystack.includes(category.id)) return category.id;
    if (category.id === 'ai' && /\b(artificial intelligence|machine learning|llm|chatgpt)\b/.test(haystack)) return category.id;
    if (category.id === 'gaming' && /\bgaming\b|\bgame release\b/.test(haystack)) return category.id;
    if (category.id === 'vtubers' && /\bvtuber\b|\bvirtual youtuber\b/.test(haystack)) return category.id;
    if (category.id === 'world' && /\bheadlines?\b|\bworld news\b/.test(haystack)) return category.id;
  }
  return null;
}

function scoreCategoryFreshness(
  categoryId: string,
  query: string,
  covered: Set<string>,
  recentCategories: string[]
) {
  let score = 0;
  const recentCount = recentCategories.filter((id) => id === categoryId).length;
  score -= recentCount * 4;

  for (const token of tokenize(query)) {
    if (covered.has(token)) score -= 2;
  }

  if (categoryId === 'world') score -= 1;
  score += Math.random() * 1.5;
  return score;
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 4);
}
