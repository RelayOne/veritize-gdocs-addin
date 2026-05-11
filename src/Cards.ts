// src/Cards.ts — CardService UI builders for the Veritize sidebar.
//
// CardService is an Apps Script-only global. To keep this file
// testable from Node we expose a tiny abstraction: a `CardServicePort`
// that mirrors the bits of the CardService API we use. Tests inject a
// fake port that records every call as a JSON tree; production wires
// it to the real Apps Script global.
//
// The panel has three states:
//   1. signed-out  → "Sign in with Veritize" auth-action button
//   2. signed-in, idle → "Scan this document" button
//   3. scanned     → header + list of claim cards
// Plus a re-scan + sign-out button on every state where it makes
// sense.

import type { ScanClaim, ScanResult, Verdict } from "./types";

// ---------------------------------------------------------------------------
// Port shape — every method returns an opaque builder so tests can
// just look at the recorded JSON.
// ---------------------------------------------------------------------------

export interface CSBuilder { __kind: string; props: Record<string, unknown> }

export interface CardServicePort {
  newCardBuilder(): CSBuilder;
  newCardHeader(): CSBuilder;
  newCardSection(): CSBuilder;
  newTextParagraph(): CSBuilder;
  newDecoratedText(): CSBuilder;
  newImage(): CSBuilder;
  newTextButton(): CSBuilder;
  newImageButton(): CSBuilder;
  newAction(): CSBuilder;
  newAuthorizationAction(): CSBuilder;
  newOpenLink(): CSBuilder;
  newNavigation(): CSBuilder;
  newActionResponseBuilder(): CSBuilder;
}

/** Wires the port to the real Apps Script global. */
export function cardServicePort(): CardServicePort {
  return {
    newCardBuilder: () => CardService.newCardBuilder() as unknown as CSBuilder,
    newCardHeader: () => CardService.newCardHeader() as unknown as CSBuilder,
    newCardSection: () => CardService.newCardSection() as unknown as CSBuilder,
    newTextParagraph: () => CardService.newTextParagraph() as unknown as CSBuilder,
    newDecoratedText: () => CardService.newDecoratedText() as unknown as CSBuilder,
    newImage: () => CardService.newImage() as unknown as CSBuilder,
    newTextButton: () => CardService.newTextButton() as unknown as CSBuilder,
    newImageButton: () => CardService.newImageButton() as unknown as CSBuilder,
    newAction: () => CardService.newAction() as unknown as CSBuilder,
    newAuthorizationAction: () =>
      CardService.newAuthorizationAction() as unknown as CSBuilder,
    newOpenLink: () => CardService.newOpenLink() as unknown as CSBuilder,
    newNavigation: () => CardService.newNavigation() as unknown as CSBuilder,
    newActionResponseBuilder: () =>
      CardService.newActionResponseBuilder() as unknown as CSBuilder,
  };
}

// ---------------------------------------------------------------------------
// Card definitions — pure JSON shape so the builder-style chaining
// happens in one place (apply()) and tests can compare structures.
// ---------------------------------------------------------------------------

export type CardSpec =
  | SignedOutCard
  | SignedInIdleCard
  | ScannedCard
  | ErrorCard;

export interface SignedOutCard {
  kind: "signed-out";
  authorizationUrl: string;
}

export interface SignedInIdleCard {
  kind: "signed-in-idle";
  userEmail?: string;
}

export interface ScannedCard {
  kind: "scanned";
  scanResult: ScanResult;
  userEmail?: string;
}

export interface ErrorCard {
  kind: "error";
  message: string;
}

/**
 * Build a CardSpec given the runtime state. Pure function — perfect
 * for unit tests.
 */
export interface BuildCardOpts {
  signedIn: boolean;
  authorizationUrl?: string;
  scanResult?: ScanResult;
  userEmail?: string;
  errorMessage?: string;
}

export function buildCardSpec(opts: BuildCardOpts): CardSpec {
  if (opts.errorMessage) {
    return { kind: "error", message: opts.errorMessage };
  }
  if (!opts.signedIn) {
    return {
      kind: "signed-out",
      authorizationUrl: opts.authorizationUrl ?? "",
    };
  }
  if (opts.scanResult) {
    return {
      kind: "scanned",
      scanResult: opts.scanResult,
      userEmail: opts.userEmail,
    };
  }
  return { kind: "signed-in-idle", userEmail: opts.userEmail };
}

// ---------------------------------------------------------------------------
// Render — given a CardSpec + a CardServicePort, walks the spec and
// returns the root Card builder (cast back to `unknown` so the caller
// can pass it to CardService.build()).
// ---------------------------------------------------------------------------

const VERDICT_LABEL: Record<Verdict, string> = {
  verified: "Verified",
  unverified: "Unverified",
  disputed: "Disputed",
  insufficient_evidence: "Insufficient evidence",
};

const VERDICT_ICON: Record<Verdict, string> = {
  verified: "https://app.veritize.app/static/verdict-verified.png",
  unverified: "https://app.veritize.app/static/verdict-unverified.png",
  disputed: "https://app.veritize.app/static/verdict-disputed.png",
  insufficient_evidence: "https://app.veritize.app/static/verdict-unverified.png",
};

export function renderCard(spec: CardSpec, port: CardServicePort): CSBuilder {
  const card = port.newCardBuilder();
  setProp(card, "header", buildHeader(port, headerFor(spec)));

  if (spec.kind === "signed-out") {
    const section = port.newCardSection();
    const intro = port.newTextParagraph();
    setProp(intro, "text",
      "Sign in to Veritize to scan this document for unverified claims.");
    pushChild(section, "widget", intro);

    const authAction = port.newAuthorizationAction();
    setProp(authAction, "authorizationUrl", spec.authorizationUrl);

    const button = port.newTextButton();
    setProp(button, "text", "Sign in with Veritize");
    setProp(button, "onAction", authAction);
    pushChild(section, "widget", button);

    pushChild(card, "section", section);
    return card;
  }

  if (spec.kind === "signed-in-idle") {
    const section = port.newCardSection();
    const intro = port.newTextParagraph();
    setProp(intro, "text",
      "Scan this document to extract claims and check each against the Veritize knowledge graph.");
    pushChild(section, "widget", intro);

    const scanAction = port.newAction();
    setProp(scanAction, "functionName", "onScanClicked");

    const button = port.newTextButton();
    setProp(button, "text", "Scan this document");
    setProp(button, "onAction", scanAction);
    pushChild(section, "widget", button);

    const signOutSection = signOutSectionWidget(port);
    pushChild(card, "section", section);
    pushChild(card, "section", signOutSection);
    return card;
  }

  if (spec.kind === "scanned") {
    const summarySection = port.newCardSection();
    setProp(summarySection, "header", "Summary");
    const counts = countByVerdict(spec.scanResult.claims);
    const summaryText = port.newTextParagraph();
    setProp(
      summaryText,
      "text",
      summaryLine(counts),
    );
    pushChild(summarySection, "widget", summaryText);

    const rescanAction = port.newAction();
    setProp(rescanAction, "functionName", "onScanClicked");
    const rescanButton = port.newTextButton();
    setProp(rescanButton, "text", "Re-scan");
    setProp(rescanButton, "onAction", rescanAction);
    pushChild(summarySection, "widget", rescanButton);

    const clearAction = port.newAction();
    setProp(clearAction, "functionName", "onClearHighlightsClicked");
    const clearButton = port.newTextButton();
    setProp(clearButton, "text", "Clear highlights");
    setProp(clearButton, "onAction", clearAction);
    pushChild(summarySection, "widget", clearButton);

    pushChild(card, "section", summarySection);

    const claimsSection = port.newCardSection();
    setProp(claimsSection, "header", "Claims");
    for (const claim of spec.scanResult.claims) {
      const widget = renderClaim(port, claim);
      pushChild(claimsSection, "widget", widget);
    }
    pushChild(card, "section", claimsSection);
    pushChild(card, "section", signOutSectionWidget(port));
    return card;
  }

  // error
  const section = port.newCardSection();
  const para = port.newTextParagraph();
  setProp(para, "text", spec.message);
  pushChild(section, "widget", para);
  pushChild(card, "section", section);
  return card;
}

function renderClaim(port: CardServicePort, claim: ScanClaim): CSBuilder {
  const dt = port.newDecoratedText();
  setProp(dt, "topLabel", VERDICT_LABEL[claim.verdict]);
  setProp(dt, "text", claim.claim_text);
  if (claim.notes) setProp(dt, "bottomLabel", claim.notes);
  const icon = port.newImage();
  setProp(icon, "iconUrl", VERDICT_ICON[claim.verdict]);
  setProp(icon, "altText", VERDICT_LABEL[claim.verdict]);
  setProp(dt, "startIcon", icon);

  if (claim.source) {
    const link = port.newOpenLink();
    setProp(link, "url", claim.source);
    const ib = port.newImageButton();
    setProp(ib, "iconUrl", "https://app.veritize.app/static/external-link.png");
    setProp(ib, "altText", "Open source");
    setProp(ib, "onAction", link);
    setProp(dt, "button", ib);
  }
  return dt;
}

function signOutSectionWidget(port: CardServicePort): CSBuilder {
  const section = port.newCardSection();
  const action = port.newAction();
  setProp(action, "functionName", "onSignOutClicked");
  const button = port.newTextButton();
  setProp(button, "text", "Sign out");
  setProp(button, "onAction", action);
  pushChild(section, "widget", button);
  return section;
}

function buildHeader(port: CardServicePort, title: string): CSBuilder {
  const h = port.newCardHeader();
  setProp(h, "title", title);
  setProp(h, "subtitle", "Veritize");
  return h;
}

function headerFor(spec: CardSpec): string {
  switch (spec.kind) {
    case "signed-out": return "Verify this document";
    case "signed-in-idle": return "Ready to scan";
    case "scanned": return "Scan results";
    case "error": return "Veritize error";
  }
}

export function countByVerdict(claims: ScanClaim[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = {
    verified: 0,
    unverified: 0,
    disputed: 0,
    insufficient_evidence: 0,
  };
  for (const c of claims) {
    counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
  }
  return counts;
}

export function summaryLine(counts: Record<Verdict, number>): string {
  const parts: string[] = [];
  if (counts.verified > 0) parts.push(counts.verified + " verified");
  if (counts.unverified > 0) parts.push(counts.unverified + " unverified");
  if (counts.disputed > 0) parts.push(counts.disputed + " disputed");
  if (counts.insufficient_evidence > 0) {
    parts.push(counts.insufficient_evidence + " insufficient");
  }
  if (parts.length === 0) return "No claims found.";
  return parts.join(" / ");
}

// ---------------------------------------------------------------------------
// Test-friendly helpers. The CSBuilder type is intentionally opaque
// (it's the real CardService builder at runtime), so we model
// chained sets as property-bag writes for tests. Production builders
// expose the same method names — we coerce to `any` at the boundary.
// ---------------------------------------------------------------------------

function setProp(b: CSBuilder, key: string, value: unknown): void {
  // Runtime CardService builders are method-chained: `b.setText(v)`
  // returns the builder. We translate `setProp(b, "text", v)` →
  // `b.setText(v)` when the builder has that method, else just
  // record onto `b.props` for tests.
  const methodName = "set" + key.charAt(0).toUpperCase() + key.slice(1);
  const anyB = b as unknown as Record<string, (v: unknown) => unknown>;
  if (typeof anyB[methodName] === "function") {
    anyB[methodName](value);
    return;
  }
  if (!b.props) b.props = {};
  b.props[key] = value;
}

function pushChild(b: CSBuilder, key: string, child: CSBuilder): void {
  // Mirrors the CardService method names: `card.addSection(section)`,
  // `section.addWidget(widget)`, etc. Pluralise/prefix the key.
  const methodName = "add" + key.charAt(0).toUpperCase() + key.slice(1);
  const anyB = b as unknown as Record<string, (v: unknown) => unknown>;
  if (typeof anyB[methodName] === "function") {
    anyB[methodName](child);
    return;
  }
  if (!b.props) b.props = {};
  const list = (b.props[key + "s"] as CSBuilder[] | undefined) ?? [];
  list.push(child);
  b.props[key + "s"] = list;
}

// Re-export setProp + pushChild so tests can use them as oracles.
export { setProp as _setProp, pushChild as _pushChild };
