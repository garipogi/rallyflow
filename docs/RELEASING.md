# Releasing RallyFlow

This is how a new version goes from the repository to downloadable installers.

## 1. Prepare the version

1. Update `version` in `package.json` (for example `1.0.1`) and run `npm install --package-lock-only` so the lock file matches.
2. Add a section to `CHANGELOG.md`.
3. Check everything locally:
   ```
   npm run -s typecheck
   npx vitest run
   npm run -s e2e
   ```
4. Optional: refresh the screenshots (`npm run screenshots`) and the notices (`npm run notices`).
5. Commit and push to `main`.

## 2. Tag the release

```
git tag v1.0.0
git push origin v1.0.0
```

Pushing a tag that starts with `v` runs `.github/workflows/release.yml`. You can also run it by hand from the **Actions** tab (**Release › Run workflow**); a manual run uploads the installers as workflow artifacts but does not create a release.

## 3. What CI produces

Each job first runs `npm ci`, the typecheck and the full Vitest suite, then generates `THIRD_PARTY_NOTICES.md`, builds the app and packages it with `electron-builder --publish never`:

| Runner | Output |
| --- | --- |
| `macos-latest` (Apple silicon) | `RallyFlow-<version>-arm64.dmg`, `RallyFlow-<version>-arm64.zip` |
| `macos-15-intel` (Intel) | `RallyFlow-<version>-x64.dmg`, `RallyFlow-<version>-x64.zip` |
| `windows-latest` | `RallyFlow-Setup-<version>.exe` (NSIS, per-user, choose folder) |

GitHub retired the `macos-13` image; `macos-15-intel` is the Intel runner that replaced it. If GitHub retires it too, build Intel on `macos-latest` with `--mac dmg zip --x64` (better-sqlite3 ships prebuilt x64 binaries, and electron-builder downloads the x64 Electron).

The `release` job then collects the files, writes `SHA256SUMS.txt`, and creates a **draft** GitHub Release named "RallyFlow v<version>" with the notes from `.github/release-notes.md`. Open **Releases**, check the draft, edit the notes if you like, and press **Publish release**. From then on `https://github.com/<owner>/<repo>/releases/latest` (used by the website buttons) points to it.

electron-builder never uploads anything itself: `electron-builder.yml` has `publish: null`, there is no auto-updater, and the app makes no network requests. The separate `ci.yml` workflow keeps running the full test suite (including end-to-end tests) on every push.

Locally, `npm run dist:mac` builds the Apple silicon DMG and zip without any download (it uses `node_modules/electron/dist`). Intel and Windows installers need their own Electron binaries, so they are left to CI.

## 4. The website

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages on every push to `main` that touches `site/`. One-time setup: **Settings › Pages › Build and deployment › Source: GitHub Actions**. The workflow writes the repository owner and name into `site/config.js`, so the download buttons point at this repository's latest release without any manual step. To host the site elsewhere, set `owner` (and `repo` if it is not `rallyflow`) in `site/config.js` yourself; it is the only setting.

## 5. Code signing and notarization (optional, recommended before wide distribution)

Unsigned builds work, but users see a warning on first launch (decision D13). Signing removes it.

### macOS — Developer ID + notarization

- **Cost:** Apple Developer Program, **US$99 per year**.
- Create a **Developer ID Application** certificate in your Apple Developer account, export it from Keychain Access as a `.p12` with a password, and base64-encode it: `base64 -i cert.p12 | pbcopy`.
- Create an **app-specific password** for your Apple ID at appleid.apple.com, and note your **Team ID**.
- Add repository secrets (**Settings › Secrets and variables › Actions**): `MAC_CERTS_P12_BASE64`, `MAC_CERTS_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
- In `electron-builder.yml`, under `mac:`, remove `identity: null` and add `hardenedRuntime: true` and `notarize: true`.
- In `.github/workflows/release.yml`, delete the `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` line and uncomment the `CSC_LINK`, `CSC_KEY_PASSWORD` and `APPLE_*` lines.

electron-builder then signs the app, submits it to Apple's notary service and staples the ticket. Gatekeeper opens it without a warning.

### Windows — Authenticode

Choose one:

- **Azure Trusted Signing** (Microsoft's managed signing service): about **US$10 per month** for the basic tier; requires identity validation of the individual or organisation. electron-builder supports it through `win.azureSignOptions` with the `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` secrets.
- **A code-signing certificate** from a certificate authority (OV roughly **US$200–400 per year**, EV more, usually on a hardware token or cloud HSM). For a `.pfx` file: add `WIN_CERT_PFX_BASE64` and `WIN_CERT_PASSWORD` secrets and uncomment `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` in the workflow.

SmartScreen reputation builds up over downloads; EV certificates and Trusted Signing establish it faster.

No secrets are stored in this repository. Without them, CI produces unsigned installers exactly as it does today.

## 6. After publishing

- Check that the website download buttons open the new release.
- Share it: see `docs/SHARE_KIT.md`.
