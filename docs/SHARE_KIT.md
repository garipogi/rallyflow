# RallyFlow share kit

Everything you need to get RallyFlow into other organizers' hands, today, with no app store.

**Name:** RallyFlow · **Tagline:** Every game. Every player. In rhythm. · **Descriptor:** Offline Pickleball Open Play Manager

Brand files: `site/assets/logo.svg` (horizontal lockup), `build/icon.png` (1024 px icon), `site/assets/og-image.png` (1200×630 social card), `site/assets/screenshots/*.png`.

## Ways to share

1. **Send the installer directly.** AirDrop, a USB stick, Google Drive/Dropbox/WeTransfer, or a chat attachment:
   - Mac (Apple silicon): `release/RallyFlow-1.0.0-arm64.dmg` (~140 MB). The `.zip` next to it holds the same app if a DMG is awkward to send.
   - Mac (Intel) and Windows: download them from the GitHub Release built by CI (`RallyFlow-1.0.0-x64.dmg`, `RallyFlow-Setup-1.0.0.exe`).
   - Tell people the exact file name and size so they know they have the real file.
2. **Share the GitHub Release link:** `https://github.com/<owner>/<repo>/releases/latest` — always the newest version, with all three installers.
3. **Share the website:** `https://<owner>.github.io/<repo>/` once GitHub Pages is on (see `docs/RELEASING.md`). It has the download buttons, screenshots and first-open help.
4. **Print the flyer:** open `site/flyer.html` (or `/flyer.html` on the website) and press **Print this flyer**. It fits A4 and US Letter; turn on "Background graphics". The QR code is generated on the page from `site/config.js` — fill in `owner` there (or print from the published website) so the QR points at your site.

## Instructions for recipients (copy and paste)

> **Installing RallyFlow**
>
> **Mac:** open the `.dmg` and drag **RallyFlow** into **Applications**. The first time, Control-click (right-click) RallyFlow in Applications and choose **Open**, then **Open** again. If your Mac still refuses, go to **System Settings › Privacy & Security**, scroll down and click **Open Anyway**. Choose the "arm64" file for M1–M4 Macs and "x64" for Intel Macs (Apple menu › About This Mac shows which you have).
>
> **"RallyFlow is damaged and can't be opened" (Mac, version 1.1.0 only):** download 1.1.1 or newer. Or open Terminal and run `xattr -cr /Applications/RallyFlow.app`, then open RallyFlow again.
>
> **Windows:** run `RallyFlow-Setup-1.0.0.exe`. If you see "Windows protected your PC", click **More info**, then **Run anyway**, and follow the installer.
>
> The warning appears only because the app isn't code-signed yet. RallyFlow runs entirely offline and keeps your data on your computer.

## Announcement message

> 🎾 **Introducing RallyFlow — Every game. Every player. In rhythm.**
>
> I've been running our open play with a little app I built, and it's ready to share. RallyFlow decides who plays next so everyone gets fair court time, scores every rally with the official rules (called score and all), puts the courts and the next-up queue on a TV for the players, and finishes the night with an awards ceremony — Player of the Session, a podium, Hot Streak and more.
>
> It works completely offline on a Mac or Windows laptop: no accounts, no subscriptions, nothing leaves your computer.
>
> Download: <link> · First time opening it? The download page shows the one extra click your computer asks for.

## Social posts

**1 — The problem/solution**
> Whiteboard, paddle stack, "who's next?!" chaos… 🙃 Meet **RallyFlow**: fair rotation, live rally scoring and a big-screen queue for pickleball open play. Offline, free for Mac & Windows. Every game. Every player. In rhythm. 🎾 <link>

**2 — The awards hook**
> Our open play now ends with an awards ceremony on the big screen 🏆 Player of the Session, Hot Streak, Dynamic Duo, Social Butterfly… all worked out from the night's games by **RallyFlow**. Organizers, grab it free: <link> #pickleball #openplay

**3 — Short and punchy**
> Run open play like a pro. **RallyFlow** — fair rotations, official scoring, TV display, awards. 100% offline. Mac + Windows. <link> 🎾

Attach `site/assets/og-image.png` or a screenshot (`display.png` and `awards-ceremony.png` get the most attention). When the website is live, its link shows the social card automatically.

## Checklist before a big share

- [ ] Release published on GitHub (not a draft) with DMG (arm64 + x64) and EXE.
- [ ] Website live; download buttons open the release.
- [ ] `site/config.js` `owner` set (or Pages workflow ran) so the flyer QR code points at the website.
- [ ] Optional: signing/notarization set up (`docs/RELEASING.md`) to remove first-open warnings.
