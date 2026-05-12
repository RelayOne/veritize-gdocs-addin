// style.test.ts — VZ-200-3: paragraph-highlight planning + DocumentApp
// driver. The pure planning logic is fully unit-tested here; the
// DocumentApp side is exercised with a fixture that records every
// setBackgroundColor call.

import { describe, it, expect } from "vitest";
import {
  planHighlightOps,
  sortClaimsBySeverity,
  applyVerdictHighlights,
  clearVerdictHighlights,
} from "../Style";
import type { ScanClaim } from "../types";
import { VERDICT_HEX } from "../config";

const claim = (
  partial: Partial<ScanClaim> & { verdict: ScanClaim["verdict"]; paragraph_index?: number },
): ScanClaim => ({
  id: partial.id ?? "c",
  claim_text: partial.claim_text ?? "x",
  verdict: partial.verdict,
  confidence: partial.confidence ?? 0.9,
  paragraph_index: partial.paragraph_index,
});

describe("planHighlightOps", () => {
  it("maps each verdict to the documented pastel hex", () => {
    const ops = planHighlightOps(
      [
        claim({ verdict: "verified", paragraph_index: 0 }),
        claim({ verdict: "disputed", paragraph_index: 1 }),
        claim({ verdict: "unverified", paragraph_index: 2 }),
      ],
      ["hello", "world", "again"],
    );
    expect(ops[0].hex).toBe("#dcfce7");
    expect(ops[1].hex).toBe("#fee2e2");
    expect(ops[2].hex).toBe("#fef3c7");
  });

  it("computes endOffset as text.length - 1", () => {
    const ops = planHighlightOps(
      [claim({ verdict: "verified", paragraph_index: 0 })],
      ["abc"],
    );
    expect(ops[0].endOffset).toBe(2);
  });

  it("skips claims without a paragraph_index", () => {
    const ops = planHighlightOps([claim({ verdict: "verified" })], ["hello"]);
    expect(ops).toStrictEqual([]);
  });

  it("skips out-of-bounds paragraph indices", () => {
    const ops = planHighlightOps(
      [claim({ verdict: "verified", paragraph_index: 99 })],
      ["hello"],
    );
    expect(ops).toStrictEqual([]);
  });

  it("de-duplicates per paragraph (first-wins on the input order)", () => {
    const ops = planHighlightOps(
      [
        claim({ verdict: "disputed", paragraph_index: 0 }),
        claim({ verdict: "verified", paragraph_index: 0 }),
      ],
      ["hello"],
    );
    expect(ops.length).toBe(1);
    expect(ops[0].hex).toBe(VERDICT_HEX.disputed);
  });

  it("handles empty paragraphs with endOffset=-1", () => {
    const ops = planHighlightOps(
      [claim({ verdict: "verified", paragraph_index: 0 })],
      [""],
    );
    expect(ops[0].endOffset).toBe(-1);
  });
});

describe("sortClaimsBySeverity", () => {
  it("ranks disputed > unverified > verified", () => {
    const sorted = sortClaimsBySeverity([
      claim({ id: "v", verdict: "verified", paragraph_index: 0 }),
      claim({ id: "d", verdict: "disputed", paragraph_index: 0 }),
      claim({ id: "u", verdict: "unverified", paragraph_index: 0 }),
    ]);
    expect(sorted.map((c) => c.id)).toStrictEqual(["d", "u", "v"]);
  });
});

// ---------------------------------------------------------------------------
// Fixture-driven DocumentApp tests.
// ---------------------------------------------------------------------------

interface SetBgCall { start: number; end: number; color: string | null }

function makeDocFixture(texts: string[]): { calls: SetBgCall[]; clearGlobal: () => void } {
  const calls: SetBgCall[] = [];
  const paras = texts.map((t) => ({
    getText: () => t,
    editAsText: () => ({
      setBackgroundColor: (s: number, e: number, c: string | null) => {
        calls.push({ start: s, end: e, color: c });
      },
    }),
  }));
  (globalThis as unknown as { DocumentApp: unknown }).DocumentApp = {
    getActiveDocument: () => ({ getBody: () => ({ getParagraphs: () => paras }) }),
  };
  return {
    calls,
    clearGlobal: () => {
      delete (globalThis as unknown as { DocumentApp?: unknown }).DocumentApp;
    },
  };
}

describe("applyVerdictHighlights (with DocumentApp fixture)", () => {
  it("calls setBackgroundColor with the right hex on each paragraph", () => {
    const f = makeDocFixture(["hello", "world"]);
    try {
      // Note: sortClaimsBySeverity puts disputed first, so the
      // setBackgroundColor calls don't follow input order. We sort
      // the recorded calls by colour to make the assertion stable.
      const applied = applyVerdictHighlights([
        claim({ verdict: "verified", paragraph_index: 0 }),
        claim({ verdict: "disputed", paragraph_index: 1 }),
      ]);
      expect(applied).toBe(2);
      const byColor = f.calls.slice().sort((a, b) =>
        (a.color || "").localeCompare(b.color || ""),
      );
      // 'hello'/'world' both length 5 → end offset 4.
      expect(byColor).toStrictEqual([
        { start: 0, end: 4, color: "#dcfce7" }, // verified
        { start: 0, end: 4, color: "#fee2e2" }, // disputed
      ]);
    } finally {
      f.clearGlobal();
    }
  });

  it("skips empty paragraphs", () => {
    const f = makeDocFixture([""]);
    try {
      const applied = applyVerdictHighlights([
        claim({ verdict: "verified", paragraph_index: 0 }),
      ]);
      expect(applied).toBe(0);
      expect(f.calls).toStrictEqual([]);
    } finally {
      f.clearGlobal();
    }
  });

  it("returns 0 when DocumentApp is undefined (test fallback)", () => {
    delete (globalThis as unknown as { DocumentApp?: unknown }).DocumentApp;
    expect(applyVerdictHighlights([])).toBe(0);
  });
});

describe("clearVerdictHighlights", () => {
  it("calls setBackgroundColor(null) on every non-empty paragraph", () => {
    const f = makeDocFixture(["alpha", "", "gamma"]);
    try {
      clearVerdictHighlights();
      // Only 'alpha' (len 5 → end 4) and 'gamma' (len 5 → end 4) should be cleared.
      expect(f.calls).toStrictEqual([
        { start: 0, end: 4, color: null },
        { start: 0, end: 4, color: null },
      ]);
    } finally {
      f.clearGlobal();
    }
  });
});
