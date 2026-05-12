// oauth.test.ts — VZ-200-5: OAuth PKCE helpers.

import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import {
  bytesToBase64Url,
  buildPkce,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  loadTokens,
  persistTokens,
  clearTokens,
  refreshOnUnauthorized,
  type PropsPort,
  randomBytes,
  OAuthError,
} from "../Auth";
import type { SyncFetchPort, SyncFetchResponse } from "../Scan";

function memProps(initial: Record<string, string> = {}): PropsPort {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: (k) => store.get(k) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
    remove: (k) => {
      store.delete(k);
    },
  };
}

function sha256(s: string): number[] {
  return Array.from(crypto.createHash("sha256").update(s).digest());
}

function uuidProvider(): () => string {
  let i = 0;
  return () => crypto.randomUUID() + "-" + i++;
}

describe("bytesToBase64Url", () => {
  it("encodes a known fixture matching RFC 7636 §A.1", () => {
    // Verifier 'abc' → base64url 'YWJj' (no padding, url-safe alphabet).
    const result = bytesToBase64Url([97, 98, 99]);
    expect(result).toBe("YWJj");
  });

  it("emits url-safe (- / _) instead of (+ /)", () => {
    // 0xfb 0xff 0xbf 0xff → standard base64 has `+` and `/`.
    const result = bytesToBase64Url([0xfb, 0xff, 0xbf, 0xff]);
    expect(result).not.toMatch(/[+/=]/);
  });
});

describe("randomBytes", () => {
  it("produces requested length of bytes", () => {
    const bytes = randomBytes(32, uuidProvider());
    expect(bytes.length).toBe(32);
    bytes.forEach((b) => {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    });
  });

  it("never repeats across two calls (sanity, not statistical)", () => {
    const a = randomBytes(16, uuidProvider());
    const b = randomBytes(16, uuidProvider());
    expect(a.join(",")).not.toBe(b.join(","));
  });
});

describe("buildPkce", () => {
  it("produces verifier + challenge + state", () => {
    const m = buildPkce(uuidProvider(), sha256);
    expect(m.verifier.length).toBeGreaterThan(30);
    expect(m.challenge.length).toBeGreaterThan(30);
    expect(m.state.length).toBeGreaterThan(0);
  });

  it("challenge is sha256(verifier) per RFC 7636", () => {
    const m = buildPkce(uuidProvider(), sha256);
    const expected = bytesToBase64Url(sha256(m.verifier));
    expect(m.challenge).toBe(expected);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes all required PKCE + OAuth params", () => {
    const url = buildAuthorizeUrl(
      "https://app.veritize.app",
      "veritize-gdocs-addin",
      "https://script.google.com/macros/d/abc/usercallback",
      "scan:write claims:read",
      "CHALLENGE",
      "STATE",
    );
    const u = new URL(url);
    expect(u.origin).toBe("https://app.veritize.app");
    expect(u.pathname).toBe("/oauth/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("veritize-gdocs-addin");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://script.google.com/macros/d/abc/usercallback",
    );
    expect(u.searchParams.get("scope")).toBe("scan:write claims:read");
    expect(u.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("STATE");
  });

  it("uses gdocs client id (matches seed)", () => {
    const url = buildAuthorizeUrl(
      "https://app.veritize.app",
      "veritize-gdocs-addin",
      "https://x/usercallback",
      "s:r",
      "c",
      "s",
    );
    expect(url).toContain("client_id=veritize-gdocs-addin");
  });
});

describe("exchangeCodeForTokens", () => {
  it("POSTs form-encoded body with grant_type=authorization_code + code_verifier", () => {
    let captured: { url?: string; opts?: { payload?: string; contentType?: string } } = {};
    expect(captured.url).toBeUndefined(); // precondition
    const port: SyncFetchPort = (url, opts): SyncFetchResponse => {
      captured = { url, opts };
      return {
        code: 200,
        body: JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      };
    };
    const tokens = exchangeCodeForTokens({
      appBaseUrl: "https://app.veritize.app",
      clientId: "veritize-gdocs-addin",
      redirectUri: "https://script.google.com/macros/d/x/usercallback",
      code: "AUTHCODE",
      verifier: "VERIFIER",
      fetchPort: port,
      now: () => 1_700_000_000_000,
    });
    expect(captured.url).toBe("https://app.veritize.app/oauth/token");
    expect(captured.opts!.contentType).toBe("application/x-www-form-urlencoded");
    expect(captured.opts!.payload).toContain("grant_type=authorization_code");
    expect(captured.opts!.payload).toContain("code=AUTHCODE");
    expect(captured.opts!.payload).toContain("code_verifier=VERIFIER");
    expect(captured.opts!.payload).toContain("client_id=veritize-gdocs-addin");
    expect(tokens.access_token).toBe("at");
    expect(tokens.refresh_token).toBe("rt");
    expect(tokens.expires_at).toBe(1_700_000_000_000 + 3600_000);
  });

  it("throws OAuthError on non-2xx", () => {
    const port: SyncFetchPort = () => ({
      code: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    });
    let caught: OAuthError | null = null;
    try {
      exchangeCodeForTokens({
        appBaseUrl: "https://app.veritize.app",
        clientId: "veritize-gdocs-addin",
        redirectUri: "https://x/usercallback",
        code: "x",
        verifier: "y",
        fetchPort: port,
        now: () => 0,
      });
    } catch (e) {
      caught = e as OAuthError;
    }
    expect(caught).toBeInstanceOf(OAuthError);
    expect(caught?.message).toBe("invalid_grant");
  });
});

describe("refreshAccessToken", () => {
  it("POSTs grant_type=refresh_token with the supplied refresh_token", () => {
    let payload = "";
    expect(payload).toBe(""); // precondition
    const port: SyncFetchPort = (_url, opts) => {
      payload = opts.payload ?? "";
      return {
        code: 200,
        body: JSON.stringify({
          access_token: "new_at",
          refresh_token: "new_rt",
          expires_in: 1800,
          token_type: "Bearer",
        }),
      };
    };
    const tokens = refreshAccessToken({
      appBaseUrl: "https://app.veritize.app",
      clientId: "veritize-gdocs-addin",
      refreshToken: "OLD",
      fetchPort: port,
      now: () => 1_700_000_000_000,
    });
    expect(payload).toContain("grant_type=refresh_token");
    expect(payload).toContain("refresh_token=OLD");
    expect(payload).toContain("client_id=veritize-gdocs-addin");
    expect(tokens.access_token).toBe("new_at");
    expect(tokens.expires_at).toBe(1_700_000_000_000 + 1800_000);
  });

  it("throws OAuthError when refresh fails", () => {
    const port: SyncFetchPort = () => ({ code: 401, body: "" });
    let caught: OAuthError | null = null;
    try {
      refreshAccessToken({
        appBaseUrl: "https://app.veritize.app",
        clientId: "x",
        refreshToken: "y",
        fetchPort: port,
        now: () => 0,
      });
    } catch (e) {
      caught = e as OAuthError;
    }
    expect(caught?.code).toBe("refresh_failed");
  });
});

describe("token storage round-trip", () => {
  it("returns null when no tokens are stored", () => {
    expect(loadTokens(memProps())).toBeNull();
  });

  it("persistTokens / loadTokens round-trip", () => {
    const props = memProps();
    persistTokens(props, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      expires_at: 1_700_000_000_000,
    });
    const loaded = loadTokens(props);
    expect(loaded?.access_token).toBe("at");
    expect(loaded?.refresh_token).toBe("rt");
    expect(loaded?.expires_at).toBe(1_700_000_000_000);
  });

  it("clearTokens removes all three keys + pkce material", () => {
    const props = memProps({
      "veritize.access_token": "a",
      "veritize.refresh_token": "r",
      "veritize.expires_at": "1",
      "veritize.pkce_verifier": "v",
      "veritize.pkce_state": "s",
    });
    clearTokens(props);
    expect(props.get("veritize.access_token")).toBeNull();
    expect(props.get("veritize.refresh_token")).toBeNull();
    expect(props.get("veritize.expires_at")).toBeNull();
    expect(props.get("veritize.pkce_verifier")).toBeNull();
    expect(props.get("veritize.pkce_state")).toBeNull();
  });
});

describe("refreshOnUnauthorized", () => {
  it("returns null when no tokens are stored", () => {
    const result = refreshOnUnauthorized({
      props: memProps(),
      fetchPort: () => ({ code: 200, body: "{}" }),
      now: () => 0,
    });
    expect(result).toBeNull();
  });

  it("returns the new access_token + persists it when refresh succeeds", () => {
    const props = memProps();
    persistTokens(props, {
      access_token: "old_at",
      refresh_token: "rt",
      expires_in: 0,
      expires_at: 0,
    });
    const port: SyncFetchPort = () => ({
      code: 200,
      body: JSON.stringify({
        access_token: "fresh_at",
        refresh_token: "fresh_rt",
        expires_in: 600,
        token_type: "Bearer",
      }),
    });
    const result = refreshOnUnauthorized({ props, fetchPort: port, now: () => 1_000 });
    expect(result).toBe("fresh_at");
    const reloaded = loadTokens(props);
    expect(reloaded?.access_token).toBe("fresh_at");
    expect(reloaded?.refresh_token).toBe("fresh_rt");
  });

  it("clears tokens + returns null when refresh fails", () => {
    const props = memProps();
    persistTokens(props, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 0,
      expires_at: 0,
    });
    const port: SyncFetchPort = () => ({ code: 400, body: "" });
    const result = refreshOnUnauthorized({ props, fetchPort: port, now: () => 0 });
    expect(result).toBeNull();
    expect(loadTokens(props)).toBeNull();
  });
});
