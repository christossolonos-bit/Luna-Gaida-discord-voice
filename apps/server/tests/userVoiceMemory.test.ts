import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCooloffRelationshipNotes } from '../src/memory/relationshipBond.js';
import { UserVoiceMemoryStore } from '../src/memory/userVoiceMemory.js';

describe('UserVoiceMemoryStore reset feelings', () => {
  it('replaces relationship with cooloff notes but keeps facts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luna-mem-'));
    const dbPath = join(dir, 'test.sqlite');
    const store = new UserVoiceMemoryStore(dbPath);

    store.save('g1', 'u1', 'Alex', '- likes pizza\n- works nights');
    store.saveRelationship('g1', 'u1', 'Alex', '- fed up; furious with them');

    const updated = store.resetFeelingsToCooloff('g1', 'u1', buildCooloffRelationshipNotes());
    expect(updated?.relationship).toMatch(/cooled off/i);
    expect(updated?.summary).toMatch(/pizza/i);
    expect(updated?.summary).not.toMatch(/furious/i);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deleteCaller removes all saved notes for a user', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luna-mem-'));
    const dbPath = join(dir, 'test.sqlite');
    const store = new UserVoiceMemoryStore(dbPath);

    store.save('g1', 'u1', 'Alex', '- likes pizza');
    store.saveRelationship('g1', 'u1', 'Alex', '- close friend');

    expect(store.deleteCaller('g1', 'u1')).toBe(true);
    expect(store.get('g1', 'u1')).toBeNull();
    expect(store.deleteCaller('g1', 'u1')).toBe(false);

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
