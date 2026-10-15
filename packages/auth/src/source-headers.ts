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
