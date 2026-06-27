import { describe, expect, it } from 'vitest';
import { INTEREST_BROWSE_CATEGORIES, planInterestBrowse } from '../src/research/interestBrowse.js';
import { LunaResearchStore } from '../src/memory/lunaResearchStore.js';

describe('interestBrowse', () => {
  it('exposes neuro-sama style interest categories', () => {
    const labels = INTEREST_BROWSE_CATEGORIES.map((category) => category.label).join(' ');
    expect(labels).toMatch(/AI/i);
    expect(labels).toMatch(/Gaming/i);
    expect(labels).toMatch(/VTuber/i);
    expect(labels).toMatch(/World news/i);
  });

  it('prioritizes user conversation topics', () => {
    const mockStore = { recent: () => [] } as LunaResearchStore;
    const plan = planInterestBrowse(
      ['Alex: I have been playing Elden Ring all week'],
      [],
      mockStore
    );
    expect(plan.category).toBe('user_interest');
    expect(plan.query).toMatch(/elden ring/i);
  });

  it('rotates away from recently covered categories', () => {
    const mockStore = {
      recent: () => [{
        id: 1,
        source: 'curiosity',
        mode: 'search',
        query: 'interesting AI artificial intelligence news and trends 2026 discussion',
        url: null,
        title: 'New AI model release',
        summary: 'Labs keep shipping.',
        createdAt: new Date().toISOString()
      }]
    } as LunaResearchStore;

    const plan = planInterestBrowse([], [], mockStore);
    expect(plan.category).not.toBe('ai');
  });
});
