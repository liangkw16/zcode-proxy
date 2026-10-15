import { join } from "node:path";
import { createCipher } from "./cipher.js";
import type { Family } from "./endpoints.js";

const ZAI_KEY = "oauth:zai:access_token";
const BM_KEY = "oauth:bigmodel:access_token";

export interface LoadedCredential {
  family: Family;
  oauthAccessToken: string;
}

export interface LoaderDeps {
  readTextFile: (path: string) => Promise<string>;
  homedir: string;
  env?: Record<string, string | undefined>;
}

export function credentialsPath(homedir: string): string {
  return join(homedir, ".zcode", "v2", "credentials.json");
}

export async function loadCredential(deps: LoaderDeps): Promise<LoadedCredential> {
  const env = deps.env ?? process.env;
  const path = credentialsPath(deps.homedir);
  let raw: string;
  try {
    raw = await deps.readTextFile(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error("未找到 ZCode 登录态，请先运行 `zcode login`");
    }
    throw error;
  }

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error("ZCode 凭证文件已损坏，请先在 ZCode 中重新登录");
  }

  const cipher = createCipher(env);
  const zai = readEncrypted(record, ZAI_KEY, cipher);
  const bm = readEncrypted(record, BM_KEY, cipher);

  if (zai) return { family: "zai", oauthAccessToken: zai };
  if (bm) return { family: "bigmodel", oauthAccessToken: bm };
  throw new Error("未找到 ZCode 登录 Token，请先运行 `zcode login`");
}

function readEncrypted(
  record: Record<string, unknown>,
  key: string,
  cipher: ReturnType<typeof createCipher>,
): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const plain = cipher.decrypt(value).trim();
  return plain.length ? plain : null;
}
