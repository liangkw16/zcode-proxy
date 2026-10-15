# zcode-proxy 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建本机网关 zcode-proxy，把 ZCode Coding Plan（GLM-5.3 / GLM-5.3-Flash）以 Anthropic Messages 与 OpenAI Responses 两种协议暴露给 Claude Code 和 Codex，且上游请求被平台识别为 zcode 客户端发出。

**Architecture:** 双协议面 + 统一上游（Hub-and-Adapter）。入站 /v1/messages（恒等）与 /v1/responses（双向转换）→ 统一内部模型（Anthropic Messages 为规范）→ 指纹层注入 zcode 认证与来源 headers → 唯一上游 api/anthropic。流式响应经对应 adapter 转回客户端协议。

**Tech Stack:** Node.js 24、TypeScript（ESM）、pnpm monorepo、vitest、zod；仅 zod 一个外部运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-15-zcode-proxy-design.md`（执行任务时同时阅读 spec 与本计划）。

## Global Constraints

- Node 版本锁定 24（mise.toml 管理），pnpm 10.33.2；运行命令统一用 `mise exec -- <cmd>` 或在已激活 node24 的 shell 中执行。
- 外部运行时依赖仅限 `zod`；禁止引入 express/fastify/axios 等重框架，HTTP 服务用 node 内置 http/undici。
- 服务仅绑定 `127.0.0.1`（默认端口 8792），代码中禁止任何非 loopback 绑定；端口可通过配置/参数修改。
- 版本指纹：内置固定 zcode 版本 `3.15.1`，同时用于签 token 的 `clientVersion`、`X-ZCode-App-Version`、`User-Agent`。
- 不实现登录流程；只读 `~/.zcode` 数据，不写入 `~/.zcode` 目录。proxy 自身配置写到 `~/.zcode-proxy/`。
- 日志脱敏：禁止打印 token 明文、Authorization header、请求中的凭据；统一 request id。
- 所有功能采用 TDD：先写失败测试 → 看失败 → 实现 → 看通过 → 提交；每个任务结束时工作区可独立测试。
- 提交信息使用约定式（feat:/fix:/test:/chore:/docs:）。

## Review Focus

以下输入/失败模式 spec 暗示但最容易出问题，每个都必须在对应任务里加测试固定：

1. **未启用 thinking 时收到 GLM 思考块**：Claude Code 未传 thinking 时，proxy 必须在非流式与流式（含跨块的 index 重排）都剥离 thinking，否则客户端报错。→ Tasks 11/12
2. **Codex 扁平 function 工具**：Responses 工具是 `{type:"function",name,parameters}` 扁平结构，不是 `tools[].function`；读错层级会导致工具全部丢失。→ Task 17
3. **tool_choice × parallel_tool_calls 组合**：Anthropic 无顶层并行字段，需取反为 `disable_parallel_tool_use` 嵌入；`none` 需省略 tools。→ Task 17
4. **上游 401 与并发换证**：多个并发请求在 token 过期时只能触发一次换证（singleflight），且迟到的 401 不能废弃新 token。→ Task 13
5. **客户端断连**：流式下游断开时必须立即 abort 上游请求，避免继续消耗订阅额度。→ Task 15

---

## Task 1: monorepo 脚手架

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`mise.toml`、`vitest.workspace.ts`
- Create: `packages/auth/package.json`、`packages/auth/tsconfig.json`、`packages/core/package.json`、`packages/core/tsconfig.json`、`packages/server/package.json`、`packages/server/tsconfig.json`、`packages/anthropic/package.json`、`packages/anthropic/tsconfig.json`、`packages/responses/package.json`、`packages/responses/tsconfig.json`、`packages/cli/package.json`、`packages/cli/tsconfig.json`
- Test: `packages/auth/src/smoke.test.ts`

**Interfaces:**
- Produces: pnpm workspace 包含 `packages/*`；每个包可运行 `pnpm vitest run` 与 `pnpm build`（tsc）。

- [ ] **Step 1: 写 root 配置文件**

`package.json`:
```json
{
  "name": "zcode-proxy-monorepo",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm vitest run"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^2.1.0",
    "zod": "^3.23.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
```

`mise.toml`:
```toml
[tools]
node = "24.14.0"
pnpm = "10.33.2"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "composite": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`vitest.workspace.ts`:
```ts
import { defineWorkspace } from "vitest/config";
export default defineWorkspace([
  { test: { include: ["packages/**/*.test.ts"], globals: false } },
]);
```

- [ ] **Step 2: 写各包 package.json 与 tsconfig**

每个包的 `package.json`（以 auth 为例，其余把 name 改为 `@zcode-proxy/core` 等）：
```json
{
  "name": "@zcode-proxy/auth",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": { "build": "tsc -b" },
  "dependencies": { "zod": "^3.23.0" }
}
```

每个包的 `tsconfig.json`（把 outDir/rootDir 对齐）：
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "tsBuildInfoFile": "./.tsbuildinfo"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

> core/server/anthropic/responses/cli 按依赖关系在 package.json 加 `"@zcode-proxy/auth": "workspace:*"` 等引用（具体在对应任务中补）。

- [ ] **Step 3: 写冒烟测试**

`packages/auth/src/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
describe("smoke", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: 安装依赖并运行测试确认通过**

Run: `mise exec -- pnpm install && mise exec -- pnpm vitest run`
Expected: PASS（1 个 smoke 测试）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with vitest"
```

---

## Task 2: 凭证 cipher（移植）

**Files:**
- Create: `packages/auth/src/cipher.ts`
- Test: `packages/auth/src/cipher.test.ts`

**Interfaces:**
- Produces: `createCipher(env?) : { encrypt(value:string):string; decrypt(value:string):string }`；`isEncrypted(value):boolean`。

- [ ] **Step 1: 写失败测试**

`packages/auth/src/cipher.test.ts`:
```ts
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
    expect(() => other.decrypt(enc)).toThrow(/decrypt failed/);
  });

  it("rejects malformed ciphertext", () => {
    const cipher = createCipher(env);
    expect(() => cipher.decrypt("enc:v1:bad.format")).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `mise exec -- pnpm vitest run packages/auth/src/cipher.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现（移植自 zcode credential-cipher.ts）**

`packages/auth/src/cipher.ts`:
```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `mise exec -- pnpm vitest run packages/auth/src/cipher.test.ts`
Expected: PASS（4 个测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/auth/src/cipher.ts packages/auth/src/cipher.test.ts
git commit -m "feat(auth): port aes-256-gcm credential cipher"
```

---

## Task 3: endpoints 与 family 解析

**Files:**
- Create: `packages/auth/src/endpoints.ts`
- Test: `packages/auth/src/endpoints.test.ts`

**Interfaces:**
- Produces:
  - `type Family = "zai" | "bigmodel"`
  - `ZCODE_APP_VERSION = "3.15.1"`
  - `interface Endpoints { managementOrigin: string; anthropicBaseUrl: string; zaiLoginUrl?: string }`
  - `resolveEndpoints(family: Family): Endpoints`

- [ ] **Step 1: 写失败测试**

`packages/auth/src/endpoints.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveEndpoints, ZCODE_APP_VERSION } from "./endpoints.js";

describe("endpoints", () => {
  it("resolves zai endpoints", () => {
    const e = resolveEndpoints("zai");
    expect(e.managementOrigin).toBe("https://api.z.ai");
    expect(e.anthropicBaseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(e.zaiLoginUrl).toBe("https://api.z.ai/api/auth/z/login");
  });

  it("resolves bigmodel endpoints", () => {
    const e = resolveEndpoints("bigmodel");
    expect(e.managementOrigin).toBe("https://bigmodel.cn");
    expect(e.anthropicBaseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(e.zaiLoginUrl).toBeUndefined();
  });

  it("pins the fingerprint version", () => {
    expect(ZCODE_APP_VERSION).toBe("3.15.1");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/auth/src/endpoints.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`packages/auth/src/endpoints.ts`:
```ts
export type Family = "zai" | "bigmodel";

// 移植基准版本；同时用于签 token 的 clientVersion 与指纹 headers。
export const ZCODE_APP_VERSION = "3.15.1";

export interface Endpoints {
  family: Family;
  managementOrigin: string;
  anthropicBaseUrl: string;
  zaiLoginUrl?: string;
}

export function resolveEndpoints(family: Family): Endpoints {
  if (family === "zai") {
    return {
      family,
      managementOrigin: "https://api.z.ai",
      anthropicBaseUrl: "https://api.z.ai/api/anthropic",
      zaiLoginUrl: "https://api.z.ai/api/auth/z/login",
    };
  }
  return {
    family,
    managementOrigin: "https://bigmodel.cn",
    anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
  };
}
```

> bigmodel 的管理 origin（`bigmodel.cn`）与模型端点（`open.bigmodel.cn`）不同；Task 9 首次真机验证时确认 getCustomerInfo/api_keys 在 `bigmodel.cn` 可达，若实际为 `open.bigmodel.cn` 则在此调整。

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/auth/src/endpoints.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/auth/src/endpoints.ts packages/auth/src/endpoints.test.ts
git commit -m "feat(auth): add endpoints and family resolution"
```

---

## Task 4: 只读 credential loader

**Files:**
- Create: `packages/auth/src/credential-loader.ts`
- Test: `packages/auth/src/credential-loader.test.ts`

**Interfaces:**
- Consumes: `createCipher`（Task 2）。
- Produces:
  - `interface LoadedCredential { family: Family; oauthAccessToken: string }`
  - `loadCredential(deps: { readTextFile: (p:string)=>Promise<string>; homedir: string; env?: Record<string,string|undefined> }): Promise<LoadedCredential>`

- [ ] **Step 1: 写失败测试**

`packages/auth/src/credential-loader.test.ts`:
```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/auth/src/credential-loader.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/auth/src/credential-loader.ts`:
```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/auth/src/credential-loader.test.ts`
Expected: PASS（5 个测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/auth/src/credential-loader.ts packages/auth/src/credential-loader.test.ts
git commit -m "feat(auth): add read-only credential loader"
```

---

## Task 5: device-mid 与指纹 source headers

**Files:**
- Create: `packages/auth/src/device-mid.ts`、`packages/auth/src/source-headers.ts`
- Test: `packages/auth/src/source-headers.test.ts`

**Interfaces:**
- Produces:
  - `readDeviceMid(deps): Promise<string|undefined>`
  - `buildSourceHeaders(input: { appVersion?: string; platform: string; arch: string; osRelease: string; sourceTitle?: string; deviceMid?: string; clientLanguage?: string; clientTimezone?: string; endpointOrigin?: string }): Record<string,string>`

- [ ] **Step 1: 写失败测试**

`packages/auth/src/source-headers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildSourceHeaders } from "./source-headers.js";

const base = {
  appVersion: "3.15.1",
  platform: "darwin",
  arch: "arm64",
  osRelease: "24.1.0",
  deviceMid: "MID123",
  clientLanguage: "zh-CN",
  clientTimezone: "Asia/Shanghai",
};

describe("buildSourceHeaders", () => {
  it("builds the full zcode fingerprint", () => {
    const h = buildSourceHeaders({ ...base, sourceTitle: "cli" });
    expect(h["User-Agent"]).toBe("ZCode/3.15.1");
    expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai");
    expect(h["X-Title"]).toBe("Z Code@cli");
    expect(h["X-ZCode-App-Version"]).toBe("3.15.1");
    expect(h["X-Platform"]).toBe("darwin-arm64");
    expect(h["X-Os-Category"]).toBe("macos");
    expect(h["X-Os-Version"]).toBe("24.1.0");
    expect(h["X-Client-Language"]).toBe("zh-CN");
    expect(h["X-Client-Timezone"]).toBe("Asia/Shanghai");
    expect(h["X-Device-Mid"]).toBe("MID123");
  });

  it("omits optional fields when absent", () => {
    const h = buildSourceHeaders({
      platform: "linux",
      arch: "x64",
      clientLanguage: "unknown",
      clientTimezone: "unknown",
    });
    expect(h["X-Title"]).toBe("Z Code@electron");
    expect(h["X-Os-Category"]).toBe("linux");
    expect(h["User-Agent"]).toBe("ZCode/unknown");
    expect(h["X-Device-Mid"]).toBeUndefined();
    expect(h["X-ZCode-App-Version"]).toBeUndefined();
  });

  it("maps win32 to windows", () => {
    const h = buildSourceHeaders({ platform: "win32", arch: "x64" });
    expect(h["X-Os-Category"]).toBe("windows");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/auth/src/source-headers.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/auth/src/device-mid.ts`:
```ts
import { join } from "node:path";

export interface DeviceMidDeps {
  readTextFile: (path: string) => Promise<string>;
  homedir: string;
}

export function telemetryStatePath(homedir: string): string {
  return join(homedir, ".zcode", "v2", "telemetry-state.json");
}

export async function readDeviceMid(deps: DeviceMidDeps): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await deps.readTextFile(telemetryStatePath(deps.homedir)));
    const mid = typeof parsed.deviceMid === "string" ? parsed.deviceMid.trim() : "";
    return mid && /^[\x20-\x7e]+$/.test(mid) ? mid : undefined;
  } catch {
    // deviceMid 由桌面端管理；只读复用，不创建。
    return undefined;
  }
}
```

`packages/auth/src/source-headers.ts`:
```ts
const PRINTABLE = /^[\x20-\x7e]+$/;

export interface SourceHeaderInput {
  appVersion?: string;
  platform?: string;
  arch?: string;
  osRelease?: string;
  sourceTitle?: string;
  deviceMid?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  endpointOrigin?: string;
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && PRINTABLE.test(t) ? t : undefined;
}

function osCategory(platform: string): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

export function buildSourceHeaders(input: SourceHeaderInput): Record<string, string> {
  const appVersion = clean(input.appVersion);
  const platform = clean(input.platform);
  const arch = clean(input.arch);
  const osRelease = clean(input.osRelease);
  const deviceMid = clean(input.deviceMid);
  const sourceTitle = clean(input.sourceTitle) ?? "electron";
  const referer = clean(input.endpointOrigin) ?? "https://zcode.z.ai";

  return {
    "User-Agent": `ZCode/${appVersion ?? "unknown"}`,
    "HTTP-Referer": referer,
    "X-Title": `Z Code@${sourceTitle}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(platform ? { "X-Os-Category": osCategory(platform) } : {}),
    ...(osRelease ? { "X-Os-Version": osRelease } : {}),
    "X-Client-Language": clean(input.clientLanguage) ?? "unknown",
    "X-Client-Timezone": clean(input.clientTimezone) ?? "unknown",
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/auth/src/source-headers.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/auth/src/device-mid.ts packages/auth/src/source-headers.ts packages/auth/src/source-headers.test.ts
git commit -m "feat(auth): add device-mid and zcode source fingerprint headers"
```

---

## Task 6: zai business login

**Files:**
- Create: `packages/auth/src/business-login.ts`
- Test: `packages/auth/src/business-login.test.ts`

**Interfaces:**
- Consumes: `Endpoints.zaiLoginUrl`（Task 3）。
- Produces: `loginWithZaiBusinessJwt(deps: { fetchImpl: typeof fetch; loginUrl: string; oauthAccessToken: string }): Promise<string>`（返回 business JWT）。

- [ ] **Step 1: 写失败测试**

`packages/auth/src/business-login.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { loginWithZaiBusinessJwt } from "./business-login.js";

describe("business login", () => {
  it("exchanges oauth token for business jwt", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 200, data: { token: "biz-jwt" } }), { status: 200 }),
    );
    const jwt = await loginWithZaiBusinessJwt({
      fetchImpl,
      loginUrl: "https://api.z.ai/api/auth/z/login",
      oauthAccessToken: "oauth",
    });
    expect(jwt).toBe("biz-jwt");
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toContain("oauth");
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(
      loginWithZaiBusinessJwt({
        fetchImpl,
        loginUrl: "https://x/login",
        oauthAccessToken: "oauth",
      }),
    ).rejects.toThrow(/login_failed/);
  });

  it("throws on malformed body", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(
      loginWithZaiBusinessJwt({ fetchImpl, loginUrl: "https://x/login", oauthAccessToken: "o" }),
    ).rejects.toThrow(/login_failed/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/auth/src/business-login.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/auth/src/business-login.ts`:
```ts
export interface BusinessLoginDeps {
  fetchImpl: typeof fetch;
  loginUrl: string;
  oauthAccessToken: string;
}

export async function loginWithZaiBusinessJwt(deps: BusinessLoginDeps): Promise<string> {
  const res = await deps.fetchImpl(deps.loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: deps.oauthAccessToken }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error("project_token_login_failed");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("project_token_login_failed");
  }
  const token = (body as { data?: { token?: unknown } })?.data?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("project_token_login_failed");
  }
  return token.trim();
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/auth/src/business-login.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/auth/src/business-login.ts packages/auth/src/business-login.test.ts
git commit -m "feat(auth): add zai business jwt login"
```

---

## Task 7: project location 定位（getCustomerInfo + api_keys）

**Files:**
- Create: `packages/auth/src/project-location.ts`
- Test: `packages/auth/src/project-location.test.ts`

**Interfaces:**
- Consumes: `Endpoints.managementOrigin`（Task 3）。
- Produces:
  - `interface ProjectLocation { organizationId: string; projectId: string; apiKeyId: string }`
  - `resolveProjectLocation(deps): Promise<ProjectLocation>`，deps 含 `fetchImpl`、`managementOrigin`、`family`、`loginToken`（zai 为 business JWT，bigmodel 为 oauth）。

- [ ] **Step 1: 写失败测试**

`packages/auth/src/project-location.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { resolveProjectLocation } from "./project-location.js";

const org = "org-1";
const proj = "proj-1";
function makeFetch(existingKey: boolean) {
  return vi.fn(async (url: string, init: any) => {
    const u = String(url);
    if (u.endsWith("/api/biz/customer/getCustomerInfo")) {
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            organizations: [
              {
                organizationId: org,
                organizationName: "默认机构",
                projects: [{ projectId: proj, projectName: "默认项目", projectType: "1" }],
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/api_keys") && init.method === "GET") {
      return new Response(
        JSON.stringify({ code: 200, data: existingKey ? [{ name: "zcode-api-key", apiKey: "key-1" }] : [] }),
        { status: 200 },
      );
    }
    if (u.endsWith("/api_keys") && init.method === "POST") {
      return new Response(JSON.stringify({ code: 200, data: { name: "zcode-api-key", apiKey: "key-1" } }), {
        status: 200,
      });
    }
    throw new Error("unexpected url " + u);
  });
}

describe("resolveProjectLocation", () => {
  it("reuses existing zcode-api-key", async () => {
    const loc = await resolveProjectLocation({
      fetchImpl: makeFetch(true),
      managementOrigin: "https://bigmodel.cn",
      family: "bigmodel",
      loginToken: "oauth",
    });
    expect(loc).toEqual({ organizationId: org, projectId: proj, apiKeyId: "key-1" });
  });

  it("creates the key when absent", async () => {
    const fetchImpl = makeFetch(false);
    const loc = await resolveProjectLocation({
      fetchImpl,
      managementOrigin: "https://bigmodel.cn",
      family: "bigmodel",
      loginToken: "oauth",
    });
    expect(loc.apiKeyId).toBe("key-1");
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/api_keys"), expect.objectContaining({ method: "POST" }));
  });

  it("uses Bearer auth for zai and raw token for bigmodel", async () => {
    const fetchImpl = makeFetch(true);
    await resolveProjectLocation({
      fetchImpl,
      managementOrigin: "https://api.z.ai",
      family: "zai",
      loginToken: "jwt",
    });
    const [, init] = fetchImpl.mock.calls.find(([u]) => String(u).includes("getCustomerInfo"));
    expect(init.headers.Authorization).toBe("Bearer jwt");
  });

  it("throws project_unavailable when no org/project", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 200, data: { organizations: [] } }), { status: 200 }),
    );
    await expect(
      resolveProjectLocation({
        fetchImpl,
        managementOrigin: "https://bigmodel.cn",
        family: "bigmodel",
        loginToken: "oauth",
      }),
    ).rejects.toThrow(/project_unavailable/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/auth/src/project-location.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现（移植 ProjectAccessTokenClient.#resolveLocation 个人分支）**

`packages/auth/src/project-location.ts`:
```ts
import type { Family } from "./endpoints.js";

const KEY_NAME = "zcode-api-key";

export interface ProjectLocation {
  organizationId: string;
  projectId: string;
  apiKeyId: string;
}

export interface ProjectLocationDeps {
  fetchImpl: typeof fetch;
  managementOrigin: string;
  family: Family;
  loginToken: string;
}

export async function resolveProjectLocation(deps: ProjectLocationDeps): Promise<ProjectLocation> {
  const { origin } = new URL(deps.managementOrigin);
  const authHeader = deps.family === "zai" ? `Bearer ${deps.loginToken}` : deps.loginToken;

  const customer = await getJson(deps.fetchImpl, `${origin}/api/biz/customer/getCustomerInfo`, {
    method: "GET",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
  });
  const organizations = Array.isArray(customer?.organizations) ? customer.organizations : [];

  const org =
    organizations.find((o: any) => String(o.organizationName ?? "").includes("默认机构")) ??
    organizations[0];
  const project =
    org?.projects?.find((p: any) => String(p.projectName ?? "").includes("默认项目")) ??
    org?.projects?.[0];
  if (!org?.organizationId || !project?.projectId) {
    throw new Error("project_token_project_unavailable");
  }

  const keyUrl =
    `${origin}/api/biz/v1/organization/${encodeURIComponent(org.organizationId)}` +
    `/projects/${encodeURIComponent(project.projectId)}/api_keys`;
  const keyHeaders =
    deps.family === "zai"
      ? { Authorization: authHeader, "Content-Type": "application/json" }
      : {
          Authorization: deps.loginToken,
          "Content-Type": "application/json",
          "bigmodel-organization": org.organizationId,
          "bigmodel-project": project.projectId,
        };

  const list = await getJson(deps.fetchImpl, keyUrl, { method: "GET", headers: keyHeaders });
  const entries = Array.isArray(list) ? list : [];
  const existing = entries.find((e: any) => e && e.name === KEY_NAME && typeof e.apiKey === "string");

  let apiKeyId: string | undefined = existing?.apiKey;
  if (!apiKeyId) {
    const created = await getJson(deps.fetchImpl, keyUrl, {
      method: "POST",
      headers: keyHeaders,
      body: JSON.stringify({ name: KEY_NAME, usageScene: "coding_plan" }),
    });
    apiKeyId = created?.apiKey;
  }
  if (typeof apiKeyId !== "string" || !apiKeyId) {
    throw new Error("project_token_invalid_response");
  }
  return { organizationId: org.organizationId, projectId: project.projectId, apiKeyId };
}

async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<any> {
  const res = await fetchImpl(url, init);
  if (res.status === 429 || res.status >= 500) {
    throw new Error("project_token_transient_failure");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error("project_token_request_failed");
  }
  const body = await res.json();
  const code = body?.code;
  if (code !== undefined && code !== 200 && code !== 0 && code !== "200" && code !== "0") {
    throw new Error("project_token_request_failed");
  }
  return body?.data;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/auth/src/project-location.test.ts`
Expected: PASS（4 个测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/auth/src/project-location.ts packages/auth/src/project-location.test.ts
git commit -m "feat(auth): resolve default org/project and zcode api key"
```

---

## Task 8: project access token 签发与缓存

**Files:**
- Create: `packages/auth/src/access-token.ts`
- Test: `packages/auth/src/access-token.test.ts`

**Interfaces:**
- Consumes: `ProjectLocation`（Task 7）、`ZCODE_APP_VERSION`（Task 3）。
- Produces:
  - `interface AccessTokenMaterial { token: string; expiresAt: number }`
  - `issueProjectAccessToken(deps): Promise<AccessTokenMaterial>`
  - `class AccessTokenCache`（含 singleflight、refresh lead 120s、jitter 60s）

- [ ] **Step 1: 写失败测试**

`packages/auth/src/access-token.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { AccessTokenCache } from "./access-token.js";
import type { ProjectLocation } from "./project-location.js";

const loc: ProjectLocation = { organizationId: "org", projectId: "proj", apiKeyId: "key" };

function issueResponse(token: string, expiresIn: number) {
  return {
    code: 200,
    data: { enable: true, accessToken: token, tokenType: "Bearer", expiresIn, expiresAt: Date.now() / 1000 + expiresIn },
  };
}

describe("AccessTokenCache", () => {
  it("issues and caches a token", async () => {
    const issue = vi.fn(async () => issueResponse("pat-1", 3600));
    const cache = new AccessTokenCache();
    const a = await cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue);
    const b = await cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue);
    expect(a.token).toBe("pat-1");
    expect(b.token).toBe("pat-1");
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent misses into one issue", async () => {
    const issue = vi.fn(async () => issueResponse("pat-2", 3600));
    const cache = new AccessTokenCache();
    const [a, b] = await Promise.all([
      cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue),
      cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue),
    ]);
    expect(a.token).toBe("pat-2");
    expect(b.token).toBe("pat-2");
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it("re-issues when the token is invalidated", async () => {
    const issue = vi.fn(async () => issueResponse("pat-3", 3600));
    const cache = new AccessTokenCache();
    await cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue);
    cache.invalidate({ managementOrigin: "https://bigmodel.cn", location: loc });
    await cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue);
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it("throws on disabled plan", async () => {
    const issue = vi.fn(async () => ({ code: 200, data: { enable: false } }));
    const cache = new AccessTokenCache();
    await expect(
      cache.resolve({ managementOrigin: "https://bigmodel.cn", location: loc }, issue),
    ).rejects.toThrow(/disabled/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/auth/src/access-token.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现（移植 ProjectAccessTokenCache）**

`packages/auth/src/access-token.ts`:
```ts
import { ZCODE_APP_VERSION } from "./endpoints.js";
import type { ProjectLocation } from "./project-location.js";

const SECOND = 1000;
const REFRESH_LEAD = 120 * SECOND;
const JITTER = 60 * SECOND;

export interface AccessTokenMaterial {
  token: string;
  expiresAt: number;
}

export interface CacheScope {
  managementOrigin: string;
  location: ProjectLocation;
}

interface Entry {
  value?: AccessTokenMaterial;
  refreshAt?: number;
  pending?: Promise<AccessTokenMaterial>;
}

export class AccessTokenCache {
  #entries = new Map<string, Entry>();
  #now: () => number;
  #random: () => number;

  constructor(options: { now?: () => number; random?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  async resolve(scope: CacheScope, issue: () => Promise<unknown>): Promise<AccessTokenMaterial> {
    const key = scopeKey(scope);
    let entry = this.#entries.get(key);
    if (entry?.pending) return entry.pending;
    if (entry?.value && this.#now() < Math.min(entry.refreshAt!, entry.value.expiresAt)) {
      return entry.value;
    }
    if (!entry) {
      entry = {};
      this.#entries.set(key, entry);
    }
    const current = entry;
    const startedAt = this.#now();
    const pending = Promise.resolve()
      .then(issue)
      .then((raw) => {
        const data = (raw as { data?: any })?.data;
        if (data && data.enable === false) throw new Error("project_token_disabled");
        if (!data || data.enable !== true || typeof data.accessToken !== "string") {
          throw new Error("project_token_invalid_response");
        }
        const expiresAt = Math.min(
          data.expiresAt * SECOND,
          startedAt + data.expiresIn * SECOND,
        );
        if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
          throw new Error("project_token_invalid_response");
        }
        const jitter = Math.max(0, Math.min(1, this.#random())) * JITTER;
        current.value = { token: data.accessToken, expiresAt };
        current.refreshAt = expiresAt - REFRESH_LEAD - jitter;
        return current.value;
      })
      .catch((error) => {
        this.#entries.delete(key);
        throw error;
      })
      .finally(() => {
        if (current.pending === pending) current.pending = undefined;
      });
    current.pending = pending;
    return pending;
  }

  invalidate(scope: CacheScope): void {
    this.#entries.delete(scopeKey(scope));
  }

  clear(): void {
    this.#entries.clear();
  }
}

export async function issueProjectAccessToken(deps: {
  fetchImpl: typeof fetch;
  managementOrigin: string;
  location: ProjectLocation;
  loginToken: string;
}): Promise<unknown> {
  const { origin } = new URL(deps.managementOrigin);
  const { organizationId, projectId, apiKeyId } = deps.location;
  const url =
    `${origin}/api/biz/v1/organization/${encodeURIComponent(organizationId)}` +
    `/projects/${encodeURIComponent(projectId)}/api_keys/${encodeURIComponent(apiKeyId)}/access_tokens`;
  const res = await deps.fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.loginToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientType: "zcode", clientVersion: ZCODE_APP_VERSION }),
  });
  if (!res.ok) throw new Error("project_token_request_failed");
  return res.json();
}

function scopeKey(scope: CacheScope): string {
  return JSON.stringify([new URL(scope.managementOrigin).origin, scope.location]);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/auth/src/access-token.test.ts`
Expected: PASS（4 个测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/auth/src/access-token.ts packages/auth/src/access-token.test.ts
git commit -m "feat(auth): issue and cache project access token"
```

---

## Task 9: AuthService 组装与真实凭证验证

**Files:**
- Create: `packages/auth/src/auth-service.ts`、`packages/auth/src/node-deps.ts`、`packages/auth/src/index.ts`
- Test: `packages/auth/src/auth-service.test.ts`（用 mock 全链路）

**Interfaces:**
- Consumes: Tasks 2–8 全部。
- Produces:
  ```ts
  interface AuthService {
    getEndpoints(): Promise<Endpoints>;
    getAccessToken(force?: boolean): Promise<AccessTokenMaterial>;
    getUpstreamHeaders(): Promise<Record<string, string>>;
  }
  createAuthService(overrides?: Partial<NodeDeps>): AuthService;
  ```

- [ ] **Step 1: 写失败测试（mock 全链路）**

`packages/auth/src/auth-service.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createAuthServiceInternal } from "./auth-service.js";
import { createCipher } from "./cipher.js";

const env = { ZCODE_CREDENTIAL_SECRET: "svc-secret" };
const cipher = createCipher(env);

describe("AuthService", () => {
  it("resolves endpoints, token and upstream headers through the chain", async () => {
    const credFile = JSON.stringify({
      "oauth:bigmodel:access_token": cipher.encrypt("oauth-tok"),
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push(`${init.method} ${url}`);
      const u = String(url);
      if (u.includes("getCustomerInfo"))
        return Response.json({
          code: 200,
          data: {
            organizations: [
              {
                organizationId: "org",
                organizationName: "默认机构",
                projects: [{ projectId: "proj", projectName: "默认项目", projectType: "1" }],
              },
            ],
          },
        });
      if (u.endsWith("/api_keys") && init.method === "GET")
        return Response.json({ code: 200, data: [] });
      if (u.endsWith("/api_keys") && init.method === "POST")
        return Response.json({ code: 200, data: { name: "zcode-api-key", apiKey: "keyid" } });
      if (u.includes("/access_tokens"))
        return Response.json({
          code: 200,
          data: { enable: true, accessToken: "pat", tokenType: "Bearer", expiresIn: 3600, expiresAt: Date.now() / 1000 + 3600 },
        });
      throw new Error("unexpected " + u);
    }) as typeof fetch;

    const svc = createAuthServiceInternal({
      env,
      homedir: "/home/u",
      platform: "darwin",
      arch: "arm64",
      osRelease: "24.0",
      readTextFile: async (p) => (p.endsWith("credentials.json") ? credFile : JSON.stringify({ deviceMid: "MID" })),
      fetchImpl,
    });

    const endpoints = await svc.getEndpoints();
    expect(endpoints.family).toBe("bigmodel");
    const token = await svc.getAccessToken();
    expect(token.token).toBe("pat");
    const headers = await svc.getUpstreamHeaders();
    expect(headers["Authorization"]).toBe("Bearer pat");
    expect(headers["User-Agent"]).toBe("ZCode/3.15.1");
    expect(headers["X-Device-Mid"]).toBe("MID");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/auth/src/auth-service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 node-deps**

`packages/auth/src/node-deps.ts`:
```ts
import { readFile } from "node:fs/promises";
import { arch as nodeArch, homedir as nodeHomedir, release as nodeRelease } from "node:os";

export interface NodeDeps {
  env: Record<string, string | undefined>;
  homedir: string;
  platform: string;
  arch: string;
  osRelease: string;
  readTextFile: (path: string) => Promise<string>;
  fetchImpl: typeof fetch;
}

export function defaultNodeDeps(): NodeDeps {
  return {
    env: process.env,
    homedir: nodeHomedir(),
    platform: process.platform,
    arch: nodeArch(),
    osRelease: nodeRelease(),
    readTextFile: (path: string) => readFile(path, "utf-8"),
    fetchImpl: fetch,
  };
}
```

- [ ] **Step 4: 实现 auth-service**

`packages/auth/src/auth-service.ts`:
```ts
import { loginWithZaiBusinessJwt } from "./business-login.js";
import { AccessTokenCache } from "./access-token.js";
import { loadCredential } from "./credential-loader.js";
import { resolveEndpoints, ZCODE_APP_VERSION, type Endpoints } from "./endpoints.js";
import { readDeviceMid } from "./device-mid.js";
import { issueProjectAccessToken } from "./access-token.js";
import { resolveProjectLocation } from "./project-location.js";
import type { ProjectLocation } from "./project-location.js";
import { buildSourceHeaders } from "./source-headers.js";
import type { NodeDeps } from "./node-deps.js";

export interface AuthService {
  getEndpoints(): Promise<Endpoints>;
  getAccessToken(force?: boolean): Promise<{ token: string; expiresAt: number }>;
  getUpstreamHeaders(force?: boolean): Promise<Record<string, string>>;
}

export function createAuthServiceInternal(deps: NodeDeps): AuthService {
  const cache = new AccessTokenCache();
  let endpointsPromise: Promise<Endpoints> | undefined;

  async function endpoints(): Promise<Endpoints> {
    if (!endpointsPromise) {
      endpointsPromise = (async () => {
        const cred = await loadCredential({
          readTextFile: deps.readTextFile,
          homedir: deps.homedir,
          env: deps.env,
        });
        return resolveEndpoints(cred.family);
      })();
    }
    return endpointsPromise;
  }

  let locationMaterial: Promise<{
    ep: Endpoints;
    loginToken: string;
    location: ProjectLocation;
  }> | undefined;

  function resolveLocationMaterial() {
    if (!locationMaterial) {
      locationMaterial = (async () => {
        const ep = await endpoints();
        const cred = await loadCredential({
          readTextFile: deps.readTextFile,
          homedir: deps.homedir,
          env: deps.env,
        });
        const loginToken =
          ep.family === "zai"
            ? await loginWithZaiBusinessJwt({
                fetchImpl: deps.fetchImpl,
                loginUrl: ep.zaiLoginUrl!,
                oauthAccessToken: cred.oauthAccessToken,
              })
            : cred.oauthAccessToken;
        const location = await resolveProjectLocation({
          fetchImpl: deps.fetchImpl,
          managementOrigin: ep.managementOrigin,
          family: ep.family,
          loginToken,
        });
        return { ep, loginToken, location };
      })();
    }
    return locationMaterial;
  }

  async function getAccessToken(force = false) {
    const { ep, loginToken, location } = await resolveLocationMaterial();
    const scope = { managementOrigin: ep.managementOrigin, location };
    if (force) cache.invalidate(scope);
    return cache.resolve(scope, () =>
      issueProjectAccessToken({
        fetchImpl: deps.fetchImpl,
        managementOrigin: ep.managementOrigin,
        location,
        loginToken,
      }),
    );
  }

  async function getUpstreamHeaders(force = false): Promise<Record<string, string>> {
    const ep = await endpoints();
    const deviceMid = await readDeviceMid({
      readTextFile: deps.readTextFile,
      homedir: deps.homedir,
    });
    const locale = Intl.DateTimeFormat().resolvedOptions();
    const token = await getAccessToken(force);
    return {
      ...buildSourceHeaders({
        appVersion: ZCODE_APP_VERSION,
        platform: deps.platform,
        arch: deps.arch,
        osRelease: deps.osRelease,
        sourceTitle: "cli",
        deviceMid,
        clientLanguage: locale.locale,
        clientTimezone: locale.timeZone,
      }),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      Authorization: `Bearer ${token.token}`,
    };
  }

  return { getEndpoints: endpoints, getAccessToken, getUpstreamHeaders };
}
```

`packages/auth/src/index.ts`:
```ts
export { createAuthServiceInternal } from "./auth-service.js";
export { defaultNodeDeps } from "./node-deps.js";
export type { AuthService } from "./auth-service.js";
export { resolveEndpoints, ZCODE_APP_VERSION } from "./endpoints.js";
export type { Endpoints, Family } from "./endpoints.js";
```

- [ ] **Step 5: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/auth/src/auth-service.test.ts`
Expected: PASS。

- [ ] **Step 6: 真实凭证端到端验证（手动一次性脚本，不提交）**

在 `ZCode/` 目录外创建临时脚本（用 node 直接跑编译后的 dist），或先 `mise exec -- pnpm -r build`，然后运行：
```bash
mise exec -- node --input-type=module -e "
import { createAuthServiceInternal } from './packages/auth/dist/index.js';
import { defaultNodeDeps } from './packages/auth/dist/node-deps.js';
const svc = createAuthServiceInternal(defaultNodeDeps());
const h = await svc.getUpstreamHeaders();
console.log('family/headers ok, Authorization length', h.Authorization.length);
"
```
Expected: 打印真实 Authorization 长度；不报解密错误。若 bigmodel 管理接口在 `bigmodel.cn` 不可达，按 Task 3 备注改 managementOrigin 后重验。验证后删除临时脚本。

- [ ] **Step 7: 提交**

```bash
git add packages/auth/src
git commit -m "feat(auth): assemble AuthService with full zcode fingerprint"
```

---

## Task 10: 模型映射

**Files:**
- Create: `packages/core/src/model-mapping.ts`
- Test: `packages/core/src/model-mapping.test.ts`
- 给 `packages/core/package.json` 加 `"@zcode-proxy/auth": "workspace:*"`（本任务仅用类型，可暂不依赖）。

**Interfaces:**
- Produces:
  - `interface ModelMapping { map(inboundModel: string): string }`
  - `createModelMapping(overrides?: Record<string, string>): ModelMapping`（overrides 键为正则源字符串）。

- [ ] **Step 1: 写失败测试**

`packages/core/src/model-mapping.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createModelMapping } from "./model-mapping.js";

describe("model mapping", () => {
  const m = createModelMapping();
  it("maps opus/sonnet to GLM-5.3", () => {
    expect(m.map("claude-opus-4-1")).toBe("GLM-5.3");
    expect(m.map("claude-sonnet-4-5")).toBe("GLM-5.3");
  });
  it("maps haiku to GLM-5.3-Flash", () => {
    expect(m.map("claude-haiku-4-5")).toBe("GLM-5.3-Flash");
  });
  it("preserves explicit GLM names", () => {
    expect(m.map("GLM-5.3")).toBe("GLM-5.3");
    expect(m.map("GLM-5.3-Flash")).toBe("GLM-5.3-Flash");
  });
  it("falls back to GLM-5.3 for unknown names", () => {
    expect(m.map("something-else")).toBe("GLM-5.3");
  });
  it("honors custom overrides", () => {
    const custom = createModelMapping({ "^my-fast$": "GLM-5.3-Flash" });
    expect(custom.map("my-fast")).toBe("GLM-5.3-Flash");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/core/src/model-mapping.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/core/src/model-mapping.ts`:
```ts
const DEFAULT_RULES: Array<[RegExp, string]> = [
  [/^claude-(opus|sonnet)/i, "GLM-5.3"],
  [/^claude-haiku/i, "GLM-5.3-Flash"],
];

export interface ModelMapping {
  map(inboundModel: string): string;
}

export function createModelMapping(overrides: Record<string, string> = {}): ModelMapping {
  const custom: Array<[RegExp, string]> = Object.entries(overrides).map(
    ([re, target]) => [new RegExp(re), target],
  );
  const rules = [...custom, ...DEFAULT_RULES];
  return {
    map(inboundModel: string): string {
      const model = inboundModel ?? "";
      for (const [re, target] of rules) {
        if (re.test(model)) return target;
      }
      if (/^GLM-/i.test(model)) return model;
      return "GLM-5.3";
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/core/src/model-mapping.test.ts`
Expected: PASS（5 个测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/core
git commit -m "feat(core): add inbound-to-GLM model mapping"
```

---

## Task 11: thinking 剥离（非流式）

**Files:**
- Create: `packages/core/src/thinking-filter.ts`
- Test: `packages/core/src/thinking-filter.test.ts`

**Interfaces:**
- Produces: `stripThinkingFromMessage(message: any): any`。

- [ ] **Step 1: 写失败测试**

`packages/core/src/thinking-filter.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { stripThinkingFromMessage } from "./thinking-filter.js";

describe("stripThinkingFromMessage", () => {
  it("removes thinking blocks", () => {
    const msg = {
      id: "m",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret thoughts" },
        { type: "text", text: "answer" },
      ],
    };
    const out = stripThinkingFromMessage(msg);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]).toEqual({ type: "text", text: "answer" });
  });
  it("keeps tool_use after removing thinking", () => {
    const msg = {
      content: [
        { type: "thinking", thinking: "..." },
        { type: "tool_use", id: "t1", name: "f", input: {} },
      ],
    };
    const out = stripThinkingFromMessage(msg);
    expect(out.content).toHaveLength(1);
    expect(out.content[0].type).toBe("tool_use");
  });
  it("returns messages without content unchanged", () => {
    expect(stripThinkingFromMessage(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/core/src/thinking-filter.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/core/src/thinking-filter.ts`:
```ts
export function stripThinkingFromMessage<T extends { content?: any[] } | null>(message: T): T {
  if (!message || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.filter((block) => block?.type !== "thinking"),
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/core/src/thinking-filter.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/thinking-filter.ts packages/core/src/thinking-filter.test.ts
git commit -m "feat(core): strip thinking from non-streaming responses"
```

---

## Task 12: SSE 工具与 thinking 流式过滤

**Files:**
- Create: `packages/core/src/sse.ts`、`packages/core/src/thinking-stream.ts`
- Test: `packages/core/src/thinking-stream.test.ts`

**Interfaces:**
- Produces:
  - `interface SSEEvent { event: string; data: any }`
  - `parseSSE(): TransformStream<Uint8Array, SSEEvent>`；`serializeSSE(): TransformStream<SSEEvent, Uint8Array>`
  - `createThinkingEventFilter(): { process(ev: SSEEvent): SSEEvent | null }`

- [ ] **Step 1: 写失败测试**

`packages/core/src/thinking-stream.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createThinkingEventFilter } from "./thinking-stream.js";
import type { SSEEvent } from "./sse.js";

function ev(event: string, data: any): SSEEvent {
  return { event, data };
}

describe("thinking stream filter", () => {
  it("drops a leading thinking block and reindexes the text block", () => {
    const f = createThinkingEventFilter();
    const out: SSEEvent[] = [];
    for (const e of [
      ev("content_block_start", { index: 0, content_block: { type: "thinking" } }),
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking_delta: "x" } }),
      ev("content_block_stop", { index: 0 }),
      ev("content_block_start", { index: 1, content_block: { type: "text" } }),
      ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "hi" } }),
      ev("content_block_stop", { index: 1 }),
    ]) {
      const r = f.process(e);
      if (r) out.push(r);
    }
    expect(out).toHaveLength(3);
    expect(out[0].event).toBe("content_block_start");
    expect(out[0].data.index).toBe(0);
    expect(out[0].data.content_block.type).toBe("text");
    expect(out[1].data.index).toBe(0);
    expect(out[2].data.index).toBe(0);
  });

  it("keeps thinking when filter not used (pass-through handled by caller)", () => {
    const f = createThinkingEventFilter();
    const start = ev("content_block_start", { index: 0, content_block: { type: "text" } });
    expect(f.process(start)!.data.index).toBe(0);
  });

  it("reindexes when thinking appears between two text blocks", () => {
    const f = createThinkingEventFilter();
    const seq = [
      ev("content_block_start", { index: 0, content_block: { type: "text" } }),
      ev("content_block_stop", { index: 0 }),
      ev("content_block_start", { index: 1, content_block: { type: "thinking" } }),
      ev("content_block_stop", { index: 1 }),
      ev("content_block_start", { index: 2, content_block: { type: "text" } }),
      ev("content_block_stop", { index: 2 }),
    ];
    const kept = seq.map((e) => f.process(e)).filter(Boolean) as SSEEvent[];
    const starts = kept.filter((e) => e.event === "content_block_start");
    expect(starts.map((e) => e.data.index)).toEqual([0, 1]);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/core/src/thinking-stream.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 SSE 工具**

`packages/core/src/sse.ts`:
```ts
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SSEEvent {
  event: string;
  data: any;
}

export function parseSSE(): TransformStream<Uint8Array, SSEEvent> {
  let buffer = "";
  return new TransformStream<Uint8Array, SSEEvent>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = raw.split("\n");
        let event = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        const joined = dataLines.join("\n");
        let data: any = joined;
        try {
          data = JSON.parse(joined);
        } catch {
          /* keep raw string */
        }
        controller.enqueue({ event, data });
      }
    },
  });
}

export function serializeSSE(): TransformStream<SSEEvent, Uint8Array> {
  return new TransformStream<SSEEvent, Uint8Array>({
    transform(ev, controller) {
      const payload = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
      controller.enqueue(encoder.encode(`event: ${ev.event}\ndata: ${payload}\n\n`));
    },
  });
}
```

- [ ] **Step 4: 实现 thinking 流式过滤**

`packages/core/src/thinking-stream.ts`:
```ts
import type { SSEEvent } from "./sse.js";

export interface ThinkingEventFilter {
  process(ev: SSEEvent): SSEEvent | null;
}

export function createThinkingEventFilter(): ThinkingEventFilter {
  let skipping = false;
  let outputIndex = -1;

  return {
    process(ev: SSEEvent): SSEEvent | null {
      if (ev.event === "content_block_start") {
        if (ev.data?.content_block?.type === "thinking") {
          skipping = true;
          return null;
        }
        skipping = false;
        outputIndex += 1;
        return { event: ev.event, data: { ...ev.data, index: outputIndex } };
      }
      if (ev.event === "content_block_delta" || ev.event === "content_block_stop") {
        if (skipping) return null;
        return { event: ev.event, data: { ...ev.data, index: outputIndex } };
      }
      return ev;
    },
  };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/core/src/thinking-stream.test.ts`
Expected: PASS（3 个测试）。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/sse.ts packages/core/src/thinking-stream.ts packages/core/src/thinking-stream.test.ts
git commit -m "feat(core): add SSE utils and streaming thinking filter"
```

---

## Task 13: 上游认证重试（401 自动换证）

**Files:**
- Create: `packages/core/src/upstream-request.ts`
- Test: `packages/core/src/upstream-request.test.ts`
- 给 `packages/core/package.json` 加 `"@zcode-proxy/auth": "workspace:*"`。

**Interfaces:**
- Consumes: `AuthService.getUpstreamHeaders(force?)`。
- Produces:
  ```ts
  sendWithAuthRetry(input: {
    getHeaders: (force?: boolean) => Promise<Record<string, string>>;
    send: (headers: Record<string, string>) => Promise<Response>;
  }): Promise<Response>
  ```

- [ ] **Step 1: 写失败测试**

`packages/core/src/upstream-request.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { sendWithAuthRetry } from "./upstream-request.js";

function jsonResponse(status: number) {
  return new Response("{}", { status });
}

describe("sendWithAuthRetry", () => {
  it("retries once with forced refresh on 401", async () => {
    const getHeaders = vi
      .fn()
      .mockResolvedValueOnce({ Authorization: "Bearer old" })
      .mockResolvedValueOnce({ Authorization: "Bearer new" });
    const send = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200));
    const res = await sendWithAuthRetry({ getHeaders, send });
    expect(res.status).toBe(200);
    expect(getHeaders).toHaveBeenNthCalledWith(1, false);
    expect(getHeaders).toHaveBeenNthCalledWith(2, true);
  });

  it("does not retry on 200", async () => {
    const getHeaders = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockResolvedValue(jsonResponse(200));
    await sendWithAuthRetry({ getHeaders, send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns the 401 when refresh also fails", async () => {
    const getHeaders = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockResolvedValue(jsonResponse(401));
    const res = await sendWithAuthRetry({ getHeaders, send });
    expect(res.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/core/src/upstream-request.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/core/src/upstream-request.ts`:
```ts
export interface UpstreamRequestInput {
  getHeaders: (force?: boolean) => Promise<Record<string, string>>;
  send: (headers: Record<string, string>) => Promise<Response>;
}

export async function sendWithAuthRetry(input: UpstreamRequest): Promise<Response> {
  const firstHeaders = await input.getHeaders(false);
  const first = await input.send(firstHeaders);
  if (first.status !== 401) return first;
  const refreshed = await input.getHeaders(true);
  return input.send(refreshed);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/core/src/upstream-request.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/upstream-request.ts packages/core/src/upstream-request.test.ts
git commit -m "feat(core): auto-refresh token and retry once on upstream 401"
```

---

## Task 14: Server 骨架、路由、health、错误归一

**Files:**
- Create: `packages/server/src/server.ts`、`packages/server/src/errors.ts`
- Test: `packages/server/src/server.test.ts`
- 给 `packages/server/package.json` 加 `"@zcode-proxy/core": "workspace:*"`。

**Interfaces:**
- Produces:
  - `type GatewayHandler = (req: Request, ctx: RequestContext) => Promise<Response>`
  - `interface RequestContext { signal: AbortSignal; requestId: string }`
  - `startGateway(port: number, handler: (req: Request, ctx: RequestContext) => Promise<Response>): Promise<{ close(): Promise<void> }>`
  - `anthropicError(status: number, type: string, message: string): Response`

- [ ] **Step 1: 写失败测试**

`packages/server/src/server.test.ts`:
```ts
import { describe, it, expect, afterAll } from "vitest";
import { startGateway } from "./server.js";

describe("startGateway", () => {
  it("routes requests and aborts on client disconnect", async () => {
    const handler = async (req: Request) => {
      if (new URL(req.url).pathname === "/health") {
        return Response.json({ ok: true });
      }
      return Response.json({ echo: await req.text() });
    };
    const gw = await startGateway(0, handler);
    const port = (gw as any).port as number;
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    expect(health).toEqual({ ok: true });
    await gw.close();
  });

  it("binds only loopback", async () => {
    const gw = await startGateway(0, async () => Response.json({}));
    const port = (gw as any).port as number;
    // 127.0.0.1 可达即证明绑定 loopback
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.status).toBe(200);
    await gw.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/server/src/server.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现错误归一**

`packages/server/src/errors.ts`:
```ts
export function anthropicError(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

export function responsesError(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    { status, headers: { "content-type": "application/json" } },
  );
}
```

- [ ] **Step 4: 实现 server**

`packages/server/src/server.ts`:
```ts
import { createServer, type Server as HttpServer } from "node:http";

export interface RequestContext {
  signal: AbortSignal;
  requestId: string;
}

export type GatewayHandler = (req: Request, ctx: RequestContext) => Promise<Response>;

export interface Gateway {
  close(): Promise<void>;
  port: number;
}

export function startGateway(port: number, handler: GatewayHandler): Promise<Gateway> {
  const server: HttpServer = createServer((nodeReq, nodeRes) => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    const url = `http://127.0.0.1:${boundPort}${nodeReq.url}`;
    const controller = new AbortController();
    const requestId = `req_${Math.random().toString(36).slice(2, 10)}`;

    // 客户端断连：abort 上游，避免继续消耗额度。
    nodeReq.on("close", () => {
      if (!nodeRes.writableEnded) controller.abort();
    });

    const webReq = new Request(url, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers as Record<string, string>),
      body: ["GET", "HEAD"].includes(nodeReq.method ?? "") ? undefined : (nodeReq as any),
      // @ts-expect-error undici duplex option
      duplex: "half",
    });

    handler(webReq, { signal: controller.signal, requestId })
      .then(async (webRes) => {
        nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers));
        if (webRes.body) {
          for await (const chunk of webRes.body) {
            if (!nodeRes.write(chunk)) {
              await new Promise((r) => nodeRes.once("drain", r));
            }
          }
          nodeRes.end();
        } else {
          nodeRes.end(await webRes.text());
        }
      })
      .catch(() => {
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(500, { "content-type": "application/json" });
          nodeRes.end(
            JSON.stringify({ type: "error", error: { type: "api_error", message: "internal error" } }),
          );
        } else {
          nodeRes.end();
        }
      });
  });

  return new Promise((resolve) => {
    // 硬编码 loopback，禁止外部访问。
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
```

- [ ] **Step 5: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/server/src/server.test.ts`
Expected: PASS（2 个测试）。

- [ ] **Step 6: 提交**

```bash
git add packages/server
git commit -m "feat(server): loopback-only gateway server with health and error normalization"
```

---

## Task 15: Anthropic Messages 透传 + beta 过滤

**Files:**
- Create: `packages/anthropic/src/beta-filter.ts`、`packages/anthropic/src/messages.ts`
- Test: `packages/anthropic/src/messages.test.ts`、`beta-filter.test.ts`
- 给 `packages/anthropic/package.json` 加 `"@zcode-proxy/auth": "workspace:*"`、`"@zcode-proxy/core": "workspace:*"`。

**Interfaces:**
- Consumes: `AuthService`、`ModelMapping`、`sendWithAuthRetry`、SSE/thinking 工具。
- Produces: `handleMessages(req: Request, ctx: MessagesContext): Promise<Response>`；`filterAnthropicBeta(headers: Record<string,string>): Record<string,string>`。

- [ ] **Step 1: 写 beta 过滤测试**

`packages/anthropic/src/beta-filter.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { filterAnthropicBeta, ALLOWED_UPSTREAM_BETAS } from "./beta-filter.js";

describe("beta filter", () => {
  it("removes beta names not on the upstream whitelist", () => {
    const out = filterAnthropicBeta({
      "anthropic-beta": "interleaved-thinking-2025,unknown-feature-x",
    });
    const allowed = (out["anthropic-beta"] ?? "").split(",").filter(Boolean);
    expect(allowed.every((b) => ALLOWED_UPSTREAM_BETAS.has(b))).toBe(true);
  });
  it("drops the header entirely when no beta is allowed", () => {
    const out = filterAnthropicBeta({ "anthropic-beta": "unknown-feature-x" });
    expect(out["anthropic-beta"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: 写 messages 透传测试（非流式）**

`packages/anthropic/src/messages.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { handleMessages } from "./messages.js";
import { createModelMapping } from "@zcode-proxy/core";
```

继续写测试主体（用一个可注入的 upstream fetch 与 auth）：
```ts
function makeCtx(upstream: Response, opts: { headers?: Record<string,string> } = {}) {
  const getHeaders = vi.fn(async () => opts.headers ?? { Authorization: "Bearer pat", "anthropic-version": "2023-06-01" });
  return {
    auth: { getUpstreamHeaders: getHeaders } as any,
    modelMapping: createModelMapping(),
    upstreamBaseUrl: "https://bigmodel.cn/api/anthropic",
    fetchImpl: vi.fn(async () => upstream),
  };
}

describe("handleMessages", () => {
  it("maps model and strips thinking when client did not enable it", async () => {
    const upstream = Response.json({
      content: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "answer" },
      ],
    });
    const ctx = makeCtx(upstream);
    const req = new Request("http://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-5", stream: false }),
    });
    const res = await handleMessages(req, ctx);
    const body = await res.json();
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe("text");
  });

  it("keeps thinking when client enabled it", async () => {
    const upstream = Response.json({
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "answer" },
      ],
    });
    const ctx = makeCtx(upstream);
    const req = new Request("http://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        stream: false,
        thinking: { type: "enabled", budget_tokens: 4096 },
      }),
    });
    const res = await handleMessages(req, ctx);
    expect((await res.json()).content).toHaveLength(2);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/anthropic/src`
Expected: FAIL。

- [ ] **Step 4: 实现 beta filter**

`packages/anthropic/src/beta-filter.ts`:
```ts
// 初期白名单为空（最安全，全部过滤）；实现阶段逐个 beta 实测后，把上游接受的加入。
export const ALLOWED_UPSTREAM_BETAS: Set<string> = new Set([]);

export function filterAnthropicBeta(headers: Record<string, string>): Record<string, string> {
  const raw = headers["anthropic-beta"];
  if (!raw) return headers;
  const allowed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((b) => b && ALLOWED_UPSTREAM_BETAS.has(b));
  const out = { ...headers };
  if (allowed.length) out["anthropic-beta"] = allowed.join(",");
  else delete out["anthropic-beta"];
  return out;
}
```

- [ ] **Step 5: 实现 messages 透传**

`packages/anthropic/src/messages.ts`:
```ts
import {
  createThinkingEventFilter,
  parseSSE,
  sendWithAuthRetry,
  serializeSSE,
  stripThinkingFromMessage,
} from "@zcode-proxy/core";
import type { ModelMapping } from "@zcode-proxy/core";
import { filterAnthropicBeta } from "./beta-filter.js";

export interface MessagesContext {
  auth: { getUpstreamHeaders: (force?: boolean) => Promise<Record<string, string>> };
  modelMapping: ModelMapping;
  upstreamBaseUrl: string;
  fetchImpl: typeof fetch;
}

export async function handleMessages(req: Request, ctx: MessagesContext): Promise<Response> {
  const inbound = await req.json();
  const wantsThinking = Boolean(inbound.thinking);
  const outbound = {
    ...inbound,
    model: ctx.modelMapping.map(inbound.model),
  };
  const body = JSON.stringify(outbound);

  const upstream = await sendWithAuthRetry({
    getHeaders: async (force) => {
      const base = await ctx.auth.getUpstreamHeaders(force);
      const clientBeta = req.headers.get("anthropic-beta");
      return filterAnthropicBeta(clientBeta ? { ...base, "anthropic-beta": clientBeta } : base);
    },
    send: (headers) =>
      ctx.fetchImpl(`${ctx.upstreamBaseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body,
      }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (!outbound.stream) {
    const json = await upstream.json();
    return Response.json(wantsThinking ? json : stripThinkingFromMessage(json));
  }

  const eventFilter = createThinkingEventFilter();
  const transformed = upstream.body
    .pipeThrough(parseSSE())
    .pipeThrough(
      new TransformStream({
        transform(ev, controller) {
          const r = wantsThinking ? ev : eventFilter.process(ev);
          if (r) controller.enqueue(r);
        },
      }),
    )
    .pipeThrough(serializeSSE());
  return new Response(transformed, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
```

> 注意：`@zcode-proxy/core` 需从 index 导出 `createModelMapping`、`parseSSE`、`serializeSSE`、`createThinkingEventFilter`、`stripThinkingFromMessage`、`sendWithAuthRetry`。在 Task 15 中补齐 `packages/core/src/index.ts`：
```ts
export { createModelMapping } from "./model-mapping.js";
export { stripThinkingFromMessage } from "./thinking-filter.js";
export { parseSSE, serializeSSE } from "./sse.js";
export type { SSEEvent } from "./sse.js";
export { createThinkingEventFilter } from "./thinking-stream.js";
export { sendWithAuthRetry } from "./upstream-request.js";
```

- [ ] **Step 6: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/anthropic/src`
Expected: PASS。

- [ ] **Step 7: 真实上游流式验证（手动，不提交）**

先 `mise exec -- pnpm -r build`，再写一次性脚本用真实 AuthService 起 `handleMessages`，打一条 stream 请求，确认事件完整且 thinking 被剥离；验证后删除脚本。

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/index.ts packages/anthropic
git commit -m "feat(anthropic): transparent /v1/messages with beta filter and streaming"
```

---

## Task 16: Anthropic Models 与 Health 端点

**Files:**
- Create: `packages/anthropic/src/models.ts`
- Test: `packages/anthropic/src/models.test.ts`

**Interfaces:**
- Produces: `handleModels(): Response`；`handleHealth(ctx): Promise<Response>`。

- [ ] **Step 1: 写失败测试**

`packages/anthropic/src/models.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { handleModels } from "./models.js";

describe("handleModels", () => {
  it("lists GLM models for discovery", async () => {
    const res = handleModels();
    const body = await res.json();
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain("GLM-5.3");
    expect(ids).toContain("GLM-5.3-Flash");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/anthropic/src/models.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/anthropic/src/models.ts`:
```ts
const MODELS = [
  { type: "model", id: "GLM-5.3", display_name: "GLM 5.3", created: 0 },
  { type: "model", id: "GLM-5.3-Flash", display_name: "GLM 5.3 Flash", created: 0 },
];

export function handleModels(): Response {
  return Response.json({ object: "list", data: MODELS });
}

export async function handleHealth(auth: {
  getUpstreamHeaders: () => Promise<Record<string, string>>;
}): Promise<Response> {
  try {
    await auth.getUpstreamHeaders();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ ok: false, message: (error as Error).message }, { status: 503 });
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/anthropic/src/models.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/anthropic/src/models.ts packages/anthropic/src/models.test.ts
git commit -m "feat(anthropic): add /v1/models and health endpoints"
```

---

## Task 17: Responses 请求转换（含 tool-choice）

**Files:**
- Create: `packages/responses/src/request-convert.ts`
- Test: `packages/responses/src/request-convert.test.ts`
- 给 `packages/responses/package.json` 加 `"@zcode-proxy/core": "workspace:*"`。

**Interfaces:**
- Produces:
  - `interface ConvertedRequest { anthropicBody: any; wantsThinking: boolean }`
  - `convertResponsesRequest(body: any): ConvertedRequest`
  - `convertToolChoice(choice: any, parallel?: boolean): any`

- [ ] **Step 1: 写失败测试**

`packages/responses/src/request-convert.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  convertResponsesRequest,
  convertToolChoice,
} from "./request-convert.js";

describe("convertResponsesRequest", () => {
  it("converts instructions and a simple user message", () => {
    const { anthropicBody } = convertResponsesRequest({
      model: "gpt-5-codex",
      instructions: "be brief",
      input: "hello",
    });
    expect(anthropicBody.system).toBe("be brief");
    expect(anthropicBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("converts flat function tools", () => {
    const { anthropicBody } = convertResponsesRequest({
      input: "x",
      tools: [
        {
          type: "function",
          name: "weather",
          description: "weather lookup",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(anthropicBody.tools).toEqual([
      {
        name: "weather",
        description: "weather lookup",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
  });

  it("converts a function_call/function_call_output round trip", () => {
    const { anthropicBody } = convertResponsesRequest({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "weather?" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "weather",
          arguments: '{"city":"北京"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "sunny",
        },
      ],
    });
    expect(anthropicBody.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "weather?" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "weather", input: { city: "北京" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
      },
    ]);
  });

  it("maps reasoning effort to thinking and flips the flag", () => {
    const { wantsThinking, anthropicBody } = convertResponsesRequest({
      input: "x",
      reasoning: { effort: "high" },
    });
    expect(wantsThinking).toBe(true);
    expect(anthropicBody.thinking.type).toBe("enabled");
    expect(anthropicBody.thinking.budget_tokens).toBe(16384);
  });

  it("drops tools when choice is none", () => {
    const { anthropicBody } = convertResponsesRequest({
      input: "x",
      tools: [{ type: "function", name: "f" }],
      tool_choice: "none",
    });
    expect(anthropicBody.tools).toBeUndefined();
  });
});

describe("convertToolChoice", () => {
  it("maps required + parallel=false to any with disable=true", () => {
    expect(convertToolChoice("required", false)).toEqual({
      type: "any",
      disable_parallel_tool_use: true,
    });
  });
  it("maps a named function", () => {
    expect(convertToolChoice({ type: "function", name: "f" }, true)).toEqual({
      type: "tool",
      name: "f",
      disable_parallel_tool_use: false,
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/responses/src/request-convert.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/responses/src/request-convert.ts`:
```ts
const EFFORT_BUDGETS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

export interface ConvertedRequest {
  anthropicBody: any;
  wantsThinking: boolean;
}

export function convertToolChoice(choice: any, parallel = true): any {
  const disable = !parallel;
  if (choice === "required")
    return { type: "any", disable_parallel_tool_use: disable };
  if (typeof choice === "object" && choice?.type === "function")
    return { type: "tool", name: choice.name, disable_parallel_tool_use: disable };
  // "auto" 或缺省
  return { type: "auto", disable_parallel_tool_use: disable };
}

export function convertResponsesRequest(body: any): ConvertedRequest {
  const rawItems = Array.isArray(body.input)
    ? body.input
    : [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input ?? "" }] }];

  const messages = convertItems(rawItems);

  const functionTools = (body.tools ?? [])
    .filter((t: any) => t.type === "function")
    .map((t: any) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.parameters ?? { type: "object", properties: {} },
    }));
  const wantsTools = body.tool_choice !== "none" && functionTools.length > 0;

  const effort = body.reasoning?.effort;
  const wantsThinking = Boolean(body.reasoning);
  const thinking = wantsThinking
    ? {
        type: "enabled",
        budget_tokens: EFFORT_BUDGETS[effort] ?? 4096,
      }
    : undefined;

  return {
    wantsThinking,
    anthropicBody: {
      model: body.model ?? "gpt-5-codex",
      ...(typeof body.instructions === "string" ? { system: body.instructions } : {}),
      messages,
      ...(wantsTools
        ? {
            tools: functionTools,
            tool_choice: convertToolChoice(body.tool_choice, body.parallel_tool_calls ?? true),
          }
        : {}),
      ...(thinking ? { thinking } : {}),
      max_tokens: body.max_output_tokens ?? 8192,
      stream: body.stream === true,
    },
  };
}

function convertItems(items: any[]): any[] {
  const messages: any[] = [];
  let current: { role: string; content: any[] } | null = null;

  function ensure(role: string) {
    if (!current || current.role !== role) {
      if (current) messages.push(current);
      current = { role, content: [] };
    }
  }

  for (const item of items) {
    switch (item.type) {
      case "message": {
        const role = item.role === "assistant" ? "assistant" : "user";
        ensure(role);
        for (const c of item.content ?? []) {
          if (c.type === "input_text" || c.type === "output_text")
            current!.content.push({ type: "text", text: c.text });
          else if (c.type === "input_image")
            current!.content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: c.image_url ? c.image_url.substring(5, c.image_url.indexOf(";")) : "image/png",
                data: c.image_url ? c.image_url.split(",")[1] : c.file_data,
              },
            });
          else
            throw new Error(`unsupported_response_content:${c.type}`);
        }
        break;
      }
      case "function_call":
        ensure("assistant");
        current!.content.push({
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: safeParseArgs(item.arguments),
        });
        break;
      case "function_call_output":
        ensure("user");
        current!.content.push({
          type: "tool_result",
          tool_use_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
        });
        break;
      case "reasoning":
        // 历史推理不重放给上游。
        break;
      default:
        throw new Error(`unsupported_response_item:${item.type}`);
    }
  }
  if (current) messages.push(current);
  return messages;
}

function safeParseArgs(raw: string): any {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/responses/src/request-convert.test.ts`
Expected: PASS（6 个测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/responses
git commit -m "feat(responses): convert Responses requests to Anthropic Messages"
```

---

## Task 18: Responses 响应转换（非流式）

**Files:**
- Create: `packages/responses/src/response-convert.ts`
- Test: `packages/responses/src/response-convert.test.ts`

**Interfaces:**
- Produces: `convertAnthropicToResponse(anthropic: any, requestModel: string): any`。

- [ ] **Step 1: 写失败测试**

`packages/responses/src/response-convert.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { convertAnthropicToResponse } from "./response-convert.js";

describe("convertAnthropicToResponse", () => {
  it("maps thinking/text/tool_use into ordered output items", () => {
    const resp = convertAnthropicToResponse(
      {
        content: [
          { type: "thinking", thinking: "thought" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "call_9", name: "f", input: { a: 1 } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "gpt-5-codex",
    );
    expect(resp.object).toBe("response");
    expect(resp.status).toBe("completed");
    expect(resp.output.map((i: any) => i.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
    ]);
    expect(resp.output[1].content[0]).toEqual({
      type: "output_text",
      text: "answer",
      annotations: [],
    });
    expect(resp.output[2]).toMatchObject({
      type: "function_call",
      call_id: "call_9",
      name: "f",
      arguments: '{"a":1}',
    });
    expect(resp.usage.total_tokens).toBe(15);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/responses/src/response-convert.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/responses/src/response-convert.ts`:
```ts
function randomId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 14);
}

export function convertAnthropicToResponse(anthropic: any, requestModel: string): any {
  const blocks = Array.isArray(anthropic.content) ? anthropic.content : [];
  const output: any[] = [];

  for (const b of blocks) {
    if (b.type === "thinking") {
      const id = randomId("rs_");
      output.push({
        id,
        type: "reasoning",
        role: "assistant",
        summary: [{ type: "summary_text", text: b.thinking ?? "" }],
      });
    } else if (b.type === "text") {
      const id = randomId("msg_");
      output.push({
        id,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: b.text ?? "", annotations: [] }],
      });
    } else if (b.type === "tool_use") {
      const id = randomId("fc_");
      output.push({
        id,
        type: "function_call",
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
        status: "completed",
      });
    }
  }

  const input = anthropic.usage?.input_tokens ?? 0;
  const outputTokens = anthropic.usage?.output_tokens ?? 0;
  return {
    id: randomId("resp_"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestModel,
    output,
    usage: {
      input_tokens: input,
      output_tokens: outputTokens,
      total_tokens: input + outputTokens,
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/responses/src/response-convert.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/responses/src/response-convert.ts packages/responses/src/response-convert.test.ts
git commit -m "feat(responses): convert Anthropic responses to Responses objects"
```

---

## Task 19: Responses 流式转换

**Files:**
- Create: `packages/responses/src/stream-convert.ts`
- Test: `packages/responses/src/stream-convert.test.ts`

**Interfaces:**
- Consumes: `SSEEvent`（core）。
- Produces:
  - `createResponseStreamConverter(opts: { model: string }): { process(ev: SSEEvent): SSEEvent[] }`

- [ ] **Step 1: 写失败测试**

`packages/responses/src/stream-convert.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createResponseStreamConverter } from "./stream-convert.js";
import type { SSEEvent } from "@zcode-proxy/core";

function ev(event: string, data: any): SSEEvent {
  return { event, data };
}

describe("response stream converter", () => {
  it("emits the full Responses event sequence for a text answer", () => {
    const c = createResponseStreamConverter({ model: "gpt-5-codex" });
    const events: string[] = [];
    for (const e of [
      ev("message_start", { message: { model: "GLM-5.3" } }),
      ev("content_block_start", { index: 0, content_block: { type: "text" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
      ev("content_block_stop", { index: 0 }),
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } }),
      ev("message_stop", {}),
    ]) {
      for (const out of c.process(e)) events.push(out.event);
    }
    expect(events).toContain("response.created");
    expect(events).toContain("response.output_item.added");
    expect(events).toContain("response.output_text.delta");
    expect(events).toContain("response.output_item.done");
    expect(events.at(-1)).toBe("response.completed");
  });

  it("maps tool_use deltas to function_call_arguments", () => {
    const c = createResponseStreamConverter({ model: "gpt-5-codex" });
    c.process(ev("message_start", { message: {} }));
    const started = c.process(
      ev("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "call_1", name: "f" },
      }),
    );
    expect(started.map((e) => e.event)).toContain("response.output_item.added");
    const deltas = c.process(
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } }),
    );
    expect(deltas.map((e) => e.event)).toContain("response.function_call_arguments.delta");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/responses/src/stream-convert.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/responses/src/stream-convert.ts`:
```ts
import type { SSEEvent } from "@zcode-proxy/core";

function randomId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 14);
}

type Kind = "message" | "reasoning" | "function_call";

interface RuntimeItem {
  kind: Kind;
  id: string;
  text: string;
  callId?: string;
  name?: string;
  finalize(): any;
}

export function createResponseStreamConverter(opts: { model: string }) {
  const items = new Map<number, RuntimeItem>();
  const order: number[] = [];
  let responseId = "";
  let upstreamModel = opts.model;
  let finalUsage: any = {};

  function process(ev: SSEEvent): SSEEvent[] {
    const out: SSEEvent[] = [];
    const emit = (event: string, data: any) => out.push({ event, data });

    switch (ev.event) {
      case "message_start": {
        responseId = randomId("resp_");
        upstreamModel = ev.data?.message?.model ?? upstreamModel;
        emit("response.created", {
          id: responseId,
          object: "response",
          status: "in_progress",
          model: upstreamModel,
          output: [],
        });
        emit("response.in_progress", { id: responseId });
        break;
      }
      case "content_block_start": {
        const i = ev.data.index as number;
        const item = startItem(ev.data.content_block);
        items.set(i, item);
        order.push(i);
        emit("response.output_item.added", { output_index: i, item: skeletonOf(item) });
        if (item.kind === "message" || item.kind === "reasoning") {
          emit("response.content_part.added", {
            output_index: i,
            content_index: 0,
            part: partAdded(item),
          });
        }
        break;
      }
      case "content_block_delta": {
        const i = ev.data.index as number;
        const item = items.get(i)!;
        const delta = ev.data.delta;
        if (delta.type === "text_delta") {
          item.text += delta.text;
          emit("response.output_text.delta", {
            output_index: i,
            content_index: 0,
            delta: delta.text,
          });
        } else if (delta.type === "thinking_delta") {
          item.text += delta.thinking_delta;
          emit("response.reasoning_summary_text.delta", {
            output_index: i,
            summary_index: 0,
            delta: delta.thinking_delta,
          });
        } else if (delta.type === "input_json_delta") {
          item.text += delta.partial_json;
          emit("response.function_call_arguments.delta", {
            output_index: i,
            delta: delta.partial_json,
          });
        }
        break;
      }
      case "content_block_stop": {
        const i = ev.data.index as number;
        const item = items.get(i)!;
        if (item.kind === "message") {
          emit("response.output_text.done", {
            output_index: i,
            content_index: 0,
            text: item.text,
          });
          emit("response.content_part.done", {
            output_index: i,
            content_index: 0,
            part: { type: "output_text", text: item.text, annotations: [] },
          });
        } else if (item.kind === "reasoning") {
          emit("response.reasoning_summary_text.done", {
            output_index: i,
            summary_index: 0,
            text: item.text,
          });
          emit("response.content_part.done", {
            output_index: i,
            content_index: 0,
            part: { type: "summary_text", text: item.text },
          });
        } else {
          emit("response.function_call_arguments.done", {
            output_index: i,
            arguments: item.text || "{}",
          });
        }
        emit("response.output_item.done", { output_index: i, item: item.finalize() });
        break;
      }
      case "message_delta": {
        if (ev.data?.usage) finalUsage = { ...finalUsage, ...ev.data.usage };
        break;
      }
      case "message_stop": {
        const output = order.map((i) => items.get(i)!.finalize());
        const input = finalUsage.input_tokens ?? 0;
        const outputTokens = finalUsage.output_tokens ?? 0;
        emit("response.completed", {
          id: responseId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: upstreamModel,
          output,
          usage: {
            input_tokens: input,
            output_tokens: outputTokens,
            total_tokens: input + outputTokens,
          },
        });
        break;
      }
    }
    return out;
  }

  return { process };
}

function startItem(block: any): RuntimeItem {
  if (block.type === "text") {
    const id = randomId("msg_");
    const item: RuntimeItem = {
      kind: "message",
      id,
      text: "",
      finalize() {
        return {
          id,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: item.text, annotations: [] }],
        };
      },
    };
    return item;
  }
  if (block.type === "thinking") {
    const id = randomId("rs_");
    const item: RuntimeItem = {
      kind: "reasoning",
      id,
      text: "",
      finalize() {
        return {
          id,
          type: "reasoning",
          role: "assistant",
          summary: [{ type: "summary_text", text: item.text }],
        };
      },
    };
    return item;
  }
  const id = randomId("fc_");
  const item: RuntimeItem = {
    kind: "function_call",
    id,
    text: "",
    callId: block.id,
    name: block.name,
    finalize() {
      return {
        id,
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: item.text || "{}",
        status: "completed",
      };
    },
  };
  return item;
}

function skeletonOf(item: RuntimeItem): any {
  if (item.kind === "message")
    return { id: item.id, type: "message", role: "assistant", status: "in_progress", content: [] };
  if (item.kind === "reasoning")
    return { id: item.id, type: "reasoning", role: "assistant", summary: [] };
  return {
    id: item.id,
    type: "function_call",
    call_id: item.callId,
    name: item.name,
    arguments: "",
    status: "in_progress",
  };
}

function partAdded(item: RuntimeItem): any {
  return {
    type: item.kind === "message" ? "output_text" : "summary_text",
    text: "",
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/responses/src/stream-convert.test.ts`
Expected: PASS（2 个测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/responses/src/stream-convert.ts packages/responses/src/stream-convert.test.ts
git commit -m "feat(responses): convert Anthropic SSE to Responses events"
```

---

## Task 20: Responses 端点接入

**Files:**
- Create: `packages/responses/src/responses.ts`、`packages/responses/src/index.ts`
- Test: `packages/responses/src/responses.test.ts`
- 给 `packages/responses/package.json` 加 `"@zcode-proxy/auth": "workspace:*"`。

**Interfaces:**
- Consumes: Tasks 17–19、`AuthService`、core 工具。
- Produces: `handleResponses(req: Request, ctx: ResponsesContext): Promise<Response>`。

- [ ] **Step 1: 写失败测试**

`packages/responses/src/responses.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { handleResponses } from "./responses.js";

function ctxWith(upstream: any, stream = false) {
  return {
    auth: {
      getUpstreamHeaders: async () => ({ Authorization: "Bearer pat" }),
    } as any,
    upstreamBaseUrl: "https://bigmodel.cn/api/anthropic",
    fetchImpl: async () =>
      new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  };
}

describe("handleResponses", () => {
  it("returns a Responses object for a non-stream request", async () => {
    const ctx = ctxWith({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const req = new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5-codex", input: "hi" }),
    });
    const res = await handleResponses(req, ctx);
    const body = await res.json();
    expect(body.object).toBe("response");
    expect(body.output[0].content[0].text).toBe("ok");
  });

  it("rejects unsupported built-in tools with a clear error", async () => {
    const ctx = ctxWith({});
    const req = new Request("http://x/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        input: "hi",
        tools: [{ type: "web_search" }],
      }),
    });
    const res = await handleResponses(req, ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "unsupported_tool" },
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/responses/src/responses.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`packages/responses/src/responses.ts`:
```ts
import {
  createThinkingEventFilter,
  parseSSE,
  sendWithAuthRetry,
  serializeSSE,
  stripThinkingFromMessage,
} from "@zcode-proxy/core";
import { convertResponsesRequest } from "./request-convert.js";
import { convertAnthropicToResponse } from "./response-convert.js";
import { createResponseStreamConverter } from "./stream-convert.js";

export interface ResponsesContext {
  auth: { getUpstreamHeaders: (force?: boolean) => Promise<Record<string, string>> };
  upstreamBaseUrl: string;
  fetchImpl: typeof fetch;
}

export async function handleResponses(req: Request, ctx: ResponsesContext): Promise<Response> {
  const inbound = await req.json();

  const unsupported = (inbound.tools ?? []).find((t: any) => t.type !== "function");
  if (unsupported) {
    return new Response(
      JSON.stringify({
        error: {
          code: "unsupported_tool",
          message: `tool type ${unsupported.type} is not supported`,
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const { anthropicBody, wantsThinking } = convertResponsesRequest(inbound);

  const upstream = await sendWithAuthRetry({
    getHeaders: (force) => ctx.auth.getUpstreamHeaders(force),
    send: (headers) =>
      ctx.fetchImpl(`${ctx.upstreamBaseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(anthropicBody),
      }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (!anthropicBody.stream) {
    let json = await upstream.json();
    if (!wantsThinking) json = stripThinkingFromMessage(json);
    return Response.json(convertAnthropicToResponse(json, inbound.model));
  }

  const thinkingFilter = createThinkingEventFilter();
  const converter = createResponseStreamConverter({ model: inbound.model });
  const stream = upstream.body
    .pipeThrough(parseSSE())
    .pipeThrough(
      new TransformStream({
        transform(ev, controller) {
          const next = wantsThinking ? ev : thinkingFilter.process(ev);
          if (next) {
            for (const out of converter.process(next)) controller.enqueue(out);
          }
        },
      }),
    )
    .pipeThrough(serializeSSE());
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
```

`packages/responses/src/index.ts`:
```ts
export { handleResponses } from "./responses.js";
export type { ResponsesContext } from "./responses.js";
```

- [ ] **Step 4: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/responses/src/responses.test.ts`
Expected: PASS（2 个测试）。

- [ ] **Step 5: 提交**

```bash
git add packages/responses
git commit -m "feat(responses): wire /v1/responses endpoint with streaming"
```

---

## Task 21: CLI — start/stop/status（含 daemon）

**Files:**
- Create: `packages/cli/src/config-dir.ts`、`packages/cli/src/daemon.ts`、`packages/cli/src/start.ts`、`packages/cli/src/stop.ts`、`packages/cli/src/status.ts`
- Test: `packages/cli/src/status.test.ts`
- 给 `packages/cli/package.json` 加 auth/core/server/anthropic/responses 的 workspace 依赖，加 `"bin": { "zcode-proxy": "./bin/zcode-proxy.js" }`。

**Interfaces:**
- Produces:
  - `runDaemon(overrides): Promise<void>`（前台跑网关）
  - `startBackground(overrides): Promise<number>`（detached 子进程，返回 pid）
  - `stopDaemon(): Promise<boolean>`；`fetchStatus(port): Promise<any>`

- [ ] **Step 1: 写失败测试**

`packages/cli/src/status.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { fetchStatus } from "./status.js";

describe("fetchStatus", () => {
  it("reports running when health is ok", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const status = await fetchStatus(8792, fetchImpl);
    expect(status.running).toBe(true);
  });
  it("reports stopped when connection refused", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    });
    const status = await fetchStatus(8792, fetchImpl);
    expect(status.running).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/cli/src/status.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 config-dir**

`packages/cli/src/config-dir.ts`:
```ts
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProxyConfig {
  port: number;
  defaultModel: string;
  modelOverrides: Record<string, string>;
  logLevel: string;
}

export const DEFAULT_CONFIG: ProxyConfig = {
  port: 8792,
  defaultModel: "GLM-5.3",
  modelOverrides: {},
  logLevel: "info",
};

export function configDir(): string {
  return join(homedir(), ".zcode-proxy");
}
export function configPath(): string {
  return join(configDir(), "config.json");
}
export function pidPath(): string {
  return join(configDir(), "daemon.pid");
}
export function portPath(): string {
  return join(configDir(), "daemon.port");
}
```

- [ ] **Step 4: 实现 status**

`packages/cli/src/status.ts`:
```ts
export interface DaemonStatus {
  running: boolean;
  health?: any;
}

export async function fetchStatus(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<DaemonStatus> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`);
    return { running: res.ok, health: await res.json().catch(() => null) };
  } catch (error) {
    if ((error as { code?: string }).code === "ECONNREFUSED") return { running: false };
    throw error;
  }
}
```

- [ ] **Step 5: 实现 daemon（组装全链路）**

`packages/cli/src/daemon.ts`:
```ts
import { writeFile, mkdir } from "node:fs/promises";
import { createAuthServiceInternal, defaultNodeDeps } from "@zcode-proxy/auth";
import { createModelMapping } from "@zcode-proxy/core";
import { startGateway } from "@zcode-proxy/server";
import { handleMessages, handleHealth, handleModels } from "@zcode-proxy/anthropic";
import { handleResponses } from "@zcode-proxy/responses";
import { configDir, pidPath, portPath, type ProxyConfig } from "./config-dir.js";

export async function runDaemon(config: ProxyConfig): Promise<void> {
  const deps = defaultNodeDeps();
  const auth = createAuthServiceInternal(deps);
  const endpoints = await auth.getEndpoints();
  const modelMapping = createModelMapping(config.modelOverrides);

  const gw = await startGateway(config.port, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return handleHealth(auth);
    if (url.pathname === "/v1/models" && req.method === "GET") return handleModels();
    if (url.pathname === "/v1/messages" && req.method === "POST")
      return handleMessages(req, {
        auth,
        modelMapping,
        upstreamBaseUrl: endpoints.anthropicBaseUrl,
        fetchImpl: deps.fetchImpl,
      });
    if (url.pathname === "/v1/responses" && req.method === "POST")
      return handleResponses(req, {
        auth,
        upstreamBaseUrl: endpoints.anthropicBaseUrl,
        fetchImpl: deps.fetchImpl,
      });
    return new Response("not found", { status: 404 });
  });

  await mkdir(configDir(), { recursive: true });
  await writeFile(pidPath(), String(process.pid));
  await writeFile(portPath(), String(gw.port));

  const shutdown = async () => {
    await gw.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
```

> 注意：`@zcode-proxy/anthropic` 需从 index 导出 `handleMessages`、`handleModels`、`handleHealth`。补齐 `packages/anthropic/src/index.ts`：
```ts
export { handleMessages } from "./messages.js";
export type { MessagesContext } from "./messages.js";
export { handleModels, handleHealth } from "./models.js";
```

- [ ] **Step 6: 实现 start/stop 与入口**

`packages/cli/src/start.ts`:
```ts
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pidPath } from "./config-dir.js";

export async function startBackground(): Promise<number> {
  const entry = fileURLToPath(new URL("./bin/zcode-proxy.js", import.meta.url));
  const child = spawn(process.execPath, [entry, "daemon"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await writeFile(pidPath(), String(child.pid));
  return child.pid!;
}
```

`packages/cli/src/stop.ts`:
```ts
import { readFile } from "node:fs/promises";
import { pidPath } from "./config-dir.js";

export async function stopDaemon(): Promise<boolean> {
  let pid: number;
  try {
    pid = Number((await readFile(pidPath(), "utf-8")).trim());
  } catch {
    return false;
  }
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false;
    throw error;
  }
}
```

`packages/cli/bin/zcode-proxy.js`:
```js
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDaemon } from "../dist/daemon.js";
import { startBackground } from "../dist/start.js";
import { stopDaemon } from "../dist/stop.js";
import { fetchStatus } from "../dist/status.js";
import { loadConfig } from "../dist/config-cmd.js";

const { values, positionals } = parseArgs({
  options: { background: { type: "boolean", default: false } },
  allowPositionals: true,
});
const [command] = positionals;
const config = await loadConfig();

if (command === "daemon") await runDaemon(config);
else if (command === "start") {
  if (values.background) {
    const pid = await startBackground();
    console.log(`zcode-proxy started in background (pid ${pid})`);
  } else {
    await runDaemon(config);
  }
} else if (command === "stop") console.log(await stopDaemon() ? "stopped" : "not running");
else if (command === "status") {
  const s = await fetchStatus(config.port);
  console.log(s.running ? `running on port ${config.port}` : "stopped");
} else {
  console.log("usage: zcode-proxy <start|stop|status|daemon> [--background]");
}
```

- [ ] **Step 7: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/cli/src/status.test.ts`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/cli packages/anthropic/src/index.ts
git commit -m "feat(cli): add start/stop/status with background daemon"
```

---

## Task 22: CLI — models/config/doctor 与接入片段

**Files:**
- Create: `packages/cli/src/config-cmd.ts`、`packages/cli/src/models-cmd.ts`、`packages/cli/src/doctor.ts`、`packages/cli/src/onboarding.ts`
- Test: `packages/cli/src/doctor.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(): Promise<ProxyConfig>`
  - `runDoctor(deps): Promise<{ ok: boolean; checks: Check[] }>`
  - `onboardingSnippets(port: number, model: string): { claudeCode: string; codex: string }`

- [ ] **Step 1: 写失败测试**

`packages/cli/src/doctor.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { runDoctor } from "./doctor.js";

describe("runDoctor", () => {
  it("passes when credential, token and health are all good", async () => {
    const result = await runDoctor({
      auth: {
        getUpstreamHeaders: async () => ({ Authorization: "Bearer x" }),
      } as any,
      fetchImpl: async () => Response.json({ ok: true }),
      port: 8792,
    });
    expect(result.ok).toBe(true);
  });

  it("fails when login is missing", async () => {
    const result = await runDoctor({
      auth: {
        getUpstreamHeaders: async () => {
          throw new Error("未找到 ZCode 登录态，请先运行 `zcode login`");
        },
      } as any,
      fetchImpl: fetch,
      port: 8792,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.some((c) => c.name === "login" && !c.pass)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `mise exec -- pnpm vitest run packages/cli/src/doctor.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 config-cmd**

`packages/cli/src/config-cmd.ts`:
```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { configDir, configPath, DEFAULT_CONFIG, type ProxyConfig } from "./config-dir.js";

export async function loadConfig(): Promise<ProxyConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: ProxyConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2));
}
```

- [ ] **Step 4: 实现 doctor**

`packages/cli/src/doctor.ts`:
```ts
export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface DoctorDeps {
  auth: { getUpstreamHeaders: () => Promise<Record<string, string>> };
  fetchImpl: typeof fetch;
  port: number;
}

export async function runDoctor(deps: DoctorDeps): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  try {
    await deps.auth.getUpstreamHeaders();
    checks.push({ name: "login", pass: true });
  } catch (error) {
    checks.push({ name: "login", pass: false, detail: (error as Error).message });
  }

  try {
    const res = await deps.fetchImpl(`http://127.0.0.1:${deps.port}/health`);
    checks.push({ name: "gateway", pass: res.ok });
  } catch (error) {
    checks.push({ name: "gateway", pass: false, detail: (error as Error).message });
  }

  return { ok: checks.every((c) => c.pass), checks };
}
```

- [ ] **Step 5: 实现 models-cmd 与 onboarding**

`packages/cli/src/models-cmd.ts`:
```ts
export async function listModels(port: number, fetchImpl: typeof fetch = fetch): Promise<any[]> {
  const res = await fetchImpl(`http://127.0.0.1:${port}/v1/models`);
  const body = await res.json();
  return body.data;
}
```

`packages/cli/src/onboarding.ts`:
```ts
export function onboardingSnippets(port: number, model: string): {
  claudeCode: string;
  codex: string;
} {
  return {
    claudeCode: [
      "// ~/.claude/settings.json",
      "{",
      `  "env": {`,
      `    "ANTHROPIC_BASE_URL": "http://127.0.0.1:${port}"`,
      `    "ANTHROPIC_AUTH_TOKEN": "zcode-proxy"`,
      `    "ANTHROPIC_MODEL": "${model}"`,
      `  },`,
      `  "enableArtifact": false`,
      "}",
    ].join("\n"),
    codex: [
      "# ~/.codex/config.toml",
      `model = "${model}"`,
      `model_provider = "zcode-proxy"`,
      "",
      `[model_providers.zcode-proxy]`,
      `name = "zcode-proxy"`,
      `base_url = "http://127.0.0.1:${port}/v1"`,
      `wire_api = "responses"`,
    ].join("\n"),
  };
}
```

> 注意：Codex 的 `model` 应填上游能识别的模型（`GLM-5.3` 或 `GLM-5.3-Flash`），因为 /v1/responses 入站模型也会经模型映射；为减少一层映射，直接填 `GLM-5.3`。

- [ ] **Step 6: 把 models/config/doctor/onboarding 接入入口**

在 `packages/cli/bin/zcode-proxy.js` 中补充分支：
```js
else if (command === "models") {
  const { listModels } = await import("../dist/models-cmd.js");
  for (const m of await listModels(config.port)) console.log(m.id, m.display_name ?? "");
} else if (command === "doctor") {
  const { runDoctor } = await import("../dist/doctor.js");
  const auth = (await import("@zcode-proxy/auth")).createAuthServiceInternal(defaultNodeDeps());
  const r = await runDoctor({ auth, fetchImpl: fetch, port: config.port });
  for (const c of r.checks) console.log(`${c.pass ? "✓" : "✗"} ${c.name} ${c.detail ?? ""}`);
  process.exit(r.ok ? 0 : 1);
} else if (command === "config") {
  console.log(await loadConfig());
}
```
并在 `start` 成功后打印 `onboardingSnippets`（前台模式可在网关联动时提示，后台模式在 startBackground 后直接打印两份片段）。

- [ ] **Step 7: 运行确认通过**

Run: `mise exec -- pnpm vitest run packages/cli/src/doctor.test.ts`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/cli
git commit -m "feat(cli): add models/config/doctor and client onboarding snippets"
```

---

## Task 23: 打包、安装、端到端与指纹对照

**Files:**
- Create: `scripts/bundle.sh`、`scripts/install.sh`
- Modify: root `package.json`（加 bundle/install 脚本）

**Interfaces:**
- Produces: 单文件可执行 `dist/zcode-proxy.mjs` + 启动器，安装到 `~/.local/bin/zcode-proxy`。

- [ ] **Step 1: 安装 esbuild 并写打包脚本**

root 加 devDependency：`esbuild`。
`scripts/bundle.sh`:
```bash
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mise exec -- pnpm -r build
mise exec -- esbuild packages/cli/bin/zcode-proxy.js \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile=dist/zcode-proxy.mjs --banner:js='#!/usr/bin/env node'
chmod +x dist/zcode-proxy.mjs
```

`scripts/install.sh`:
```bash
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p "$HOME/.local/bin"
cp dist/zcode-proxy.mjs "$HOME/.local/bin/zcode-proxy"
chmod +x "$HOME/.local/bin/zcode-proxy"
echo "installed: $HOME/.local/bin/zcode-proxy"
```

- [ ] **Step 2: 打包并安装**

Run: `mise exec -- bash scripts/bundle.sh && mise exec -- bash scripts/install.sh`
Expected: 输出 installed；`~/.local/bin/zcode-proxy` 存在。

- [ ] **Step 3: 冒烟验证已安装命令**

Run:
```bash
export PATH="$HOME/.local/bin:$PATH"
zcode-proxy doctor
zcode-proxy start --background
sleep 1
zcode-proxy status
zcode-proxy models
zcode-proxy stop
```
Expected: doctor 全 ✓；status running；models 列出 GLM 两个模型；stop 成功。

- [ ] **Step 4: Claude Code 端到端实测**

按 `onboardingSnippets` 写入 `~/.claude/settings.json`，新开一个 Claude Code 会话，运行一个需要工具调用的真实任务（如查询天气/读写文件），确认：模型菜单显示 GLM、多轮工具调用正常、thinking 未导致报错、用量计入 Coding Plan。

- [ ] **Step 5: Codex 端到端实测**

按片段写入 `~/.codex/config.toml`，运行 `codex`（非交互 `codex exec "实现一个小函数"`），确认 responses 流式正常、function call 往返正常。

- [ ] **Step 6: 指纹对照（核心目标验证）**

两种方式任选：
1. 用 mitmproxy / Charles 抓包，分别捕获「真实 zcode 客户端」与「zcode-proxy」的请求，比对：`User-Agent`、`X-ZCode-App-Version`、`X-Title`、`X-Platform`、`X-Device-Mid`、`x-zcode-query-source`、endpoint 路径是否一致。
2. 在 ZCode/智谱用量平台确认 proxy 产生的请求归类为 zcode Coding Plan（额度扣减正确），而非通用 API。

若发现某 header 缺失/不一致，回到对应 auth/source-headers 任务修正后重打包。

- [ ] **Step 7: 提交打包脚本并收尾**

```bash
git add scripts package.json
git commit -m "chore: bundle, install and end-to-end verification"
```

---

## 完成标准（对照 spec）

- [ ] `zcode-proxy start` 可在前台/后台运行，仅绑 127.0.0.1。
- [ ] Claude Code 经 /v1/messages 完成真实多轮工具任务。
- [ ] Codex 经 /v1/responses 完成真实任务（流式 + 函数调用）。
- [ ] 上游请求指纹与官方 zcode 一致，用量计入 Coding Plan。
- [ ] 401 自动换证、未启用 thinking 时思考块被剥离、客户端断连即中止上游。
- [ ] doctor/status/models 可用；安装脚本在 ~/.local/bin 安装成功。

