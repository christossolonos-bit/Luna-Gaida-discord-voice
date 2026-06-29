import { describe, expect, it } from 'vitest';
import { MAX_DM_TTS_CHARS, splitDmTtsText } from '../src/live/lunaDmTtsSplit.js';

describe('splitDmTtsText', () => {
  it('returns one chunk for short replies', () => {
    expect(splitDmTtsText('Hey darling, good to hear from you.')).toEqual([
      'Hey darling, good to hear from you.'
    ]);
  });

  it('splits long replies into two parts at a sentence boundary', () => {
    const first = 'A'.repeat(280) + '. ';
    const second = 'B'.repeat(280) + '.';
    const text = first + second;
    expect(text.length).toBeGreaterThan(MAX_DM_TTS_CHARS);

    const parts = splitDmTtsText(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.length).toBeLessThanOrEqual(MAX_DM_TTS_CHARS);
    expect(parts[1]!.length).toBeLessThanOrEqual(MAX_DM_TTS_CHARS);
    expect(parts.join(' ')).toContain('AAAA');
    expect(parts.join(' ')).toContain('BBBB');
  });

  it('keeps both chunks within the Fish limit', () => {
    const paragraph = `${'Word '.repeat(180).trim()}. ${'More '.repeat(180).trim()}.`;
    const parts = splitDmTtsText(paragraph);
    expect(parts.length).toBe(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_DM_TTS_CHARS);
    }
  });
});
