import { describe, expect, it } from 'vitest';
import {
  extractUrls,
  isTrustedLinkSender,
  readTrustedUserLinks
} from '../src/research/trustedLinkSharing.js';
import type { AppConfig } from '../src/config/env.js';

const baseConfig = {
  lunaResearchEnabled: true,
  GIADA_OWNER_DISCORD_USER_ID: 'owner-123',
  lunaLinkTrustedSenders: ['solonaras', 'travis'],
  lunaResearchMaxReadChars: 6000
} as AppConfig;

describe('trustedLinkSharing', () => {
  it('extracts urls from messages', () => {
    expect(extractUrls('check this https://example.com/article and https://foo.bar/x')).toEqual([
      'https://example.com/article',
      'https://foo.bar/x'
    ]);
  });

  it('trusts owner id and configured names', () => {
    expect(isTrustedLinkSender(baseConfig, { userId: 'owner-123' })).toBe(true);
    expect(isTrustedLinkSender(baseConfig, {
      userId: 'other',
      username: 'travis_dev',
      displayName: 'Travis'
    })).toBe(true);
    expect(isTrustedLinkSender(baseConfig, {
      userId: 'other',
      username: 'random_user',
      displayName: 'Alex'
    })).toBe(false);
  });

  it('reads links for any sender when research is enabled', async () => {
    const result = await readTrustedUserLinks(
      baseConfig,
      'see https://example.com',
      null,
      { userId: 'x', username: 'alex', displayName: 'Alex' }
    );
    expect(result).toContain('https://example.com');
  });
});
