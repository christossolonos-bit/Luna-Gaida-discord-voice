import { describe, expect, it } from 'vitest';
import {
  calculateNvidiaRetryDelay,
  extractMessageText,
  isRetryableNvidiaStatus
} from '../src/plugins/discord/nvidiaVision.js';

describe('NVIDIA vision response parsing', () => {
  it('returns plain string content', () => {
    expect(extractMessageText('A detailed image description.')).toBe('A detailed image description.');
  });

  it('joins OpenAI-compatible text content parts', () => {
    expect(extractMessageText([
      { type: 'text', text: 'First image.' },
      { type: 'ignored', text: 'not included' },
      { type: 'text', text: 'Second image.' }
    ])).toBe('First image.\nSecond image.');
  });

  it('retries rate limits and temporary server failures', () => {
    expect(isRetryableNvidiaStatus(429)).toBe(true);
    expect(isRetryableNvidiaStatus(503)).toBe(true);
    expect(isRetryableNvidiaStatus(400)).toBe(false);
    expect(isRetryableNvidiaStatus(401)).toBe(false);
  });

  it('honors Retry-After and otherwise uses exponential backoff', () => {
    expect(calculateNvidiaRetryDelay('2.5', 0)).toBe(2_500);
    expect(calculateNvidiaRetryDelay('120', 0)).toBe(60_000);
    expect(calculateNvidiaRetryDelay(null, 0, 0, () => 0.5)).toBe(1_000);
    expect(calculateNvidiaRetryDelay(null, 2, 0, () => 0.5)).toBe(4_000);
  });
});
