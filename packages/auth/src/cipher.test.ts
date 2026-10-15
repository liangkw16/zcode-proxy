import { describe, it, expect } from "vitest";
import { createCipher } from "./cipher.js";

const env = { ZCODE_CREDENTIAL_SECRET: "unit-test-secret" };

describe("cipher", () => {
  it("round-trips plaintext via encrypt/decrypt", () => {
    const cipher = createCipher(env);
    const enc = cipher.encrypt("hello-token");
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(cipher.decrypt(enc)).toBe("hello-token");
  });

  it("returns non-encrypted values unchanged", () => {
    const cipher = createCipher(env);
    expect(cipher.decrypt("plain")).toBe("plain");
  });

  it("fails to decrypt with the wrong secret", () => {
    const enc = createCipher(env).encrypt("secret-value");
    const other = createCipher({ ZCODE_CREDENTIAL_SECRET: "different" });
    expect(() => other.decrypt(enc)).toThrow(/decrypt failed/i);
  });

  it("rejects malformed ciphertext", () => {
    const cipher = createCipher(env);
    expect(() => cipher.decrypt("enc:v1:bad.format")).toThrow();
  });
});
