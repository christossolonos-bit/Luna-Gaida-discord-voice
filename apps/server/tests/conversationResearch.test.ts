import { describe, expect, it } from 'vitest';
import {
  buildConversationResearchQuery,
  enhanceResearchIntent,
  extractTopicsFromConversation,
  queryIsOffConversationTopic,
  queryOverlapsRecentResearch,
  suggestCuriosityResearch
} from '../src/research/conversationResearch.js';
import { LunaResearchStore } from '../src/memory/lunaResearchStore.js';

describe('conversationResearch', () => {
  it('extracts topics from recent chat and voice memory', () => {
    const topics = extractTopicsFromConversation({
      recentLines: [
        'Travis: have you been playing Elden Ring lately?',
        'Luna: not recently',
        'Travis: what about the new expansion news?'
      ],
      voiceMemorySummary: '- Travis loves sci-fi films\n- talks about cooking a lot',
      currentMessage: 'what are the headlines you read?'
    });
    expect(topics.some((topic) => /elden ring/i.test(topic) || /expansion/i.test(topic))).toBe(true);
  });

  it('builds search queries from conversation context', () => {
    const query = buildConversationResearchQuery({
      recentLines: ['Travis: been watching Dune Part Two again'],
      displayName: 'Travis'
    });
    expect(query).toMatch(/Dune/i);
    expect(query).toMatch(/news|recent/i);
  });

  it('prefers conversation topics over generic headlines', () => {
    const enhanced = enhanceResearchIntent(
      { mode: 'rss' },
      {
        recentLines: ['Travis: tell me about the new Zelda game'],
        currentMessage: 'have you been reading the news?'
      },
      undefined
    );
    expect(enhanced.query).toMatch(/zelda/i);
    expect(enhanced.preferDigest).toBe(false);
  });

  it('uses headline digest when no conversation topics exist', () => {
    const enhanced = enhanceResearchIntent({ mode: 'rss' }, { recentLines: [] }, undefined);
    expect(enhanced.preferDigest).toBe(true);
  });

  it('suggests fresh curiosity research outside covered topics', () => {
    const mockStore = {
      recent: () => [{
        id: 1,
        source: 'curiosity',
        mode: 'rss',
        query: 'iran',
        url: null,
        title: 'Iran tensions escalate in Strait of Hormuz',
        summary: 'Military buildup continues near shipping lanes.',
        createdAt: new Date().toISOString()
      }]
    } as LunaResearchStore;

    const suggestion = suggestCuriosityResearch(
      ['Travis: I started learning guitar again'],
      ['Travis: enjoys metal music'],
      mockStore
    );
    expect(suggestion.query).toMatch(/guitar|metal/i);
  });

  it('blocks autonomous geopolitics not in conversation', () => {
    expect(queryIsOffConversationTopic(
      'latest Iran cargo ship strike reaction',
      [],
      ['Solonaras: welcome to the channel']
    )).toBe(true);
    expect(queryIsOffConversationTopic(
      'latest Iran updates',
      ['Travis: what is happening in Iran?'],
      []
    )).toBe(false);
  });
});
