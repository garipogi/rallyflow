# Stack decision

Decided 2026-10-21 (organizer said "you decide").

| Layer | Choice |
| --- | --- |
| Desktop shell | Electron (via electron-vite) |
| UI | React + TypeScript, bundled locally (no CDN, no network at runtime) |
| Database | SQLite through `better-sqlite3` (synchronous, real transactions) |
| Core engines | Pure TypeScript modules in `src/core/` — scoring, rotation, stats — no UI or DB imports |
| Export | CSV (hand-written, RFC 4180) + XLSX via `exceljs` |
| Unit/integration tests | Vitest, run in plain Node |
| End-to-end tests | Playwright's Electron support (phase 5) |
| Packaging | electron-builder: NSIS (Windows), DMG (macOS) |
| CI for AC-20 | GitHub Actions matrix: `windows-latest`, `macos-latest` |

## Why Electron over Tauri

The loop is only as trustworthy as its gate, and the gate runs tests in Node.

- With `better-sqlite3`, the exact persistence code the app ships is what the tests exercise. Transactions, recovery and backup validation are tested for real, not through a mock.
- With Tauri, storage would live behind Rust commands or an async plugin, and Node tests would only cover a stand-in. AC-11 (recovery) and AC-13 (backup) would be weaker gates.
- Cost: larger installers (~100 MB vs ~10 MB). For a single organizer's laptop this doesn't matter.

## Layering rule (Maintainability requirement)

```
src/core/       pure logic: scoring, rotation, stats, validation   (no I/O)
src/data/       SQLite schema, migrations, repositories, backup, export
src/main/       Electron main process, IPC, window management, display window
src/renderer/   React UI (organizer window + large-screen display view)
```

`src/core` must not import from `src/data`, `src/main` or `src/renderer`. The judge checks this.

## Native module note

`better-sqlite3` is compiled for Node's ABI in tests and must be rebuilt for Electron's ABI when packaging (`electron-builder install-app-deps`). The phase 1 builder sets this up.
