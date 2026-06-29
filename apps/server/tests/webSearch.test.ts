import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildResearchCapabilityBlock, detectResearchIntent } from '../src/live/researchForMessage.js';

describe('detectResearchIntent', () => {
  it('includes anti-training-cutoff guidance in capability block', () => {
    const block = buildResearchCapabilityBlock();
    expect(block).toMatch(/NEVER say you lack internet/i);
    expect(block).toMatch(/training cutoff/i);
  });

  it('triggers search for explicit lookup requests', () => {
    expect(detectResearchIntent('can you look up the latest iPhone release?')?.mode).toBe('search');
    expect(detectResearchIntent('search for Elden Ring DLC news')?.mode).toBe('search');
  });

  it('triggers search for factual who/what questions', () => {
    expect(detectResearchIntent('who is the president of France?')?.mode).toBe('search');
    expect(detectResearchIntent('what happened with OpenAI yesterday?')?.mode).toBe('search');
    expect(detectResearchIntent('do you know about the new Zelda game?')?.mode).toBe('search');
  });

  it('does not search personal small talk', () => {
    expect(detectResearchIntent('how are you today?')).toBeNull();
    expect(detectResearchIntent('what do you think of me?')).toBeNull();
  });

  it('still routes news questions to rss', () => {
    const intent = detectResearchIntent("what's in the news today?");
    expect(intent?.mode).toBe('search');
    expect(intent?.deep).toBe(true);
    expect(intent?.query).toMatch(/news/i);
  });

  it('normalizes contractions for factual questions', () => {
    expect(detectResearchIntent("what's the weather like today?")?.mode).toBe('search');
  });

  it('triggers search for going-on-with phrasing', () => {
    expect(detectResearchIntent('what is going on with bitcoin right now?')?.mode).toBe('search');
  });
});

describe('searchWeb duckduckgo parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses duckduckgo html results', async () => {
    const { searchWeb } = await import('../src/research/webSearch.js');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('api.duckduckgo.com')) {
        return new Response(JSON.stringify({ AbstractText: '', Heading: '' }), { status: 200 });
      }
      if (url.includes('html.duckduckgo.com')) {
        return new Response(`
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews">Example headline</a>
          <a class="result__snippet">A short summary here.</a>
        `, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const result = await searchWeb('example query', 3, { provider: 'duckduckgo' });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('duckduckgo');
    expect(result.results?.[0]?.url).toBe('https://example.com/news');
    expect(result.results?.[0]?.title).toBe('Example headline');
  });
});
