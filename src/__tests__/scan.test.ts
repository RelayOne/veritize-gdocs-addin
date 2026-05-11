// scan.test.ts — VZ-200-2: paragraph chunking + /v1/scans calls.

import { describe, it, expect, vi } from "vitest";
import {
  chunkParagraphs,
  scanChunk,
  scanDocument,
  ScanError,
  type SyncFetchPort,
  type SyncFetchResponse,
} from "../Scan";

const PARAS = (n: number, words = 10): Array<{ index: number; text: string }> =>
  Array.from({ length: n }, (_, i) => ({
    index: i,
    text: Array.from({ length: words }, (_, j) => `w${i}-${j}`).join(" "),
  }));

describe("chunkParagraphs", () => {
  it("groups paragraphs up to maxWords", () => {
    const chunks = chunkParagraphs(PARAS(5, 100), 250);
    expect(chunks.length).toBe(3); // 100+100 / 100+100 / 100
    expect(chunks[0].paragraphIndices).toStrictEqual([0, 1]);
    expect(chunks[1].paragraphIndices).toStrictEqual([2, 3]);
    expect(chunks[2].paragraphIndices).toStrictEqual([4]);
  });

  it("preserves source indices through chunking", () => {
    const chunks = chunkParagraphs(PARAS(10, 50), 200);
    const allIdx = chunks.flatMap((c) => c.paragraphIndices);
    expect(allIdx).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("emits an oversized paragraph as its own chunk", () => {
    const big = { index: 0, text: Array.from({ length: 600 }, () => "x").join(" ") };
    const small = { index: 1, text: "small text" };
    const chunks = chunkParagraphs([big, small], 500);
    expect(chunks.length).toBe(2);
    expect(chunks[0].paragraphIndices).toStrictEqual([0]);
    expect(chunks[0].wordCount).toBe(600);
    expect(chunks[1].paragraphIndices).toStrictEqual([1]);
  });

  it("skips empty paragraphs", () => {
    const paras = [
      { index: 0, text: "hello" },
      { index: 1, text: "   " },
      { index: 2, text: "world" },
    ];
    const chunks = chunkParagraphs(paras, 500);
    expect(chunks.length).toBe(1);
    expect(chunks[0].paragraphIndices).toStrictEqual([0, 2]);
  });

  it("joins paragraphs with double newline in chunk content", () => {
    const paras = [
      { index: 0, text: "first" },
      { index: 1, text: "second" },
    ];
    const chunks = chunkParagraphs(paras, 500);
    expect(chunks[0].content).toBe("first\n\nsecond");
  });
});

describe("scanChunk", () => {
  it("POSTs to /v1/scans with bearer + JSON body + surface header", () => {
    const calls: Array<{ url: string; opts: unknown }> = [];
    const port: SyncFetchPort = (url, opts): SyncFetchResponse => {
      calls.push({ url, opts });
      return {
        code: 200,
        body: JSON.stringify({ scan_id: "s1", verdict: "verified", claims: [] }),
      };
    };
    expect(calls.length).toBe(0); // precondition
    scanChunk({
      apiBaseUrl: "https://api.veritize.app",
      surface: "gdocs_addin",
      token: "tok",
      chunk: {
        index: 0,
        paragraphIndices: [0, 1],
        content: "a\n\nb",
        wordCount: 2,
      },
      fetchPort: port,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://api.veritize.app/v1/scans");
    const o = calls[0].opts as { headers: Record<string, string>; payload: string; contentType: string };
    expect(o.headers.Authorization).toBe("Bearer tok");
    expect(o.headers["X-Veritize-Surface"]).toBe("gdocs_addin");
    expect(o.contentType).toBe("application/json");
    const body = JSON.parse(o.payload) as { content: string; paragraphs: number[]; surface: string };
    expect(body.content).toBe("a\n\nb");
    expect(body.paragraphs).toStrictEqual([0, 1]);
    expect(body.surface).toBe("gdocs_addin");
  });

  it("re-anchors claim paragraph_index back to document indices", () => {
    const port: SyncFetchPort = () => ({
      code: 200,
      body: JSON.stringify({
        scan_id: "s",
        verdict: "verified",
        claims: [
          { id: "c1", claim_text: "x", verdict: "verified", confidence: 0.9, paragraph_index: 0 },
          { id: "c2", claim_text: "y", verdict: "disputed", confidence: 0.5, paragraph_index: 1 },
        ],
      }),
    });
    const result = scanChunk({
      apiBaseUrl: "https://api.veritize.app",
      surface: "gdocs_addin",
      token: "t",
      chunk: { index: 0, paragraphIndices: [4, 7], content: "x\n\ny", wordCount: 2 },
      fetchPort: port,
    });
    expect(result.claims[0].paragraph_index).toBe(4);
    expect(result.claims[1].paragraph_index).toBe(7);
  });

  it("surfaces 401 as ScanError.unauthorized", () => {
    const port: SyncFetchPort = () => ({ code: 401, body: "" });
    expect(() =>
      scanChunk({
        apiBaseUrl: "https://api.veritize.app",
        surface: "gdocs_addin",
        token: "t",
        chunk: { index: 0, paragraphIndices: [0], content: "x", wordCount: 1 },
        fetchPort: port,
      }),
    ).toThrowError(/sign in again/i);
  });

  it("surfaces 402 as plan_limit ScanError", () => {
    const port: SyncFetchPort = () => ({ code: 402, body: "" });
    let caught: ScanError | null = null;
    try {
      scanChunk({
        apiBaseUrl: "https://api.veritize.app",
        surface: "gdocs_addin",
        token: "t",
        chunk: { index: 0, paragraphIndices: [0], content: "x", wordCount: 1 },
        fetchPort: port,
      });
    } catch (e) {
      caught = e as ScanError;
    }
    expect(caught).toBeInstanceOf(ScanError);
    expect(caught?.code).toBe("plan_limit");
  });

  it("surfaces 5xx as server_error ScanError", () => {
    const port: SyncFetchPort = () => ({ code: 503, body: "" });
    let caught: ScanError | null = null;
    try {
      scanChunk({
        apiBaseUrl: "https://api.veritize.app",
        surface: "gdocs_addin",
        token: "t",
        chunk: { index: 0, paragraphIndices: [0], content: "x", wordCount: 1 },
        fetchPort: port,
      });
    } catch (e) {
      caught = e as ScanError;
    }
    expect(caught?.code).toBe("server_error");
  });
});

describe("scanDocument", () => {
  it("merges claims from multiple chunks 1:1 onto source paragraphs", () => {
    const calls: string[] = [];
    expect(calls.length).toBe(0); // precondition
    const port: SyncFetchPort = (_url, opts): SyncFetchResponse => {
      const body = JSON.parse(opts.payload!) as { paragraphs: number[] };
      calls.push(body.paragraphs.join(","));
      return {
        code: 200,
        body: JSON.stringify({
          scan_id: "s",
          verdict: "verified",
          claims: body.paragraphs.map((idx, off) => ({
            id: "c" + idx,
            claim_text: "claim " + idx,
            verdict: "verified",
            confidence: 0.9,
            paragraph_index: off,
          })),
        }),
      };
    };
    // 10 paragraphs × 100 words each → at maxWords=500 we expect 2 chunks.
    const paras = PARAS(10, 100);
    const result = scanDocument({ token: "t", paragraphs: paras, fetchPort: port });
    expect(calls.length).toBe(2);
    // Claims re-mapped back to source paragraph index.
    const idxs = result.claims.map((c) => c.paragraph_index);
    expect(idxs).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("returns empty result when there are no paragraphs", () => {
    const port: SyncFetchPort = vi.fn(() => ({ code: 200, body: "{}" }));
    const result = scanDocument({ token: "t", paragraphs: [], fetchPort: port });
    expect(result.claims).toStrictEqual([]);
    expect(port).not.toHaveBeenCalled();
  });

  it("downgrades verdict to disputed when any chunk reports disputed", () => {
    let i = 0;
    const port: SyncFetchPort = () => {
      i++;
      return {
        code: 200,
        body: JSON.stringify({
          scan_id: "s" + i,
          verdict: i === 2 ? "disputed" : "verified",
          claims: [],
        }),
      };
    };
    const result = scanDocument({
      token: "t",
      paragraphs: PARAS(20, 100),
      fetchPort: port,
    });
    expect(result.verdict).toBe("disputed");
  });
});
