import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';

export class SecretBox {
  private key: Uint8Array | null = null;

  constructor(private readonly encodedKey: string) {}

  async ready() {
    await sodium.ready;
    const key = sodium.from_base64(this.encodedKey, sodium.base64_variants.ORIGINAL);
    if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
      throw new Error(`GIADA_MASTER_KEY must decode to ${sodium.crypto_secretbox_KEYBYTES} bytes`);
    }
    this.key = key;
  }

  encrypt(value: string) {
    const key = this.requireKey();
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const encrypted = sodium.crypto_secretbox_easy(sodium.from_string(value), nonce, key);
    return `${sodium.to_base64(nonce, sodium.base64_variants.URLSAFE_NO_PADDING)}.${sodium.to_base64(encrypted, sodium.base64_variants.URLSAFE_NO_PADDING)}`;
  }

  decrypt(value: string) {
    const key = this.requireKey();
    const [nonceValue, encryptedValue] = value.split('.');
    if (!nonceValue || !encryptedValue) throw new Error('Invalid encrypted secret');
    const nonce = sodium.from_base64(nonceValue, sodium.base64_variants.URLSAFE_NO_PADDING);
    const encrypted = sodium.from_base64(encryptedValue, sodium.base64_variants.URLSAFE_NO_PADDING);
    return sodium.to_string(sodium.crypto_secretbox_open_easy(encrypted, nonce, key));
  }

  fingerprint(value: string) {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
  }

  private requireKey() {
    if (!this.key) throw new Error('SecretBox.ready() must be called before use');
    return this.key;
  }
}
