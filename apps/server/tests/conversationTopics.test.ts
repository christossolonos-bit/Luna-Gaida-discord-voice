import { describe, expect, it } from 'vitest';
import { buildConversationSearchQuery } from '../src/research/conversationTopics.js';
import { wrapQueryForConversation } from '../src/research/lunaResearchRunner.js';

describe('conversationTopics', () => {
  it('builds join queries from interest rotation', () => {
    const query = buildConversationSearchQuery({
      trigger: 'join',
      participantNames: ['Alex'],
      recentExchanges: []
    });
    expect(query).toMatch(/AI|gaming|vtuber|science|entertainment|interesting|facts/i);
  });

  it('builds boredom pivot queries from stale chat', () => {
    const query = buildConversationSearchQuery({
      trigger: 'vibe_check',
      participantNames: ['Alex'],
      recentExchanges: [
        'Alex: yeah same thing again',
        'Luna: mm',
        'Alex: still talking about that one game mode for twenty minutes'
      ]
    });
    expect(query).toMatch(/change the subject|conversation topics/i);
  });

  it('wraps search queries for conversation purpose', () => {
    expect(wrapQueryForConversation('mars rover', 'conversation')).toMatch(/conversation topics/i);
    expect(wrapQueryForConversation('mars rover', 'general')).toBe('mars rover');
  });
});
