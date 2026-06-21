import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/platform/secrets.js';

describe('encrypted provider credentials', () => {
  it('round-trips without storing plaintext and exposes a short fingerprint', async () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));
    await box.ready();
    const encrypted = box.encrypt('provider-secret-value');
    expect(encrypted).not.toContain('provider-secret-value');
    expect(box.decrypt(encrypted)).toBe('provider-secret-value');
    expect(box.fingerprint('provider-secret-value')).toMatch(/^[a-f0-9]{12}$/);
  });

  it('rejects an invalid deployment key length', async () => {
    const box = new SecretBox(randomBytes(8).toString('base64'));
    await expect(box.ready()).rejects.toThrow('GIADA_MASTER_KEY');
  });
});
