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
  readTrustedUserLinks
} from '../research/trustedLinkSharing.js';
import { logger } from '../logging/logger.js';

const URL_RE = /https?:\/\/[^\s<>"')]+/i;

const NEWS_RE = /\b(?:latest|recent|today'?s?|current)\s+news\b|\bheadlines?\b|\bwhat(?:'s| is) (?:happening|in the news)\b|\b(?:reading|read|follow(?:ing)?)\s+(?:the\s+)?(?:news|headlines)\b|\b(?:been\s+)?(?:reading|following)\s+(?:any\s+)?(?:news|headlines)\b/i;
const SEARCH_RE = /\b(?:look up|search(?:\s+for)?|google|find out(?:\s+about)?|read about)\b/i;
const ASK_RE = /\b(?:tell me about|what (?:is|are)|who is|who are|explain)\s+(.+)/i;

export async function buildMessageResearchBlock(
  config: AppConfig,
  userText: string,
  researchStore: LunaResearchStore,
  context?: ConversationResearchContext,
  sender?: LinkSenderIdentity
): Promise<string | null> {
  const parts: string[] = [];

  if (sender) {
    const trustedLinks = await readTrustedUserLinks(config, userText, researchStore, sender);
    if (trustedLinks) parts.push(trustedLinks);
  } else {
    const voiceChatLinks = await readTrustedLinksFromVoiceTextChat(config, userText, researchStore);
    if (voiceChatLinks) parts.push(voiceChatLinks);
  }

  const other = await maybeResearchForUserMessage(config, userText, researchStore, context, { skipUrlIntent: true });
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
      preferDigest: enhanced.preferDigest
    });
    if (!finding) return null;

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
      'Fresh web research for this reply (ground your answer in this — do not invent facts beyond it):',
      topicHint,
      formatResearchFindingBlock(finding)
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

export function detectResearchIntent(userText: string, skipUrlIntent = false): { mode: LunaResearchMode; query?: string; url?: string } | null {
  const text = userText.trim();
  if (!text) return null;

  if (!skipUrlIntent) {
    const urlMatch = text.match(URL_RE);
    if (urlMatch?.[0]) {
      return { mode: 'read', url: urlMatch[0] };
    }
  }

  if (NEWS_RE.test(text)) {
    const topic = extractTopicAfter(text, /\b(?:about|on)\s+(.+)/i);
    return topic ? { mode: 'rss', query: topic } : { mode: 'rss' };
  }

  if (SEARCH_RE.test(text)) {
    const query = extractTopicAfter(text, SEARCH_RE) ?? text;
    return { mode: 'search', query: cleanQuery(query) };
  }

  const askMatch = text.match(ASK_RE);
  if (askMatch?.[1]) {
    const subject = cleanQuery(askMatch[1]);
    if (subject.length >= 3 && looksLikeFactualQuestion(text)) {
      return { mode: 'search', query: subject };
    }
  }

  return null;
}

function looksLikeFactualQuestion(text: string) {
  if (/\b(?:your|you|my|our)\b/i.test(text) && !/\b(?:news|world|country|company|game|movie|show)\b/i.test(text)) {
    return false;
  }
  return /\b(?:news|latest|current|today|who is|what is|what are|explain|happened|release|price|weather)\b/i.test(text)
    || text.length > 40;
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
