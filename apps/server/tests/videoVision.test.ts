import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AppConfig } from '../src/config/env.js';
import { describeVideoSnapshots } from '../src/research/videoVision.js';

const baseConfig = {
  ollamaApiUrl: 'http://127.0.0.1:11434/v1/chat/completions',
  ollamaModel: 'qwen3.5:4b',
  ollamaVisionModel: 'qwen3.5:4b',
  ollamaTimeoutMs: 30_000,
  ollamaReasoningEffort: 'none',
  lunaVideoVisionProvider: 'ollama'
} as AppConfig;

describe('videoVision', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('describes snapshots through Ollama vision', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        message: { content: 'A gameplay scene with a boss fight and health bars.' }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const description = await describeVideoSnapshots(
      baseConfig,
      [{ label: 'Snapshot at 10s', jpeg: Buffer.from('fake-jpeg') }],
      'Cool Boss Fight'
    );

    expect(description).toContain('boss fight');
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe('qwen3.5:4b');
    expect(body.messages[1].images).toHaveLength(1);
  });
});
