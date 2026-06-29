import { describe, expect, it } from 'vitest';
import { resolveAvatarWardrobe, buildAvatarAwarenessPromptBlock } from '../src/live/tuziAnheiWardrobe.js';

describe('resolveAvatarWardrobe', () => {
  it('picks dark outfit for hostile bonds', () => {
    const result = resolveAvatarWardrobe({
      relationship: '- fed up; still furious with them'
    });
    expect(result.outfit).toBe('dark');
    expect(result.accessories).toContain('heifajia');
  });

  it('picks light outfit for romantic bonds', () => {
    const result = resolveAvatarWardrobe({
      relationship: '- in love; adores them'
    });
    expect(result.outfit).toBe('light');
    expect(result.accessories).toContain('huluobofajia');
  });

  it('plays outfit motion when outfit changes', () => {
    const result = resolveAvatarWardrobe({
      relationship: '- likes them; warm',
      actions: ['switches to her dark outfit'],
      previous: { outfit: 'light', accessories: [] }
    });
    expect(result.outfit).toBe('dark');
    expect(result.motion).toBe('Outfit');
  });

  it('adds accessories from actions', () => {
    const result = resolveAvatarWardrobe({
      relationship: '- warming up',
      actions: ['cat ears pop up']
    });
    expect(result.accessories).toContain('daemao');
  });

  it('builds avatar awareness with current dark look', () => {
    const block = buildAvatarAwarenessPromptBlock('- fed up; hostile', {
      outfit: 'dark',
      accessories: ['heifajia']
    });
    expect(block).toMatch(/dark gothic dress/i);
    expect(block).toMatch(/black hair clip/i);
    expect(block).toMatch(/you know what you look like/i);
  });
});
