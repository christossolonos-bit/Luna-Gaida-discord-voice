import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroqTextClient } from '../src/providers/groq.js';
import type { AppConfig } from '../src/config/env.js';
import type { PlatformStore } from '../src/platform/store.js';

const config = {
  GROQ_API_URL: 'https://api.groq.test/chat/completions',
  GROQ_MODEL: 'llama-3.3-70b-versatile'
} as AppConfig;

describe('Groq text generation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries without tools when Groq generates an invalid function call', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'Failed to call a function. Please adjust your prompt.',
          code: 'tool_use_failed',
          failed_generation: '<function=sendDiscordGif>{"query":'
        }
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'Text-only reply.' } }]
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GroqTextClient(config);
    await expect(client.generate({
      apiKey: 'test-key',
      system: 'System prompt',
      userText: 'User prompt',
      tools: [{ name: 'sendDiscordGif', description: 'Send a GIF', parameters: { type: 'OBJECT' } }]
    })).resolves.toBe('Text-only reply.');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.tools).toHaveLength(1);
    expect(secondBody.tools).toBeUndefined();
  });

  it('uses another available shared key after a rate limit', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'Rate limit reached' }
      }), { status: 429, headers: { 'retry-after': '10' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'Reply from second key.' } }]
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const platform = {
      pickProviderKey: vi.fn()
        .mockResolvedValueOnce({ id: 'shared-1', value: 'first-key' })
        .mockResolvedValueOnce({ id: 'shared-2', value: 'second-key' }),
      coolDownProviderKey: vi.fn().mockResolvedValue(undefined)
    } as unknown as PlatformStore;

    const client = new GroqTextClient(config, platform);
    await expect(client.generate({
      system: 'System prompt',
      userText: 'User prompt'
    })).resolves.toBe('Reply from second key.');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(platform.pickProviderKey).toHaveBeenCalledTimes(2);
    expect(platform.coolDownProviderKey).toHaveBeenCalledWith('shared-1', 10_000);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer first-key' });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer second-key' });
  });

  it('does not resend to a rate-limited key when no different key is available', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Rate limit reached' }
    }), { status: 429, headers: { 'retry-after': '10' } }));
    vi.stubGlobal('fetch', fetchMock);
    const platform = {
      pickProviderKey: vi.fn().mockResolvedValue({ id: 'shared-1', value: 'shared-key' }),
      coolDownProviderKey: vi.fn().mockResolvedValue(undefined)
    } as unknown as PlatformStore;

    const client = new GroqTextClient(config, platform);
    await expect(client.generate({
      system: 'System prompt',
      userText: 'User prompt'
    })).rejects.toThrow('Groq HTTP 429');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(platform.pickProviderKey).toHaveBeenCalledTimes(2);
  });
});
