// src/Style.ts — verdict-color paragraph background highlighting.
//
// Google Docs has no per-text-run "highlight" colour the way Word
// does. The closest equivalent is per-character `setBackgroundColor`
// on the paragraph's `editAsText()` text element. The colour applies
// to the actual rendered character span (not the paragraph mark), so
// the visible result is a subtle pastel highlight on every character
// inside the paragraph.
//
// `setBackgroundColor(startOffset, endOffsetInclusive, hex)` is the
// signature per Apps Script's docs. The end offset is inclusive, so a
// 10-char paragraph is `setBackgroundColor(0, 9, "#dcfce7")`.
//
// We provide pure helpers so the per-paragraph mapping (and bounds
// arithmetic) can be unit-tested without Apps Script.

import type { ScanClaim } from "./types";
import { VERDICT_HEX } from "./config";

/**
 * Build a list of `{paragraphIndex, hex}` operations for a set of
 * claims. Skips claims whose paragraph_index is undefined or out of
 * range. The bounds check uses the document's current paragraph count
 * (paragraphCount).
 */
export interface HighlightOp {
  paragraphIndex: number;
  hex: string;
  /** Inclusive end offset; -1 means "the paragraph is empty so skip". */
  endOffset: number;
}

export function planHighlightOps(
  claims: ScanClaim[],
  paragraphTexts: string[],
): HighlightOp[] {
  const ops: HighlightOp[] = [];
  const seen = new Set<number>();
  for (const claim of claims) {
    if (claim.paragraph_index === undefined) continue;
    const idx = claim.paragraph_index;
    if (idx < 0 || idx >= paragraphTexts.length) continue;
    // If multiple claims hit the same paragraph, the worst verdict
    // wins. We sort claims by "severity" so disputed > unverified >
    // verified, then de-dup on paragraphIndex.
    if (seen.has(idx)) continue;
    const len = paragraphTexts[idx].length;
    if (len === 0) {
      ops.push({ paragraphIndex: idx, hex: VERDICT_HEX[claim.verdict], endOffset: -1 });
      seen.add(idx);
      continue;
    }
    ops.push({
      paragraphIndex: idx,
      hex: VERDICT_HEX[claim.verdict],
      endOffset: len - 1,
    });
    seen.add(idx);
  }
  return ops;
}

const VERDICT_SEVERITY: Record<string, number> = {
  disputed: 3,
  unverified: 2,
  insufficient_evidence: 2,
  verified: 1,
};

/**
 * Sort claims so the worst-verdict claim "wins" when multiple claims
 * share a paragraph.
 */
export function sortClaimsBySeverity(claims: ScanClaim[]): ScanClaim[] {
  return claims.slice().sort((a, b) => {
    const av = VERDICT_SEVERITY[a.verdict] ?? 0;
    const bv = VERDICT_SEVERITY[b.verdict] ?? 0;
    return bv - av;
  });
}

// ---------------------------------------------------------------------------
// applyVerdictHighlights — Apps Script-only entry. Looks up paragraphs
// via DocumentApp and calls setBackgroundColor on each text element.
// ---------------------------------------------------------------------------

export function applyVerdictHighlights(claims: ScanClaim[]): number {
  if (typeof DocumentApp === "undefined") return 0;
  const body = DocumentApp.getActiveDocument().getBody();
  const paras = body.getParagraphs();
  const paragraphTexts = paras.map((p) => p.getText());
  const sorted = sortClaimsBySeverity(claims);
  const ops = planHighlightOps(sorted, paragraphTexts);
  let applied = 0;
  for (const op of ops) {
    if (op.endOffset < 0) continue;
    const p = paras[op.paragraphIndex];
    p.editAsText().setBackgroundColor(0, op.endOffset, op.hex);
    applied++;
  }
  return applied;
}

/**
 * clearVerdictHighlights resets the background colour of every
 * paragraph back to null (no highlight). Called on the panel's
 * "Clear" button + before each re-scan.
 */
export function clearVerdictHighlights(): void {
  if (typeof DocumentApp === "undefined") return;
  const body = DocumentApp.getActiveDocument().getBody();
  const paras = body.getParagraphs();
  for (let i = 0; i < paras.length; i++) {
    const t = paras[i].getText();
    if (t.length === 0) continue;
    // setBackgroundColor(start, end, null) clears the run's
    // background. The @types/google-apps-script signature is too
    // strict (it types the colour as `string`), so we call via a
    // structurally-typed helper. The Apps Script runtime accepts
    // null per the documented API.
    callSetBgColor(paras[i].editAsText(), 0, t.length - 1, null);
  }
}

interface BgSetter {
  setBackgroundColor(start: number, end: number, color: string | null): unknown;
}

function callSetBgColor(
  text: GoogleAppsScript.Document.Text,
  start: number,
  end: number,
  color: string | null,
): void {
  (text as unknown as BgSetter).setBackgroundColor(start, end, color);
}
