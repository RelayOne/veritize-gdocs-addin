# Veritize — Google Docs add-in

Google Workspace Add-on that brings Veritize content verification into Google Docs. Sibling to the [Word add-in](https://github.com/RelayOne/veritize-word-addin) and the [InCopy add-in](https://github.com/RelayOne/veritize-incopy-addin).

Google Docs is the editorial surface for news rooms, content marketing teams, and agency editorial — a different (often complementary) buyer segment than Word.

## Status

Tasks 1-5 of 8 shipped (54 tests pass). Tasks 6-8 are operator-side:

- **6** clasp deploy to a real Google Cloud project + OAuth consent screen
- **7** Google Workspace Marketplace submission
- **8** Cross-link docs into [`RelayOne/veritize`](https://github.com/RelayOne/veritize)

Until those land, deploy as a **Test Add-on** via the Apps Script editor (see Dev workflow below).

## What's in the add-on

- **Apps Script Workspace Add-on scaffold.** `appsscript.json` declares `docs.homepageTrigger` + narrow OAuth scopes (`documents.currentonly` + `script.external_request` — the narrowest possible; no broad Drive access).
- **TypeScript + webpack** via `gas-webpack-plugin`. Write idiomatic TS, emit `.gs` files for clasp push.
- **Paragraph-chunked scan.** Reads `DocumentApp.getActiveDocument().getBody().getParagraphs()`, groups into ≤500-word chunks (matches Word add-in policy), POSTs each chunk to `/v1/scan` via `UrlFetchApp.fetch` with the OAuth Bearer token, maps responses back to paragraph indices. Each chunk respects the Apps Script 6-minute execution ceiling.
- **Verdict-color paragraph-background highlights.** Pastels — `#dcfce7` (verified) / `#fee2e2` (disputed) / `#fef3c7` (unverified) / `#f3f4f6` (insufficient_evidence). Applied via `paragraph.editAsText().setBackgroundColor()`. Highlights persist through save and sync to other users; the panel's "Clear" button removes all Veritize backgrounds without disturbing others.
- **CardService panel UI** with three states (signed-out / signed-in-not-scanned / scanned-with-claims), back-button preservation, clickable source links via `OpenLink`.
- **OAuth PKCE sign-in** via Apps Script's `externalRequest` + the VZ-197 OAuth 2.1 server. Redirect URI is the Apps Script web-app URL of the add-on (`https://script.google.com/macros/d/<deploymentId>/usercallback`). Tokens stored in `PropertiesService.getUserProperties()` (per-user, encrypted at rest by Google). Refresh-on-401 + revocation supported.

## Install (preview, Test Add-on)

1. Install Google's clasp CLI: `npm i -g @google/clasp`. Run `clasp login`.
2. Create an Apps Script project bound to a Google Cloud project (operator-side; capture project ID in your environment).
3. Clone this repo and push:
   ```bash
   nvm use 20
   npm install
   npm run build       # webpack emits .gs files into build/
   clasp push          # pushes from build/ to the Apps Script project
   clasp open          # opens the Apps Script editor
   ```
4. In the Apps Script editor, run **Deploy → New deployment → Test deployments → Install** to add the Veritize add-on to your Google account.
5. Open any Google Docs file — the Veritize panel appears in the right sidebar.

## Dev workflow

```bash
nvm use 20
npm install
npm test         # vitest — 54 tests pass (mocks DocumentApp / UrlFetchApp / CardService / PropertiesService / ScriptApp)
npx tsc --noEmit # clean
npm run build    # webpack → build/*.gs
```

## Repo layout

```
src/
  entry.ts      — Apps Script entry-points (Code.gs equivalent)
  Cards.ts      — CardService UI builders (Cards.gs)
  Scan.ts       — paragraph chunking + /v1/scan calls (Scan.gs)
  Style.ts      — paragraph-background-color highlights (Style.gs)
  Auth.ts       — OAuth PKCE flow + PropertiesService persistence (Auth.gs)
  types.ts      — ambient declarations for Apps Script globals
  config.ts     — base URLs, OAuth client ID
  __tests__/    — vitest suite (mocks Apps Script globals)
appsscript.json — Workspace Add-on manifest (narrow OAuth scopes)
audit/          — operator-handoff docs (Google Cloud project, Marketplace submission, OAuth client seed)
```

## OAuth client registration

Register a new OAuth client `veritize-gdocs-addin` in `RelayOne/veritize-app#db/seed-oauth-clients.sql` per `audit/oauth-client-registration.md` in this repo.

## See also

- Cross-link: [`RelayOne/veritize`](https://github.com/RelayOne/veritize) (Go core + product docs)
- Sibling editor add-ins: [`veritize-word-addin`](https://github.com/RelayOne/veritize-word-addin), [`veritize-incopy-addin`](https://github.com/RelayOne/veritize-incopy-addin)

## License

FSL-1.1-Apache-2.0 (Functional Source License, Apache 2.0 conversion clause). See `LICENSE`.
