import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalityService } from '../src/personality/service.js';
import { assertDiscordSafe, classifyText, redactSecrets, sanitizeForDiscord } from '../src/policy/privacy.js';

describe('privacy policy', () => {
  it('classifies obvious credentials as secret', () => {
    expect(classifyText('GEMINI_API_KEY=abc123456789abcdef')).toBe('secret');
  });

  it('redacts secret-like values', () => {
    expect(redactSecrets('token: abcdefghijklmnopqrstuvwxyz123')).toContain('[REDACTED_SECRET]');
  });

  it('prevents Discord leakage after redaction pass', () => {
    const result = assertDiscordSafe('my local file is /Users/alice/private/secrets.txt');
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain('/Users/alice');
  });

  it('removes hidden think blocks from Discord output', () => {
    expect(sanitizeForDiscord('<think>private reasoning</think>Hello')).toBe('Hello');
  });

  it('removes dangling hidden think blocks from Discord output', () => {
    expect(sanitizeForDiscord('Hello\n<think>private reasoning')).toBe('Hello');
  });
});

describe('personality boundaries', () => {
  it('allows NSFW on web but gates Discord NSFW by channel setting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'giada-personality-'));
    try {
      const personality = new PersonalityService(join(dir, 'giada.sqlite'));
      const webInstruction = personality.buildInstruction('browser');
      const discordSafeInstruction = personality.buildInstruction('discord', { discordNsfwAllowed: false });
      const discordNsfwInstruction = personality.buildInstruction('discord', { discordNsfwAllowed: true });

      expect(webInstruction).toContain('Web/browser surface: NSFW adult content is allowed');
      expect(discordSafeInstruction).toContain('this channel is not marked age-restricted/NSFW');
      expect(discordNsfwInstruction).toContain('this channel is marked age-restricted/NSFW');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
