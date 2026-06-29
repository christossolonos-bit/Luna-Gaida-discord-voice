import { describe, expect, it } from 'vitest';
import {
  parseLunaInitiativeReply,
  summarizeVibeSignals
} from '../src/live/lunaInitiative.js';

describe('lunaInitiative', () => {
  it('parses letting the vibe ride', () => {
    const result = parseLunaInitiativeReply(
      '{"vibe":"chill and jokey","changeVibe":false,"speak":false,"reason":"good energy"}'
    );
    expect(result).toEqual({
      vibe: 'chill and jokey',
      changeVibe: false,
      speak: false,
      line: null,
      reason: 'good energy'
    });
  });

  it('parses vibe shift with a line', () => {
    const result = parseLunaInitiativeReply(
      '{"vibe":"awkward quiet","changeVibe":true,"speak":true,"line":"Okay it\'s too quiet — someone say something or I will.","reason":"breaking the silence"}'
    );
    expect(result).toEqual({
      vibe: 'awkward quiet',
      changeVibe: true,
      speak: true,
      line: "Okay it's too quiet — someone say something or I will.",
      reason: 'breaking the silence'
    });
  });

  it('forces silence when changeVibe is false even if speak true', () => {
    const result = parseLunaInitiativeReply(
      '{"vibe":"cozy","changeVibe":false,"speak":true,"line":"hey"}'
    );
    expect(result?.speak).toBe(false);
    expect(result?.changeVibe).toBe(false);
  });

  it('summarizes room signals', () => {
    const summary = summarizeVibeSignals({
      silenceSec: 90,
      recentExchanges: ['Alex: lol', 'Luna: yeah'],
      participantCount: 2,
      trigger: 'vibe_check'
    });
    expect(summary).toMatch(/Noticeable quiet/);
    expect(summary).toMatch(/2 people/);
  });

  it('notes when Luna overheard live conversation', () => {
    const summary = summarizeVibeSignals({
      silenceSec: 2,
      recentExchanges: [],
      overheardConversation: ['Alex: bro did you see that', 'Sam: yeah wild'],
      participantCount: 3,
      trigger: 'vibe_check'
    });
    expect(summary).toMatch(/just listened to live conversation/i);
  });
});
