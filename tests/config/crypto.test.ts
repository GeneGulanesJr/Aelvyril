import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../src/config/crypto.js';

describe('crypto', () => {
  it('encrypts and decrypts a string', () => {
    const original = 'sk-test-api-key-12345';
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted).toContain(':');
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(original);
  });

  it('produces different ciphertext for same plaintext', () => {
    const original = 'sk-test-key';
    const enc1 = encrypt(original);
    const enc2 = encrypt(original);
    expect(enc1).not.toBe(enc2);
    expect(decrypt(enc1)).toBe(original);
    expect(decrypt(enc2)).toBe(original);
  });

  it('throws on invalid ciphertext', () => {
    expect(() => decrypt('invalid')).toThrow();
  });
});
