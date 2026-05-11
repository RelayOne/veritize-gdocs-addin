// src/config.ts — environment configuration for the gdocs add-on.
//
// The Apps Script container has no concept of build-time env vars
// (the bundler resolves these to string literals before clasp pushes
// the .gs file). To support dev/staging/prod from a single TS
// codebase, the build script reads CLASP_ENV at webpack-build time and
// inlines the right base URL via DefinePlugin.
//
// For ease of reading + testing we expose a single `getConfig()` that
// pulls from `Script Properties` first (so the operator can flip an
// env at runtime by editing ScriptProperty in the Apps Script editor),
// then falls back to the bundled default.

import type { Verdict } from "./types";

export interface AppConfig {
  apiBaseUrl: string;
  appBaseUrl: string;
  clientId: string;
  /** OAuth scopes string used in the /oauth/authorize URL. */
  scopes: string;
  /** Surface name used in X-Veritize-Surface header + telemetry. */
  surface: string;
  /** Maximum words per scan chunk. Mirror of the Word add-in policy. */
  maxWordsPerChunk: number;
}

const DEFAULT: AppConfig = {
  apiBaseUrl: "https://api.veritize.app",
  appBaseUrl: "https://app.veritize.app",
  clientId: "veritize-gdocs-addin",
  scopes: "scan:write claims:read",
  surface: "gdocs_addin",
  maxWordsPerChunk: 500,
};

/**
 * Pulls override values from Apps Script's ScriptProperties at
 * runtime. Falls back to DEFAULT when the script-properties store is
 * unavailable (tests / non-Apps-Script environments).
 */
export function getConfig(): AppConfig {
  try {
    // `PropertiesService` is an Apps Script global — gated by typeof
    // for the test env.
    if (typeof PropertiesService === "undefined") return DEFAULT;
    const props = PropertiesService.getScriptProperties();
    const overrides: Partial<AppConfig> = {};
    const apiBaseUrl = props.getProperty("VERITIZE_API_BASE_URL");
    const appBaseUrl = props.getProperty("VERITIZE_APP_BASE_URL");
    const clientId = props.getProperty("VERITIZE_CLIENT_ID");
    if (apiBaseUrl) overrides.apiBaseUrl = apiBaseUrl;
    if (appBaseUrl) overrides.appBaseUrl = appBaseUrl;
    if (clientId) overrides.clientId = clientId;
    return { ...DEFAULT, ...overrides };
  } catch {
    return DEFAULT;
  }
}

/**
 * Verdict → highlight color (subtle pastel hex). These hexes are used
 * by `Style.gs:applyVerdictHighlights` via `setBackgroundColor`. Per
 * the spec:
 *   true (verified) → #dcfce7 (mint)
 *   false (disputed) → #fee2e2 (rose)
 *   unverified / insufficient_evidence → #fef3c7 (amber)
 */
export const VERDICT_HEX: Record<Verdict, string> = {
  verified: "#dcfce7",
  disputed: "#fee2e2",
  unverified: "#fef3c7",
  insufficient_evidence: "#fef3c7",
};
