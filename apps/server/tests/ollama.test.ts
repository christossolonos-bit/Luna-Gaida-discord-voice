import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaTextClient } from '../src/providers/ollamaText.js';
import type { AppConfig } from '../src/config/env.js';

const config = {
  ollamaApiUrl: 'http://127.0.0.1:11434/v1/chat/completions',
  ollamaModel: 'qwen3.5:4b',
  ollamaTimeoutMs: 30_000,
  ollamaReasoningEffort: 'none'
} as AppConfig;

describe('Ollama text generation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the Ollama chat completions endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'Hello from Luna.' } }]
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new OllamaTextClient(config);
    await expect(client.generate({
      system: 'You are Luna.',
      userText: 'Hi'
    })).resolves.toBe('Hello from Luna.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(config.ollamaApiUrl);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer ollama' });
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('qwen3.5:4b');
    expect(body.reasoning_effort).toBe('none');
  });
});
