# Phase 5 — Display and release (includes UX items tests can't measure)

Mechanical items (cite code):
1. Display window renders courts, scores, serving team and queue from the same state as the organizer window, and contains no organizer controls.
2. Timer is organizer-controlled and never finalizes a game.
3. No network: Electron session blocks or never issues requests; CSP disallows remote origins.
4. electron-builder config targets NSIS (Windows) and DMG (macOS); CI matrix runs the full suite on windows-latest and macos-latest.
5. `docs/USER_GUIDE.md` and `docs/INSTALL.md` exist and match the app.

Visual/usability items — take screenshots via the Playwright e2e run (`npm run -s e2e` should save them to `test-results/`) and look at them:
6. Court-side readability: score digits on the display are large enough to read across a court (≥ 15% of viewport height); scoring buttons on the organizer view are large touch targets (≥ 44 px).
7. Score entry for an active court takes at most one click/keypress per rally and never navigates away from the court.
8. Main dashboard leads with active courts, scores and next-up queue (brief risk: interface complexity).
9. Contrast: text and key controls meet WCAG AA; controls have visible labels; keyboard can drive score entry.
