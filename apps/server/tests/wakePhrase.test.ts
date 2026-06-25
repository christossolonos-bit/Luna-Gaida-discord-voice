import { describe, expect, it } from 'vitest';
import { containsWakePhrase, evaluateWakePhrase, isLikelyEchoTranscript, stripWakePhrases } from '../src/live/wakePhrase.js';

describe('wakePhrase', () => {
  const phrases = ['hey luna', 'hello luna'];

  it('detects wake phrases in speech', () => {
    expect(containsWakePhrase('Hey Luna, are you there?', phrases)).toBe(true);
    expect(containsWakePhrase('how is everyone doing', phrases)).toBe(false);
  });

  it('accepts common Whisper mishearings of the wake phrase', () => {
    expect(containsWakePhrase('you luna are you there', phrases)).toBe(true);
    expect(containsWakePhrase('Luna', phrases)).toBe(true);
    expect(containsWakePhrase('You', phrases)).toBe(false);
  });

  it('strips wake phrase from the prompt', () => {
    expect(stripWakePhrases('Hey Luna, are you okay?', phrases)).toBe('are you okay?');
  });

  it('requires wake phrase on every turn', () => {
    const first = evaluateWakePhrase({
      text: 'hey luna what time is it',
      phrases,
      required: true
    });
    expect(first.accepted).toBe(true);
    expect(first.text).toBe('what time is it');
    expect(first.wakeOnly).toBe(false);

    const wakeOnly = evaluateWakePhrase({
      text: 'hey luna',
      phrases,
      required: true
    });
    expect(wakeOnly.accepted).toBe(true);
    expect(wakeOnly.wakeOnly).toBe(true);

    const second = evaluateWakePhrase({
      text: 'and tomorrow?',
      phrases,
      required: true
    });
    expect(second.accepted).toBe(false);
  });

  it('rejects likely echo transcripts', () => {
    expect(isLikelyEchoTranscript('wig phrase detected')).toBe(true);
    expect(isLikelyEchoTranscript('I am doing fine today', 'I am doing fine today, thanks for asking')).toBe(true);
  });
});
