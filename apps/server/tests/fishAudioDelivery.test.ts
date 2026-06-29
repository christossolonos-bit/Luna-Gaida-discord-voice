import { describe, expect, it } from 'vitest';
import { analyzeFishTtsDelivery, inferDefaultMoodFromReply } from '../src/live/fishAudioDelivery.js';

describe('fishAudioDelivery', () => {
  it('speeds up and boosts volume for shouting tags', () => {
    const profile = analyzeFishTtsDelivery('[shouting] Get out of here!', { baseSpeed: 1 });
    expect(profile.mode).toBe('shout');
    expect(profile.prosodySpeed).toBeGreaterThan(1);
    expect(profile.prosodyVolume).toBeGreaterThan(0);
  });

  it('slows down for sad delivery', () => {
    const profile = analyzeFishTtsDelivery('[sad][soft tone] I will miss you.', { baseSpeed: 1 });
    expect(profile.mode).toBe('sad');
    expect(profile.prosodySpeed).toBeLessThan(1);
  });

  it('uses alternate voice id when configured', () => {
    const profile = analyzeFishTtsDelivery('[shouting] No way!', {
      baseSpeed: 1,
      voiceVariants: { shout: 'voice-shout-id' }
    });
    expect(profile.referenceId).toBe('voice-shout-id');
  });

  it('infers angry mood from plain text', () => {
    expect(inferDefaultMoodFromReply('Shut up already!!!')).toBe('[angry]');
  });

  it('uses hostile voice when bond tier is hostile', () => {
    const profile = analyzeFishTtsDelivery('Whatever.', {
      baseSpeed: 1,
      relationship: 'fed up and ragebaiting them',
      voiceVariants: { hostile: '7b80df7aef1144b69644839e4e1426d9' }
    });
    expect(profile.referenceId).toBe('7b80df7aef1144b69644839e4e1426d9');
  });

  it('uses excited voice when delivery is hyped', () => {
    const profile = analyzeFishTtsDelivery('[excited] Oh my god yes!!', {
      baseSpeed: 1,
      voiceVariants: { excited: '58be4f99b95a45378a0a90179e4fe488' }
    });
    expect(profile.mode).toBe('excited');
    expect(profile.referenceId).toBe('58be4f99b95a45378a0a90179e4fe488');
  });
});
