import { describe, expect, it } from 'vitest';
import { buildLunaDmConversationRules, pickGuildForDmUser } from '../src/live/lunaDmInbound.js';
import { detectResearchIntent } from '../src/live/researchForMessage.js';

describe('lunaDmInbound', () => {
  it('conversation rules discourage deflection and repetition', () => {
    const rules = buildLunaDmConversationRules(['Luna: Oh, my love…']);
    expect(rules).toMatch(/Answer what they actually asked first/i);
    expect(rules).toMatch(/Do not pivot to generic comfort/i);
    expect(rules).toMatch(/Do not reuse its metaphors/i);
  });

  it('picks guild with richest voice memory', () => {
    const memory = {
      get: (guildId: string) => (
        guildId === 'guild-b'
          ? { summary: 'long memory here', relationship: 'likes them' }
          : { summary: 'hi', relationship: '' }
      )
    };
    const guildId = pickGuildForDmUser(memory as never, ['guild-a', 'guild-b'], 'user-1');
    expect(guildId).toBe('guild-b');
  });

  it('returns first mutual guild when no memory store', () => {
    expect(pickGuildForDmUser(undefined, ['guild-a', 'guild-b'], 'user-1')).toBe('guild-a');
  });
});

describe('dm research intent', () => {
  it('detects casual news questions as deep search', () => {
    for (const question of [
      'have you been reading the news?',
      'what are the headlines you read?',
      'been following any headlines lately?'
    ]) {
      const intent = detectResearchIntent(question);
      expect(intent?.mode).toBe('search');
      expect(intent?.deep).toBe(true);
    }
  });
});
