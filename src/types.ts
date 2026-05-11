// src/types.ts — shared verdict + claim types for the gdocs add-on.
// These match the Word add-in's `ScanClaim` shape so the panel UI can
// be ported across surfaces without translation.

export type Verdict =
  | "verified"
  | "unverified"
  | "disputed"
  | "insufficient_evidence";

export interface ScanClaim {
  id: string;
  claim_text: string;
  verdict: Verdict;
  confidence: number;
  paragraph_index?: number;
  notes?: string;
  source?: string;
}

export interface ScanResult {
  scan_id: string;
  verdict: string;
  claims: ScanClaim[];
  attestation_enabled?: boolean;
}

export interface DocumentParagraph {
  index: number;
  text: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  /** Wall-clock millis when the access token expires. */
  expires_at: number;
}
