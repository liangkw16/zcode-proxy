import { describe, it, expect } from "vitest";
import { createCipher } from "./cipher.js";
import { loadCredential } from "./credential-loader.js";

const env = { ZCODE_CREDENTIAL_SECRET: "loader-secret" };
const cipher = createCipher(env);

function makeFile(entries: Record<string, string>): (p: string) => Promise<string> {
  const body = JSON.stringify(
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, cipher.encrypt(v)])),
  );
  return async () => body;
}

describe("loadCredential", () => {
  it("loads zai oauth token and family", async () => {
    const readTextFile = makeFile({ "oauth:zai:access_token": "zai-token" });
    const cred = await loadCredential({ readTextFile, homedir: "/home/u", env });
    expect(cred.family).toBe("zai");
    expect(cred.oauthAccessToken).toBe("zai-token");
  });

  it("loads bigmodel when zai absent", async () => {
    const readTextFile = makeFile({ "oauth:bigmodel:access_token": "bm-token" });
    const cred = await loadCredential({ readTextFile, homedir: "/home/u", env });
    expect(cred.family).toBe("bigmodel");
    expect(cred.oauthAccessToken).toBe("bm-token");
  });

  it("prefers zai when both present", async () => {
    const readTextFile = makeFile({
      "oauth:zai:access_token": "zai-token",
      "oauth:bigmodel:access_token": "bm-token",
    });
    const cred = await loadCredential({ readTextFile, homedir: "/home/u", env });
    expect(cred.family).toBe("zai");
  });

  it("throws a login hint when no token exists", async () => {
    const readTextFile = makeFile({});
    await expect(
      loadCredential({ readTextFile, homedir: "/home/u", env }),
    ).rejects.toThrow(/zcode login/);
  });

  it("throws a login hint when file missing", async () => {
    const readTextFile = async () => {
      throw Object.assign(new Error("enoent"), { code: "ENOENT" });
    };
    await expect(
      loadCredential({ readTextFile, homedir: "/home/u", env }),
    ).rejects.toThrow(/zcode login/);
  });
});
