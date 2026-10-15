import { loginWithZaiBusinessJwt } from "./business-login.js";
import { AccessTokenCache } from "./access-token.js";
import { issueProjectAccessToken } from "./access-token.js";
import { loadCredential } from "./credential-loader.js";
import { resolveEndpoints, ZCODE_APP_VERSION, type Endpoints } from "./endpoints.js";
import { readDeviceMid } from "./device-mid.js";
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
    await endpoints();
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
