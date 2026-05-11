// src/Auth.ts — VZ-197 OAuth 2.1 PKCE flow adapted for Apps Script.
//
// Apps Script doesn't expose a popup/dialog API on Docs — the
// recommended pattern is to surface a CardService AuthorizationAction
// that opens a new browser tab with `/oauth/authorize`. The
// redirect_uri is the Apps Script "user-callback" URL, which only
// exists once the script has been published as a web-app. The
// callback function (`doGet`) reads `?code=&state=` from the request
// and exchanges via `/oauth/token` before storing both tokens in
// PropertiesService.getUserProperties() (per-user, encrypted-at-rest
// by Google).

import type { OAuthTokens } from "./types";
import { getConfig } from "./config";
import type { SyncFetchPort } from "./Scan";

const ACCESS_KEY = "veritize.access_token";
const REFRESH_KEY = "veritize.refresh_token";
const EXPIRES_KEY = "veritize.expires_at";
const VERIFIER_KEY = "veritize.pkce_verifier";
const STATE_KEY = "veritize.pkce_state";

export class OAuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers (pure functions, fully testable without Apps Script).
// ---------------------------------------------------------------------------

export function bytesToBase64Url(bytes: number[] | Uint8Array): string {
  // Build the base64 alphabet manually so this works in Apps Script
  // (no `btoa`, no `Buffer`). Apps Script does expose `Utilities`
  // but we keep this pure to keep the unit tests fast.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const arr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
  let output = "";
  for (let i = 0; i < arr.length; i += 3) {
    const b1 = arr[i];
    const b2 = i + 1 < arr.length ? arr[i + 1] : -1;
    const b3 = i + 2 < arr.length ? arr[i + 2] : -1;
    output += alphabet[b1 >> 2];
    output += alphabet[((b1 & 3) << 4) | (b2 === -1 ? 0 : b2 >> 4)];
    if (b2 === -1) break;
    output += alphabet[((b2 & 15) << 2) | (b3 === -1 ? 0 : b3 >> 6)];
    if (b3 === -1) break;
    output += alphabet[b3 & 63];
  }
  return output;
}

// Apps Script doesn't have `crypto.getRandomValues`. It has
// `Math.random` (insufficient for security) and
// `Utilities.getUuid` (cryptographic strength). For PKCE we want at
// least 32 bytes of entropy → derive from two UUIDs.
export function randomBytes(n: number, uuidProvider: () => string): number[] {
  const bytes: number[] = [];
  let uuid = uuidProvider();
  let pos = 0;
  while (bytes.length < n) {
    if (pos >= uuid.length - 1) {
      uuid = uuidProvider();
      pos = 0;
    }
    const ch1 = uuid.charCodeAt(pos);
    const ch2 = uuid.charCodeAt(pos + 1);
    pos += 2;
    // skip dashes
    if (ch1 === 45 || ch2 === 45) continue;
    // Parse two hex chars into one byte.
    const hi = parseInt(String.fromCharCode(ch1), 16);
    const lo = parseInt(String.fromCharCode(ch2), 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) continue;
    bytes.push((hi << 4) | lo);
  }
  return bytes;
}

export interface PkceMaterial {
  verifier: string;
  challenge: string;
  state: string;
}

/**
 * Generate PKCE verifier+challenge+state using the supplied
 * dependencies. `sha256` returns the 32-byte digest as a number[]; in
 * Apps Script that's `Utilities.computeDigest(SHA_256, str)`, in
 * tests it's a Node `crypto` shim.
 */
export function buildPkce(
  uuidProvider: () => string,
  sha256: (s: string) => number[],
): PkceMaterial {
  const verifierBytes = randomBytes(32, uuidProvider);
  const verifier = bytesToBase64Url(verifierBytes);
  const digest = sha256(verifier);
  const challenge = bytesToBase64Url(digest.map((b) => b & 0xff));
  const stateBytes = randomBytes(16, uuidProvider);
  const state = bytesToBase64Url(stateBytes);
  return { verifier, challenge, state };
}

export function buildAuthorizeUrl(
  appBaseUrl: string,
  clientId: string,
  redirectUri: string,
  scopes: string,
  challenge: string,
  state: string,
): string {
  const base = appBaseUrl.replace(/\/$/, "") + "/oauth/authorize";
  const params = [
    ["response_type", "code"],
    ["client_id", clientId],
    ["redirect_uri", redirectUri],
    ["scope", scopes],
    ["code_challenge", challenge],
    ["code_challenge_method", "S256"],
    ["state", state],
  ];
  const qs = params
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  return base + "?" + qs;
}

// ---------------------------------------------------------------------------
// Token storage — PropertiesService.getUserProperties() in Apps Script,
// in-memory Map in tests. We expose a tiny port so tests can stub.
// ---------------------------------------------------------------------------

export interface PropsPort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function userPropsPort(): PropsPort {
  const p = PropertiesService.getUserProperties();
  return {
    get: (k) => p.getProperty(k),
    set: (k, v) => {
      p.setProperty(k, v);
    },
    remove: (k) => {
      p.deleteProperty(k);
    },
  };
}

export function loadTokens(props: PropsPort): OAuthTokens | null {
  const access = props.get(ACCESS_KEY);
  const refresh = props.get(REFRESH_KEY);
  const exp = props.get(EXPIRES_KEY);
  if (!access || !refresh || !exp) return null;
  const expires_at = parseInt(exp, 10);
  if (!Number.isFinite(expires_at)) return null;
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: Math.max(0, Math.floor((expires_at - Date.now()) / 1000)),
    expires_at,
  };
}

export function persistTokens(props: PropsPort, t: OAuthTokens): void {
  props.set(ACCESS_KEY, t.access_token);
  props.set(REFRESH_KEY, t.refresh_token);
  props.set(EXPIRES_KEY, String(t.expires_at));
}

export function clearTokens(props: PropsPort): void {
  props.remove(ACCESS_KEY);
  props.remove(REFRESH_KEY);
  props.remove(EXPIRES_KEY);
  props.remove(VERIFIER_KEY);
  props.remove(STATE_KEY);
}

export function persistPkce(props: PropsPort, m: PkceMaterial): void {
  props.set(VERIFIER_KEY, m.verifier);
  props.set(STATE_KEY, m.state);
}

export function readPkce(props: PropsPort): { verifier: string; state: string } | null {
  const verifier = props.get(VERIFIER_KEY);
  const state = props.get(STATE_KEY);
  if (!verifier || !state) return null;
  return { verifier, state };
}

// ---------------------------------------------------------------------------
// Token exchange + refresh — uses the same SyncFetchPort shape as Scan.
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

function tokenUrl(appBaseUrl: string): string {
  return appBaseUrl.replace(/\/$/, "") + "/oauth/token";
}

function formEncode(pairs: Record<string, string>): string {
  return Object.keys(pairs)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(pairs[k]))
    .join("&");
}

export interface ExchangeOpts {
  appBaseUrl: string;
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  fetchPort: SyncFetchPort;
  now: () => number;
}

export function exchangeCodeForTokens(opts: ExchangeOpts): OAuthTokens {
  const body = formEncode({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  const res = opts.fetchPort(tokenUrl(opts.appBaseUrl), {
    method: "post",
    headers: {},
    contentType: "application/x-www-form-urlencoded",
    payload: body,
    muteHttpExceptions: true,
  });
  if (res.code < 200 || res.code >= 300) {
    let msg = "token exchange returned " + res.code;
    try {
      const j = JSON.parse(res.body) as { error?: string };
      if (j && j.error) msg = j.error;
    } catch { /* keep default msg */ }
    throw new OAuthError("token_exchange_failed", msg);
  }
  const data = JSON.parse(res.body) as TokenResponse;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: opts.now() + data.expires_in * 1000,
  };
}

export interface RefreshOpts {
  appBaseUrl: string;
  clientId: string;
  refreshToken: string;
  fetchPort: SyncFetchPort;
  now: () => number;
}

export function refreshAccessToken(opts: RefreshOpts): OAuthTokens {
  const body = formEncode({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  const res = opts.fetchPort(tokenUrl(opts.appBaseUrl), {
    method: "post",
    headers: {},
    contentType: "application/x-www-form-urlencoded",
    payload: body,
    muteHttpExceptions: true,
  });
  if (res.code < 200 || res.code >= 300) {
    throw new OAuthError("refresh_failed", "refresh returned " + res.code);
  }
  const data = JSON.parse(res.body) as TokenResponse;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    expires_at: opts.now() + data.expires_in * 1000,
  };
}

/**
 * Helper for /v1/* fetch wrappers: when a 401 comes back, call this
 * to rotate the access token and retry the request once. Returns the
 * new access_token (caller should re-issue the fetch with it) or null
 * if rotation failed (caller should drop to sign-in flow).
 */
export interface RefreshOnUnauthorizedOpts {
  props: PropsPort;
  fetchPort: SyncFetchPort;
  now: () => number;
}

export function refreshOnUnauthorized(opts: RefreshOnUnauthorizedOpts): string | null {
  const cfg = getConfig();
  const stored = loadTokens(opts.props);
  if (!stored) return null;
  try {
    const next = refreshAccessToken({
      appBaseUrl: cfg.appBaseUrl,
      clientId: cfg.clientId,
      refreshToken: stored.refresh_token,
      fetchPort: opts.fetchPort,
      now: opts.now,
    });
    persistTokens(opts.props, next);
    return next.access_token;
  } catch {
    clearTokens(opts.props);
    return null;
  }
}
