import { describe, expect, it } from 'vitest';
import { parseFeedXml } from '../src/research/rssReader.js';
import { parseLunaCuriosityReply } from '../src/live/lunaCuriosity.js';
import { formatResearchFindingBlock } from '../src/research/lunaResearchRunner.js';

describe('rssReader', () => {
  it('parses RSS items', () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <item><title>Hello World</title><link>https://example.com/a</link><description>Summary here</description></item>
      </channel></rss>`;
    const items = parseFeedXml(xml, 5);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Hello World');
    expect(items[0]?.link).toBe('https://example.com/a');
  });
});

describe('lunaCuriosity', () => {
  it('parses explore=false', () => {
    const result = parseLunaCuriosityReply('{"explore":false,"reason":"not now"}');
    expect(result?.explore).toBe(false);
  });

  it('parses explore=true search', () => {
    const result = parseLunaCuriosityReply('{"explore":true,"mode":"search","query":"latest mars rover news"}');
    expect(result).toEqual({
      explore: true,
      mode: 'search',
      query: 'latest mars rover news',
      url: null,
      reason: null
    });
  });
});

describe('formatResearchFindingBlock', () => {
  it('tells Luna to answer directly instead of listing headlines', () => {
    const block = formatResearchFindingBlock({
      mode: 'search',
      query: 'mars rover',
      url: 'https://example.com',
      title: 'Deep research: mars rover',
      summary: '### Article\nSource: https://example.com\n\nRover found ice.',
      source: 'duckduckgo'
    }, 'what did the mars rover find?');

    expect(block).toMatch(/User question: what did the mars rover find\?/i);
    expect(block).toMatch(/Do not reply with only headlines/i);
    expect(block).toMatch(/Rover found ice/);
  });
});
