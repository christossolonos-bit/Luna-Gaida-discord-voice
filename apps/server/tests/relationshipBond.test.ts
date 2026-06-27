import { describe, expect, it } from 'vitest';
import {
  bondAllowsFlirtation,
  bondAllowsPetNames,
  buildRelationshipPromptBlock,
  inferBondTier
} from '../src/memory/relationshipBond.js';

describe('relationshipBond', () => {
  it('treats empty notes as stranger', () => {
    expect(inferBondTier(null)).toBe('stranger');
    expect(bondAllowsFlirtation('stranger')).toBe(false);
    expect(bondAllowsPetNames('stranger')).toBe(false);
    expect(buildRelationshipPromptBlock('Alex', null)).toMatch(/stranger/i);
    expect(buildRelationshipPromptBlock('Alex', null)).toMatch(/No pet names/i);
  });

  it('requires bonded notes before flirtation', () => {
    expect(inferBondTier('- warming up; likes their humor')).toBe('warming');
    expect(bondAllowsFlirtation('warming')).toBe(false);
    expect(inferBondTier('- adores them; strong flirt dynamic')).toBe('bonded');
    expect(bondAllowsFlirtation('bonded')).toBe(true);
  });

  it('reserves pet names for romantic tier', () => {
    expect(bondAllowsPetNames('bonded')).toBe(false);
    expect(inferBondTier('- in love; calls them darling')).toBe('romantic');
    expect(bondAllowsPetNames('romantic')).toBe(true);
  });

  it('detects negative bonds and hostile tier', () => {
    expect(inferBondTier('- fed up; ragebaiting them back')).toBe('hostile');
    expect(inferBondTier('- irritates me; talking down to me')).toBe('annoyed');
    expect(inferBondTier('- pulled back; staying distant')).toBe('cool');
    expect(buildRelationshipPromptBlock('Alex', '- fed up; mocks their bait')).toMatch(/fed up/i);
    expect(buildRelationshipPromptBlock('Alex', '- fed up; mocks their bait')).toMatch(/sarcastic/i);
  });
});
