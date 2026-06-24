import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateNvidiaRetryDelay,
  extractMessageText,
  generateDiscordTextWithNvidia,
  isRetryableNvidiaStatus,
  toOpenAiToolDeclaration
} from '../src/plugins/discord/nvidiaVision.js';
import type { AppConfig } from '../src/config/env.js';

describe('NVIDIA vision response parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('converts Gemini declarations to OpenAI-compatible tools', () => {
    expect(toOpenAiToolDeclaration({
      name: 'exampleTool',
      description: 'Example.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING' },
          tags: { type: 'ARRAY', items: { type: 'STRING' } }
        }
      }
    })).toEqual({
      type: 'function',
      function: {
        name: 'exampleTool',
        description: 'Example.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    });
  });

  it('executes a side-effect tool once and disables tools on the follow-up round', async () => {
    const toolCall = {
      id: 'gif-1',
      type: 'function',
      function: { name: 'sendDiscordGif', arguments: '{"query":"happy dance"}' }
    };
    const duplicateToolCall = { ...toolCall, id: 'gif-2' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [toolCall, duplicateToolCall] }, finish_reason: 'tool_calls' }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }]
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const execute = vi.fn(async (calls: typeof toolCall[]) => calls.map((call) => ({
      id: call.id,
      name: call.function.name,
      response: { ok: true }
    })));

    await expect(generateDiscordTextWithNvidia({
      NVIDIA_NIM_URL: 'https://nvidia.test/chat/completions',
      NVIDIA_IMAGE_MODEL: 'moonshotai/kimi-k2.6',
      nvidiaApiKey: 'test-key'
    } as AppConfig & { nvidiaApiKey: string }, 'System', [{ text: 'User' }], true, {
      declarations: [{ name: 'sendDiscordGif', parameters: { type: 'OBJECT' } }],
      execute
    })).resolves.toBe('Done.');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toHaveLength(1);
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody.tools).toBeUndefined();
  });
});
