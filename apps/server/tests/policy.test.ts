import { describe, expect, it } from 'vitest';
import { assertDiscordSafe, classifyText, redactSecrets } from '../src/policy/privacy.js';

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
});
