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
