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
