// cards.test.ts — VZ-200-4: CardService UI builders.
//
// We don't test against the real CardService global. We construct a
// minimal port whose builder objects record method calls as a
// property bag. Because Cards.ts falls back to `b.props[key] = value`
// when `setKey` is missing, every render walks through the recorder
// transparently.

import { describe, it, expect } from "vitest";
import {
  buildCardSpec,
  countByVerdict,
  renderCard,
  summaryLine,
  type CSBuilder,
  type CardServicePort,
} from "../Cards";
import type { ScanResult } from "../types";

function recPort(): CardServicePort {
  const make = (kind: string): CSBuilder => ({ __kind: kind, props: {} });
  return {
    newCardBuilder: () => make("CardBuilder"),
    newCardHeader: () => make("CardHeader"),
    newCardSection: () => make("CardSection"),
    newTextParagraph: () => make("TextParagraph"),
    newDecoratedText: () => make("DecoratedText"),
    newImage: () => make("Image"),
    newTextButton: () => make("TextButton"),
    newImageButton: () => make("ImageButton"),
    newAction: () => make("Action"),
    newAuthorizationAction: () => make("AuthorizationAction"),
    newOpenLink: () => make("OpenLink"),
    newNavigation: () => make("Navigation"),
    newActionResponseBuilder: () => make("ActionResponseBuilder"),
  };
}

describe("buildCardSpec", () => {
  it("returns signed-out when signedIn=false", () => {
    const spec = buildCardSpec({ signedIn: false, authorizationUrl: "https://x" });
    expect(spec.kind).toBe("signed-out");
    if (spec.kind === "signed-out") {
      expect(spec.authorizationUrl).toBe("https://x");
    }
  });

  it("returns scanned when signedIn + scanResult provided", () => {
    const scanResult: ScanResult = {
      scan_id: "s",
      verdict: "verified",
      claims: [],
    };
    const spec = buildCardSpec({ signedIn: true, scanResult });
    expect(spec.kind).toBe("scanned");
  });

  it("returns signed-in-idle when signedIn without scanResult", () => {
    const spec = buildCardSpec({ signedIn: true });
    expect(spec.kind).toBe("signed-in-idle");
  });

  it("returns error when errorMessage is set, regardless of signedIn", () => {
    const spec = buildCardSpec({ signedIn: true, errorMessage: "boom" });
    expect(spec.kind).toBe("error");
    if (spec.kind === "error") expect(spec.message).toBe("boom");
  });
});

describe("countByVerdict", () => {
  it("zeros for all verdicts", () => {
    const c = countByVerdict([]);
    expect(c.verified).toBe(0);
    expect(c.unverified).toBe(0);
    expect(c.disputed).toBe(0);
    expect(c.insufficient_evidence).toBe(0);
  });

  it("counts claims per verdict", () => {
    const c = countByVerdict([
      { id: "1", claim_text: "x", verdict: "verified", confidence: 0.9 },
      { id: "2", claim_text: "y", verdict: "verified", confidence: 0.9 },
      { id: "3", claim_text: "z", verdict: "disputed", confidence: 0.4 },
    ]);
    expect(c.verified).toBe(2);
    expect(c.disputed).toBe(1);
  });
});

describe("summaryLine", () => {
  it("returns 'No claims found.' on empty counts", () => {
    expect(summaryLine({ verified: 0, unverified: 0, disputed: 0, insufficient_evidence: 0 }))
      .toBe("No claims found.");
  });

  it("includes only non-zero buckets joined by /", () => {
    expect(summaryLine({ verified: 2, unverified: 0, disputed: 1, insufficient_evidence: 0 }))
      .toBe("2 verified / 1 disputed");
  });
});

describe("renderCard (signed-out)", () => {
  it("emits one section with text + auth-action button", () => {
    const spec = buildCardSpec({
      signedIn: false,
      authorizationUrl: "https://app.veritize.app/oauth/authorize?x=1",
    });
    const root = renderCard(spec, recPort());
    const sections = root.props.sections as CSBuilder[];
    expect(sections.length).toBe(1);
    const widgets = sections[0].props.widgets as CSBuilder[];
    // [TextParagraph, TextButton]
    expect(widgets.length).toBe(2);
    expect(widgets[0].__kind).toBe("TextParagraph");
    expect(widgets[1].__kind).toBe("TextButton");
    const onAction = widgets[1].props.onAction as CSBuilder;
    expect(onAction.__kind).toBe("AuthorizationAction");
    expect(onAction.props.authorizationUrl).toBe(
      "https://app.veritize.app/oauth/authorize?x=1",
    );
  });
});

describe("renderCard (signed-in-idle)", () => {
  it("emits a Scan button + a Sign-out section", () => {
    const spec = buildCardSpec({ signedIn: true });
    const root = renderCard(spec, recPort());
    const sections = root.props.sections as CSBuilder[];
    expect(sections.length).toBe(2);
    // primary section
    const primaryWidgets = sections[0].props.widgets as CSBuilder[];
    expect(primaryWidgets[1].__kind).toBe("TextButton");
    expect(primaryWidgets[1].props.text).toBe("Scan this document");
    expect((primaryWidgets[1].props.onAction as CSBuilder).props.functionName)
      .toBe("onScanClicked");
    // sign-out section
    const signOutWidgets = sections[1].props.widgets as CSBuilder[];
    expect(signOutWidgets[0].props.text).toBe("Sign out");
  });
});

describe("renderCard (scanned)", () => {
  it("emits summary + claims + sign-out sections with one DecoratedText per claim", () => {
    expect(typeof renderCard).toBe("function"); // precondition
    const scanResult: ScanResult = {
      scan_id: "s",
      verdict: "disputed",
      claims: [
        {
          id: "c1",
          claim_text: "Sky is blue.",
          verdict: "verified",
          confidence: 0.9,
          source: "https://example.com/1",
        },
        {
          id: "c2",
          claim_text: "Sky is green.",
          verdict: "disputed",
          confidence: 0.4,
        },
      ],
    };
    const root = renderCard(buildCardSpec({ signedIn: true, scanResult }), recPort());
    const sections = root.props.sections as CSBuilder[];
    expect(sections.length).toBe(3);
    // summary
    expect(sections[0].props.header).toBe("Summary");
    // claims section has 2 DecoratedTexts
    expect(sections[1].props.header).toBe("Claims");
    const claimWidgets = sections[1].props.widgets as CSBuilder[];
    expect(claimWidgets.length).toBe(2);
    expect(claimWidgets[0].__kind).toBe("DecoratedText");
    expect(claimWidgets[0].props.text).toBe("Sky is blue.");
    expect(claimWidgets[0].props.topLabel).toBe("Verified");
    // claim with source has an ImageButton with OpenLink action
    const linkButton = claimWidgets[0].props.button as CSBuilder;
    expect(linkButton.__kind).toBe("ImageButton");
    const openLink = linkButton.props.onAction as CSBuilder;
    expect(openLink.__kind).toBe("OpenLink");
    expect(openLink.props.url).toBe("https://example.com/1");
    // claim without source has no button
    expect(claimWidgets[1].props.button).toBeUndefined();
  });

  it("summary widgets include Re-scan + Clear highlights buttons", () => {
    const scanResult: ScanResult = { scan_id: "s", verdict: "verified", claims: [] };
    const root = renderCard(buildCardSpec({ signedIn: true, scanResult }), recPort());
    const summaryWidgets = (root.props.sections as CSBuilder[])[0].props.widgets as CSBuilder[];
    const buttonTexts = summaryWidgets
      .filter((w) => w.__kind === "TextButton")
      .map((w) => w.props.text as string);
    expect(buttonTexts).toContain("Re-scan");
    expect(buttonTexts).toContain("Clear highlights");
  });
});
