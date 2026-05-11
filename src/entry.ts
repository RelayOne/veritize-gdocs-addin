// src/entry.ts — Apps Script entry surface.
//
// gas-webpack-plugin (with `autoGlobalExportsFiles: ["src/entry.ts"]`)
// walks this module's ES exports and emits matching top-level Apps
// Script function declarations plus the `__webpack_require__.g.fn =
// __webpack_exports__.fn` glue so Apps Script's runtime can dispatch
// from a manifest entry point to the bundled implementation.

import { buildCardSpec, renderCard, cardServicePort } from "./Cards";
import { getConfig } from "./config";
import {
  buildAuthorizeUrl,
  buildPkce,
  clearTokens,
  exchangeCodeForTokens,
  loadTokens,
  OAuthError,
  persistPkce,
  persistTokens,
  readPkce,
  refreshOnUnauthorized,
  userPropsPort,
} from "./Auth";
import {
  applyVerdictHighlights,
  clearVerdictHighlights,
} from "./Style";
import {
  readParagraphsFromDoc,
  scanDocument as scanDocumentLib,
  urlFetchAppPort,
  ScanError,
} from "./Scan";

// ---------------------------------------------------------------------------
// buildHomepage — manifest entry point. Called whenever the user
// opens the add-on sidebar in Docs.
// ---------------------------------------------------------------------------

export function buildHomepage(): GoogleAppsScript.Card_Service.Card {
  const props = userPropsPort();
  const tokens = loadTokens(props);
  const spec = buildCardSpec({
    signedIn: !!tokens,
    authorizationUrl: tokens ? undefined : startSignInUrl(),
  });
  const port = cardServicePort();
  const builder = renderCard(spec, port);
  // The real CardService builder has `.build()`.
  return (builder as unknown as { build: () => GoogleAppsScript.Card_Service.Card }).build();
}

// onFileScopeGranted — fires when the user grants `documents.currentonly`
// via the per-file consent flow.
export function onFileScopeGranted(): GoogleAppsScript.Card_Service.Navigation {
  return CardService.newNavigation().updateCard(buildHomepage());
}

// ---------------------------------------------------------------------------
// startSignInUrl — generates a fresh PKCE pair, persists it on the
// user's properties, and returns the /oauth/authorize URL. The CardService
// authorisation action opens this in a new tab; the user lands back
// at the web-app's doGet() with `?code=...&state=...`.
// ---------------------------------------------------------------------------

function startSignInUrl(): string {
  const cfg = getConfig();
  const props = userPropsPort();
  const pkce = buildPkce(
    () => Utilities.getUuid(),
    (s) => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s),
  );
  persistPkce(props, pkce);
  const redirect = redirectUri();
  return buildAuthorizeUrl(
    cfg.appBaseUrl,
    cfg.clientId,
    redirect,
    cfg.scopes,
    pkce.challenge,
    pkce.state,
  );
}

function redirectUri(): string {
  // Apps Script web-app callback URL: when the script is deployed as
  // a web app, ScriptApp.getService().getUrl() returns the
  // `https://script.google.com/macros/d/<deploymentId>/usercallback`
  // shape. Before first deploy this is null — surface a helpful
  // error rather than minting an invalid URL.
  const svc = ScriptApp.getService();
  const url = svc.getUrl();
  if (!url) {
    throw new OAuthError(
      "no_deploy_url",
      "Add-on must be deployed as a web app before sign-in works.",
    );
  }
  // The exec URL is what getUrl returns; usercallback is the same
  // origin with `/usercallback` appended.
  return url.replace(/\/exec$/, "/usercallback");
}

// ---------------------------------------------------------------------------
// doGet — Apps Script web-app endpoint. Receives the OAuth redirect.
// ---------------------------------------------------------------------------

export function doGet(e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.HTML.HtmlOutput {
  const props = userPropsPort();
  const pkce = readPkce(props);
  const params = e?.parameter ?? {};
  const code = params.code;
  const state = params.state;
  const error = params.error;
  if (error) {
    return htmlMessage("Sign-in cancelled: " + error);
  }
  if (!code) {
    return htmlMessage("Missing authorization code.");
  }
  if (!pkce || pkce.state !== state) {
    return htmlMessage("OAuth state mismatch — possible CSRF.");
  }
  const cfg = getConfig();
  try {
    const tokens = exchangeCodeForTokens({
      appBaseUrl: cfg.appBaseUrl,
      clientId: cfg.clientId,
      redirectUri: redirectUri(),
      code,
      verifier: pkce.verifier,
      fetchPort: urlFetchAppPort(),
      now: () => Date.now(),
    });
    persistTokens(props, tokens);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return htmlMessage("Sign-in failed: " + msg);
  }
  return htmlMessage("Signed in to Veritize. You can close this tab.");
}

function htmlMessage(text: string): GoogleAppsScript.HTML.HtmlOutput {
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return HtmlService.createHtmlOutput(
    "<!doctype html><meta charset=utf-8><body style='font-family:sans-serif;padding:24px'>" +
      "<h2>Veritize</h2><p>" + safe + "</p></body>",
  );
}

// ---------------------------------------------------------------------------
// onScanClicked — scan-button handler. Reads paragraphs, posts each
// chunk to /v1/scans, applies highlights, returns updated card.
// ---------------------------------------------------------------------------

export function onScanClicked(): GoogleAppsScript.Card_Service.ActionResponse {
  const props = userPropsPort();
  let tokens = loadTokens(props);
  if (!tokens) {
    return updateCard(
      renderCard(
        buildCardSpec({ signedIn: false, authorizationUrl: startSignInUrl() }),
        cardServicePort(),
      ),
    );
  }
  const paragraphs = readParagraphsFromDoc();
  try {
    let token = tokens.access_token;
    let scanResult;
    try {
      scanResult = scanDocumentLib({
        token,
        paragraphs,
        fetchPort: urlFetchAppPort(),
      });
    } catch (e) {
      if (e instanceof ScanError && e.code === "unauthorized") {
        const fresh = refreshOnUnauthorized({
          props,
          fetchPort: urlFetchAppPort(),
          now: () => Date.now(),
        });
        if (!fresh) {
          clearTokens(props);
          return updateCard(
            renderCard(
              buildCardSpec({ signedIn: false, authorizationUrl: startSignInUrl() }),
              cardServicePort(),
            ),
          );
        }
        token = fresh;
        scanResult = scanDocumentLib({
          token,
          paragraphs,
          fetchPort: urlFetchAppPort(),
        });
      } else {
        throw e;
      }
    }
    // Clear stale highlights before applying new ones so re-scans
    // don't leave a rainbow.
    clearVerdictHighlights();
    applyVerdictHighlights(scanResult.claims);
    return updateCard(
      renderCard(
        buildCardSpec({ signedIn: true, scanResult }),
        cardServicePort(),
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return updateCard(
      renderCard(
        buildCardSpec({ signedIn: true, errorMessage: msg }),
        cardServicePort(),
      ),
    );
  }
}

export function onClearHighlightsClicked(): GoogleAppsScript.Card_Service.ActionResponse {
  clearVerdictHighlights();
  return updateCard(
    renderCard(
      buildCardSpec({ signedIn: true }),
      cardServicePort(),
    ),
  );
}

export function onSignOutClicked(): GoogleAppsScript.Card_Service.ActionResponse {
  const props = userPropsPort();
  clearTokens(props);
  return updateCard(
    renderCard(
      buildCardSpec({ signedIn: false, authorizationUrl: startSignInUrl() }),
      cardServicePort(),
    ),
  );
}

function updateCard(
  builder: { build?: () => GoogleAppsScript.Card_Service.Card } | unknown,
): GoogleAppsScript.Card_Service.ActionResponse {
  const built = (builder as { build: () => GoogleAppsScript.Card_Service.Card }).build();
  const nav = CardService.newNavigation().updateCard(built);
  return CardService.newActionResponseBuilder().setNavigation(nav).build();
}
