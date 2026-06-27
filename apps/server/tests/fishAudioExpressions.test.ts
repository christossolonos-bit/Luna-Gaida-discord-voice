import { describe, expect, it } from 'vitest';
import {
  enrichFishTtsText,
  mapActionToFishTags,
  relationshipToFishMood,
  stripFishAudioTagsForDisplay
} from '../src/live/fishAudioExpressions.js';
import { buildFishTtsFromReply } from '../src/live/voiceActions.js';

describe('fishAudioExpressions', () => {
  it('maps roleplay actions to Fish tags', () => {
    expect(mapActionToFishTags('*laughs*')).toEqual(['[laughing]']);
    expect(mapActionToFishTags('whispers softly')).toEqual(['[whispering]', '[soft tone]']);
    expect(mapActionToFishTags('ears perk up')).toEqual(['[excited]', '[slightly higher pitch]']);
  });

  it('strips tags for UI display', () => {
    expect(stripFishAudioTagsForDisplay('[happy] Hello there!')).toBe('Hello there!');
  });

  it('enriches sentences with relationship mood', () => {
    const out = enrichFishTtsText('What do you want?', {
      relationship: 'She adores him and flirts constantly.'
    });
    expect(out).toMatch(/^\[flirty\]/);
    expect(out).toContain('What do you want?');
  });

  it('builds tagged TTS from LLM reply with asterisk actions', () => {
    const { ttsText, displayText, actions } = buildFishTtsFromReply(
      '[curious] Really? *giggles* That is wild.',
      { relationship: 'playful and warm' }
    );
    expect(actions).toEqual(['giggles']);
    expect(ttsText).toContain('[laughing]');
    expect(ttsText).toContain('That is wild.');
    expect(displayText).not.toContain('[');
    expect(displayText).not.toContain('giggles');
  });

  it('derives cold mood from distant relationships', () => {
    expect(relationshipToFishMood('tolerates him but stays distant')).toContain('[cold tone]');
  });
});
