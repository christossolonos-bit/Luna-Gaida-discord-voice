import { describe, expect, it } from 'vitest';
import {
  bondAllowsFlirtation,
  bondAllowsPetNames,
  buildAbsencePromptBlock,
  buildCooloffRelationshipNotes,
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
    expect(buildRelationshipPromptBlock('Alex', '- fed up; mocks their bait')).toMatch(/sarcastic|thaw/i);
  });

  it('lets hostile bonds recover when the first bullet softens', () => {
    expect(inferBondTier('- softening; they apologized sincerely\n- still wary from before')).toBe('cool');
    expect(inferBondTier('- forgiving; giving them another chance')).toBe('warming');
    expect(inferBondTier('- less angry; they owned it')).toBe('annoyed');
  });

  it('builds absence mood guidance after hours away', () => {
    expect(buildAbsencePromptBlock('Alex', '- fed up; still angry', 5, 3)).toMatch(/5 hours/i);
    expect(buildAbsencePromptBlock('Alex', '- fed up; still angry', 5, 3)).toMatch(/conflicted/i);
    expect(buildAbsencePromptBlock('Alex', '- adores them', 6, 3)).toMatch(/noticed they were gone/i);
    expect(buildAbsencePromptBlock('Alex', null, 2, 3)).toBeNull();
  });

  it('cooloff notes feel like morning-after calm, not amnesia', () => {
    const notes = buildCooloffRelationshipNotes();
    expect(inferBondTier(notes)).toBe('cool');
    expect(notes).toMatch(/remembers the fight/i);
    expect(notes).toMatch(/cooled off/i);
  });
});
