import { describe, expect, it } from 'vitest';
import { parseFeedXml } from '../src/research/rssReader.js';
import { parseLunaCuriosityReply } from '../src/live/lunaCuriosity.js';

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
