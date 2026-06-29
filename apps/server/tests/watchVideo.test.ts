import { describe, expect, it } from 'vitest';
import { captionTextToPlain, extractYoutubeVideoId, isVideoUrl, json3ToText, pickFrameTimestamps, srtToText, vttToText } from '../src/research/watchVideo.js';

describe('watchVideo', () => {
  it('detects common video hosts', () => {
    expect(isVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(isVideoUrl('https://www.twitch.tv/videos/123')).toBe(true);
    expect(isVideoUrl('https://example.com/article')).toBe(false);
  });

  it('converts vtt captions to plain text', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello everyone

00:00:03.500 --> 00:00:06.000
Today we talk about AI`;
    expect(vttToText(vtt)).toBe('Hello everyone Today we talk about AI');
    expect(captionTextToPlain(vtt)).toBe('Hello everyone Today we talk about AI');
  });

  it('converts youtube json3 captions to plain text', () => {
    const json3 = JSON.stringify({
      events: [
        { segs: [{ utf8: 'Hello everyone\n' }] },
        { segs: [{ utf8: 'Today we talk about AI' }] }
      ]
    });
    expect(json3ToText(json3)).toBe('Hello everyone Today we talk about AI');
    expect(captionTextToPlain(json3)).toBe('Hello everyone Today we talk about AI');
  });

  it('picks spread-out frame timestamps', () => {
    const stamps = pickFrameTimestamps(100, 3);
    expect(stamps).toHaveLength(3);
    expect(stamps[0]).toBeGreaterThanOrEqual(0.5);
    expect(stamps[2]).toBeLessThan(100);
  });

  it('extracts youtube video ids', () => {
    expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYoutubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
});
