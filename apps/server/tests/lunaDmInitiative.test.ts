import { describe, expect, it } from 'vitest';
import { parseLunaDmReply } from '../src/live/lunaDmInitiative.js';

describe('lunaDmInitiative', () => {
  it('parses send=false', () => {
    const result = parseLunaDmReply('{"send":false,"reason":"not now"}');
    expect(result).toEqual({ send: false, userId: null, message: null, reason: 'not now' });
  });

  it('parses send=true with user and message', () => {
    const result = parseLunaDmReply(
      '{"send":true,"userId":"123","message":"Hey — still thinking about that thing you mentioned."}'
    );
    expect(result).toEqual({
      send: true,
      userId: '123',
      message: 'Hey — still thinking about that thing you mentioned.',
      reason: null
    });
  });

  it('rejects empty messages', () => {
    const result = parseLunaDmReply('{"send":true,"userId":"123","message":""}');
    expect(result?.send).toBe(false);
  });
});
