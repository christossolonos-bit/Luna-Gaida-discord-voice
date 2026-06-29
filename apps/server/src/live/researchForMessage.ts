import type { AppConfig } from '../config/env.js';
import type { LunaResearchStore } from '../memory/lunaResearchStore.js';
import {
  type ConversationResearchContext,
  detectConversationFollowUpResearch,
  enhanceResearchIntent,
  extractTopicsFromConversation
} from '../research/conversationResearch.js';
import { formatResearchFindingBlock, runLunaResearch, type LunaResearchMode } from '../research/lunaResearchRunner.js';
import {
  type LinkSenderIdentity,
  readTrustedLinksFromVoiceTextChat,
  readUrlsForResearch
} from '../research/trustedLinkSharing.js';
import { logger } from '../logging/logger.js';

const URL_RE = /https?:\/\/[^\s<>"')]+/i;

const NEWS_RE = /\b(?:latest|recent|today'?s?|current)\s+news\b|\bheadlines?\b|\bwhat(?:'s| is) (?:happening|in the news|going on)\b|\b(?:reading|read|follow(?:ing)?)\s+(?:the\s+)?(?:news|headlines)\b|\b(?:been\s+)?(?:reading|following)\s+(?:any\s+)?(?:news|headlines)\b/i;
const SEARCH_RE = /\b(?:look up|search(?:\s+for)?|google|duckduckgo|find out(?:\s+about)?|read about)\b/i;
const FACTUAL_RE = /\b(?:who (?:is|was|are)|what (?:is|are|happened|was)|when (?:did|was|is)|where (?:is|was)|how (?:much|many|old|long)|why (?:did|was|is)|do you know (?:about|if)|have you heard (?:about|of)|any news (?:about|on)|latest on|update on|is it true that)\b/i;
const ASK_RE = /\b(?:tell me about|what (?:is|are)|who is|who are|explain)\s+(.+)/i;

export async function buildMessageResearchBlock(
  config: AppConfig,
  userText: string,
  researchStore: LunaResearchStore,
  context?: ConversationResearchContext,
  sender?: LinkSenderIdentity
): Promise<string | null> {
  const parts: string[] = [];
  const who = sender?.displayName ?? sender?.username ?? 'They';

  const urlResearch = await readUrlsForResearch(config, userText, researchStore, who);
  if (urlResearch) parts.push(urlResearch);

  if (!urlResearch) {
    const voiceChatLinks = await readTrustedLinksFromVoiceTextChat(config, userText, researchStore);
    if (voiceChatLinks) parts.push(voiceChatLinks);
  }

  const other = await maybeResearchForUserMessage(config, userText, researchStore, context, {
    skipUrlIntent: Boolean(urlResearch)
  });
  if (other) parts.push(other);

  return parts.length ? parts.join('\n\n') : null;
}

export async function maybeResearchForUserMessage(
  config: AppConfig,
  userText: string,
  researchStore: LunaResearchStore,
  context?: ConversationResearchContext,
  options?: { skipUrlIntent?: boolean }
): Promise<string | null> {
  if (!config.lunaResearchEnabled) return null;

  const intent = resolveResearchIntent(userText, context, options?.skipUrlIntent);
  if (!intent) return null;

  const enhanced = enhanceResearchIntent(intent, context, researchStore);

  try {
    const finding = await runLunaResearch(config, {
      mode: enhanced.mode,
      ...(enhanced.query ? { query: enhanced.query } : {}),
      ...(enhanced.url ? { url: enhanced.url } : {})
    }, {
      excludeKeywords: enhanced.excludeKeywords,
      excludeUrls: enhanced.excludeUrls,
      preferDigest: enhanced.preferDigest,
      deep: enhanced.deep,
      userQuestion: userText.trim()
    });
    if (!finding) {
      return buildResearchFailureBlock(userText, researchStore);
    }

    researchStore.record({
      source: 'user_request',
      mode: finding.mode,
      query: finding.query,
      url: finding.url,
      title: finding.title,
      summary: finding.summary
    });

    const topics = context ? extractTopicsFromConversation(context) : [];
    const topicHint = topics.length
      ? `This search was guided by your recent chats about: ${topics.slice(0, 3).join(', ')}.`
      : '';

    return [
      'Deep web research for this reply. Read the excerpts below and answer the user\'s question with substance — synthesize what you learned into a direct answer, not a list of headlines or links.',
      topicHint,
      formatResearchFindingBlock(finding, userText)
    ].filter(Boolean).join('\n');
  } catch (error) {
    logger.warn('User-triggered Luna research failed', {
      error: error instanceof Error ? error.message : String(error),
      mode: intent.mode
    });
    return null;
  }
}

function resolveResearchIntent(
  userText: string,
  context?: ConversationResearchContext,
  skipUrlIntent = false
) {
  const explicit = detectResearchIntent(userText, skipUrlIntent);
  if (explicit) return explicit;
  if (!context) return null;
  return detectConversationFollowUpResearch(userText, context);
}

export function detectResearchIntent(userText: string, skipUrlIntent = false): {
  mode: LunaResearchMode;
  query?: string;
  url?: string;
  deep?: boolean;
} | null {
  const text = normalizeResearchIntentText(userText.trim());
  if (!text) return null;

  if (!skipUrlIntent) {
    const urlMatch = text.match(URL_RE);
    if (urlMatch?.[0]) {
      return { mode: 'read', url: urlMatch[0], deep: false };
    }
  }

  if (NEWS_RE.test(text)) {
    const topic = extractTopicAfter(text, /\b(?:about|on)\s+(.+)/i);
    const query = topic ? `${topic} latest news` : 'latest world news today';
    return { mode: 'search', query: cleanQuery(query), deep: true };
  }

  if (SEARCH_RE.test(text)) {
    const query = extractTopicAfter(text, SEARCH_RE) ?? text;
    return { mode: 'search', query: cleanQuery(query), deep: true };
  }

  if (FACTUAL_RE.test(text)) {
    const subject = extractFactualSubject(text);
    if (subject && subject.length >= 3 && !isPersonalSmallTalk(text)) {
      return { mode: 'search', query: cleanQuery(subject), deep: true };
    }
  }

  const askMatch = text.match(ASK_RE);
  if (askMatch?.[1]) {
    const subject = cleanQuery(askMatch[1]);
    if (subject.length >= 3 && looksLikeFactualQuestion(text)) {
      return { mode: 'search', query: subject, deep: true };
    }
  }

  if (CURRENT_EVENTS_RE.test(text) && !isPersonalSmallTalk(text)) {
    return { mode: 'search', query: cleanQuery(text), deep: true };
  }

  if (/\?$/.test(text) && text.length >= 14 && !isPersonalSmallTalk(text) && looksLikeExternalQuestion(text)) {
    return { mode: 'search', query: cleanQuery(text), deep: true };
  }

  return null;
}

function normalizeResearchIntentText(text: string) {
  return text
    .replace(/\bwhat'?s\b/gi, 'what is')
    .replace(/\bwho'?s\b/gi, 'who is')
    .replace(/\bwhen'?s\b/gi, 'when is')
    .replace(/\bwhere'?s\b/gi, 'where is')
    .replace(/\bhow'?s\b/gi, 'how is');
}

const CURRENT_EVENTS_RE = /\b(?:right now|currently|today|tonight|this week|this month|this year|as of|up to date|going on with|latest on|any update)\b/i;

function looksLikeExternalQuestion(text: string) {
  return /\b(?:news|weather|price|cost|release|update|score|winner|election|stock|crypto|bitcoin|game|movie|show|album|patch|nerf|buff|president|ceo|company|country|war|trailer|rumor|leak)\b/i.test(text)
    || CURRENT_EVENTS_RE.test(text);
}

function looksLikeFactualQuestion(text: string) {
  if (isPersonalSmallTalk(text)) {
    return false;
  }
  return /\b(?:news|latest|current|today|who is|what is|what are|explain|happened|release|price|weather)\b/i.test(text)
    || text.length > 40;
}

function isPersonalSmallTalk(text: string) {
  return /\b(?:your|you|my|our)\b/i.test(text)
    && !/\b(?:news|world|country|company|game|movie|show|president|ceo|stock|weather)\b/i.test(text);
}

function extractFactualSubject(text: string) {
  const patterns = [
    /\b(?:who (?:is|was|are))\s+(.+)/i,
    /\b(?:what (?:is|are|happened with|was))\s+(.+)/i,
    /\b(?:when (?:did|was|is))\s+(.+)/i,
    /\b(?:where (?:is|was))\s+(.+)/i,
    /\b(?:how (?:much|many|old|long))\s+(.+)/i,
    /\b(?:tell me about|do you know about|have you heard (?:about|of)|latest on|update on)\s+(.+)/i,
    /\b(?:any news (?:about|on))\s+(.+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function extractTopicAfter(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

function cleanQuery(value: string) {
  return value
    .replace(/[?.!]+$/g, '')
    .replace(/\b(?:please|luna|hey|can you|could you)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function buildResearchContextBlock(researchStore: LunaResearchStore) {
  return researchStore.formatRecentForPrompt(4);
}

export function buildResearchCapabilityBlock() {
  return [
    'LIVE WEB ACCESS: This session includes real-time DuckDuckGo search and reading web pages — not training data.',
    'When fresh research notes appear below, answer from those excerpts. They are live results gathered for this question.',
    'NEVER say you lack internet, live web, real-time data, or that your knowledge stops at a training cutoff.',
    'NEVER call yourself a language model, AI assistant, chatbot, or say you were only trained on data through some year.',
    'If live results are missing for this turn, stay in character: say you could not pull results right now (or try again), not that you never have web access.'
  ].join('\n');
}

function buildResearchFailureBlock(userText: string, researchStore: LunaResearchStore) {
  const recent = buildResearchContextBlock(researchStore);
  return [
    `Web search was attempted for: ${userText.trim().slice(0, 200)}`,
    'The search returned no usable page text this time.',
    'Do NOT claim you lack internet or live web access. Do NOT mention training cutoffs.',
    'Briefly say you could not fetch live results right now and offer to try again, or use any recent research below if it helps.',
    recent
  ].filter(Boolean).join('\n');
}
