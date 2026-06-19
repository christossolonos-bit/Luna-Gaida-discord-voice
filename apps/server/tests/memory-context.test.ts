import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryRepository } from '../src/memory/repository.js';
import { PersonalityService } from '../src/personality/service.js';
import { createToolRegistry } from '../src/tools/registry.js';

describe('Live memory context', () => {
  it('does not preload database memory into the personality instruction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'giada-memory-instruction-'));
    try {
      const personality = new PersonalityService(join(dir, 'giada.sqlite'));
      const instruction = personality.buildInstruction('browser');
      expect(instruction).not.toContain('Current memory context:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows private recall on browser but not Discord', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'giada-memory-tool-'));
    try {
      const memory = new MemoryRepository(join(dir, 'giada.sqlite'));
      memory.write({
        content: 'The private recall marker is orchid.',
        source: 'desktop',
        privacy: 'private',
        tags: ['marker']
      });
      const disabled = createToolRegistry();
      expect(disabled.some((tool) => ['writeMemory', 'retrieveMemory'].includes(String(tool.declaration.name)))).toBe(false);

      const retrieve = createToolRegistry({ memoryToolsEnabled: true })
        .find((tool) => tool.declaration.name === 'retrieveMemory');
      expect(retrieve).toBeDefined();

      const browser = await retrieve!.run({ query: 'orchid' }, { surface: 'browser', memory });
      const discord = await retrieve!.run({ query: 'orchid' }, { surface: 'discord', memory });
      expect(browser.memories).toHaveLength(1);
      expect(discord.memories).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
