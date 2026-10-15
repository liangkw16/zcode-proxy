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
  getAccessToken(
    force?: boolean,
    failedToken?: string,
  ): Promise<{ token: string; expiresAt: number }>;
  getUpstreamHeaders(force?: boolean, failedToken?: string): Promise<Record<string, string>>;
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
  // Whether the current locationMaterial promise is still resolving. A forced
  // refresh while one is in flight reuses it so concurrent refreshes share one
  // credential reload + project lookup.
  let materialInFlight = false;

  function buildLocationMaterial() {
    return (async () => {
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

  function resolveLocationMaterial(force = false) {
    // A forced refresh re-reads the credential (re-login / rotated token), but
    // only when nothing is in flight so concurrent forces coalesce.
    if (force && !materialInFlight) locationMaterial = undefined;
    if (!locationMaterial) {
      materialInFlight = true;
      const promise = buildLocationMaterial();
      locationMaterial = promise;
      // Observe settlement without replacing the stored promise, so identity
      // checks below stay valid.
      promise.then(
        () => {
          if (locationMaterial === promise) materialInFlight = false;
        },
        () => {
          // A failed resolution is not cached forever: clear it so a later
          // request retries after a transient upstream failure.
          if (locationMaterial === promise) {
            materialInFlight = false;
            locationMaterial = undefined;
          }
        },
      );
    }
    return locationMaterial;
  }

  async function getAccessToken(force = false, failedToken?: string) {
    const { ep, loginToken, location } = await resolveLocationMaterial(force);
    const scope = { managementOrigin: ep.managementOrigin, location };
    if (force) cache.invalidate(scope, failedToken);
    return cache.resolve(scope, () =>
      issueProjectAccessToken({
        fetchImpl: deps.fetchImpl,
        managementOrigin: ep.managementOrigin,
        location,
        loginToken,
      }),
    );
  }

  async function getUpstreamHeaders(
    force = false,
    failedToken?: string,
  ): Promise<Record<string, string>> {
    await endpoints();
    const deviceMid = await readDeviceMid({
      readTextFile: deps.readTextFile,
      homedir: deps.homedir,
    });
    const locale = Intl.DateTimeFormat().resolvedOptions();
    const token = await getAccessToken(force, failedToken);
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
