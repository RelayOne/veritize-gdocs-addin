// src/Scan.ts — paragraph chunking + /v1/scans POST.
//
// Apps Script's UrlFetchApp is a synchronous, server-side fetch (no
// Promises). To keep this file independently testable from Node we
// keep the chunking + body-shaping pure and inject the fetch + token
// loader as small ports. The Apps-Script-only `runScan` entry point
// wires those ports to the real UrlFetchApp + PropertiesService at
// run time.

import type { DocumentParagraph, ScanClaim, ScanResult, Verdict } from "./types";
import { getConfig } from "./config";

// ---------------------------------------------------------------------------
// chunkParagraphs — split a flat paragraph list into ≤ maxWords groups.
// The Word add-in spec calls this out as policy; the gdocs add-on
// mirrors it so the backend's input shape is consistent across
// surfaces. We never split a single paragraph (the editorial unit is
// the paragraph): if one paragraph exceeds the chunk size, it is its
// own chunk. Returned chunks preserve original paragraph indices so
// verdicts can be re-anchored.
// ---------------------------------------------------------------------------

export interface ParagraphChunk {
  /** 0-based ordering of the chunk within the document. */
  index: number;
  /** Original paragraph indices included in this chunk. */
  paragraphIndices: number[];
  /** Combined text (paragraphs joined with double newline). */
  content: string;
  /** Word count for diagnostics. */
  wordCount: number;
}

function wordCount(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function chunkParagraphs(
  paragraphs: DocumentParagraph[],
  maxWords: number,
): ParagraphChunk[] {
  const chunks: ParagraphChunk[] = [];
  let buf: DocumentParagraph[] = [];
  let bufWords = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    chunks.push({
      index: chunks.length,
      paragraphIndices: buf.map((p) => p.index),
      content: buf.map((p) => p.text).join("\n\n"),
      wordCount: bufWords,
    });
    buf = [];
    bufWords = 0;
  };

  for (const p of paragraphs) {
    const w = wordCount(p.text);
    if (w === 0) continue;
    // If a single paragraph exceeds the cap, emit it as its own chunk
    // even though it overflows — we do not split sentences. The
    // backend's /v1/scans endpoint accepts arbitrary content size;
    // the cap exists to keep call latency under Apps Script's 6-min
    // per-call ceiling.
    if (w > maxWords) {
      flush();
      chunks.push({
        index: chunks.length,
        paragraphIndices: [p.index],
        content: p.text,
        wordCount: w,
      });
      continue;
    }
    if (bufWords + w > maxWords) flush();
    buf.push(p);
    bufWords += w;
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// readParagraphsFromDoc — Apps Script entry that reads the active
// document body's paragraphs and filters empty lines. Apps Script
// only — fenced by typeof so it tree-shakes cleanly in tests.
// ---------------------------------------------------------------------------

export function readParagraphsFromDoc(): DocumentParagraph[] {
  if (typeof DocumentApp === "undefined") return [];
  const body = DocumentApp.getActiveDocument().getBody();
  const paras = body.getParagraphs();
  const out: DocumentParagraph[] = [];
  for (let i = 0; i < paras.length; i++) {
    const t = paras[i].getText();
    if (t && t.trim().length > 0) {
      out.push({ index: i, text: t });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// scanChunkVia — pure-ish helper that takes a chunk + a fetch port +
// a bearer token and returns the parsed ScanResult. The fetch port is
// the Apps Script `UrlFetchApp.fetch` signature wrapped to a sync fn
// `(url, opts) => { code, body }` so tests can stub it without
// faking the global.
// ---------------------------------------------------------------------------

export interface SyncFetchResponse {
  code: number;
  body: string;
}

export type SyncFetchPort = (
  url: string,
  opts: {
    method: "post" | "get";
    headers: Record<string, string>;
    contentType?: string;
    payload?: string;
    muteHttpExceptions: boolean;
  },
) => SyncFetchResponse;

export interface ScanChunkOpts {
  apiBaseUrl: string;
  surface: string;
  token: string;
  chunk: ParagraphChunk;
  fetchPort: SyncFetchPort;
}

export function scanChunk(opts: ScanChunkOpts): ScanResult {
  const { apiBaseUrl, surface, token, chunk, fetchPort } = opts;
  const url = apiBaseUrl.replace(/\/$/, "") + "/v1/scans";
  const payload = JSON.stringify({
    content: chunk.content,
    paragraphs: chunk.paragraphIndices,
    surface,
  });
  const res = fetchPort(url, {
    method: "post",
    headers: {
      Authorization: "Bearer " + token,
      "X-Veritize-Surface": surface,
    },
    contentType: "application/json",
    payload,
    muteHttpExceptions: true,
  });
  if (res.code === 401) {
    throw new ScanError("unauthorized", "Session expired — sign in again.");
  }
  if (res.code === 402) {
    throw new ScanError("plan_limit", "Scan limit reached. Upgrade at app.veritize.app/pricing.");
  }
  if (res.code >= 500) {
    throw new ScanError("server_error", "Veritize is temporarily unavailable. Retry shortly.");
  }
  if (res.code < 200 || res.code >= 300) {
    throw new ScanError("http_" + res.code, "scan failed: " + res.code);
  }
  let parsed: ScanResult;
  try {
    parsed = JSON.parse(res.body) as ScanResult;
  } catch (e) {
    throw new ScanError("bad_json", "scan response was not JSON");
  }
  // Re-anchor each claim's paragraph_index back to the document index
  // (the backend echoes 0-based offsets within the chunk).
  for (const claim of parsed.claims || []) {
    if (typeof claim.paragraph_index === "number") {
      const offset = claim.paragraph_index;
      if (offset >= 0 && offset < chunk.paragraphIndices.length) {
        claim.paragraph_index = chunk.paragraphIndices[offset];
      }
    }
  }
  return parsed;
}

export class ScanError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ScanError";
  }
}

// ---------------------------------------------------------------------------
// scanDocument — top-level scan: chunk, post each, merge claim lists.
// ---------------------------------------------------------------------------

export interface ScanDocumentOpts {
  token: string;
  paragraphs: DocumentParagraph[];
  fetchPort: SyncFetchPort;
}

export function scanDocument(opts: ScanDocumentOpts): ScanResult {
  const cfg = getConfig();
  const chunks = chunkParagraphs(opts.paragraphs, cfg.maxWordsPerChunk);
  if (chunks.length === 0) {
    return {
      scan_id: "empty",
      verdict: "unverified",
      claims: [],
    };
  }
  let firstScanId = "";
  let attestation: boolean | undefined;
  const allClaims: ScanClaim[] = [];
  let worstVerdict: Verdict = "verified";

  for (const chunk of chunks) {
    const result = scanChunk({
      apiBaseUrl: cfg.apiBaseUrl,
      surface: cfg.surface,
      token: opts.token,
      chunk,
      fetchPort: opts.fetchPort,
    });
    if (!firstScanId) firstScanId = result.scan_id || "";
    if (result.attestation_enabled !== undefined) {
      attestation = result.attestation_enabled;
    }
    for (const c of result.claims || []) allClaims.push(c);
    if (result.verdict === "disputed") worstVerdict = "disputed";
    else if (result.verdict === "unverified" && worstVerdict !== "disputed") {
      worstVerdict = "unverified";
    }
  }

  return {
    scan_id: firstScanId,
    verdict: worstVerdict,
    claims: allClaims,
    attestation_enabled: attestation,
  };
}

// ---------------------------------------------------------------------------
// urlFetchAppPort — the production fetch port that wraps the Apps
// Script UrlFetchApp.fetch global. Lives here so a single import path
// covers both tests and runtime.
// ---------------------------------------------------------------------------

export function urlFetchAppPort(): SyncFetchPort {
  return (url, opts): SyncFetchResponse => {
    const res = UrlFetchApp.fetch(url, {
      method: opts.method,
      headers: opts.headers,
      contentType: opts.contentType,
      payload: opts.payload,
      muteHttpExceptions: opts.muteHttpExceptions,
    });
    return {
      code: res.getResponseCode(),
      body: res.getContentText(),
    };
  };
}
