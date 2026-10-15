import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { platform, userInfo } from "node:os";

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface Cipher {
  decrypt(value: string): string;
  encrypt(value: string): string;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function createCipher(
  env: Record<string, string | undefined> = process.env,
): Cipher {
  const key = createHash("sha256").update(resolveSecret(env)).digest();

  return {
    decrypt(value: string): string {
      if (!isEncrypted(value)) return value;
      const parts = value.slice(PREFIX.length).split(".");
      const [ivRaw, tagRaw, dataRaw] = parts;
      if (parts.length !== 3 || !ivRaw || !tagRaw || !dataRaw) {
        throw new Error("Credential decrypt failed: invalid ciphertext format");
      }
      const iv = Buffer.from(ivRaw, "base64url");
      const tag = Buffer.from(tagRaw, "base64url");
      const data = Buffer.from(dataRaw, "base64url");
      if (iv.length !== IV_BYTES) throw new Error("Credential decrypt failed: invalid IV length");
      if (tag.length !== AUTH_TAG_BYTES)
        throw new Error("Credential decrypt failed: invalid auth tag length");
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
      } catch (error) {
        throw new Error("Credential decrypt failed: key mismatch or corrupted ciphertext", {
          cause: error,
        });
      }
    },

    encrypt(value: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const data = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return PREFIX + [iv, tag, data].map((b) => b.toString("base64url")).join(".");
    },
  };
}

function resolveSecret(env: Record<string, string | undefined>): string {
  const configured = env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (configured) return configured;
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* packaged runtime */
  }
  return `zcode-credential-fallback:${platform()}:${env.HOME ?? "~"}:${username}`;
}
