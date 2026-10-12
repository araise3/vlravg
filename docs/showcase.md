# vlravg product film

Open `showcase.html` directly or serve it with the rest of the site. This standalone 48-second film has no build step, external libraries or API requests. It leaves the main app untouched.

The film covers player/pro search, average lobby rank, K/D, ACS, ADR, playtime, RR gains/losses and trend, duos, clutch outcomes, match history, MVPs, plus mentions of servers and party-size comparisons. All player identities and statistics are illustrative examples. The rank artwork comes from the site's existing `assets/ranks` files.

Typography uses `-apple-system`, `BlinkMacSystemFont`, SF Pro Display/Text and local fallbacks. Apple devices use their system font. Other devices use an installed font from the stack; no Apple font files are redistributed.

## Playback

Play/pause, replay, scrub, or select a chapter. Space toggles playback; left/right arrows seek five seconds when focus is outside a control. Fullscreen is available where the browser permits it. Reduced-motion preferences disable autoplay. The film stops after the final scene.

Save video records a 1080p WebM in supported browsers. Keep the tab visible during its 48-second capture. The film is silent.

## MP4 export

`scripts/render-showcase.mjs` is an optional offline utility requiring Playwright, a Chromium browser and ffmpeg. It checks playback and mobile behavior, saves scene stills, then renders every frame to an H.264 MP4. It does not add a build dependency to the website.

```powershell
node scripts/render-showcase.mjs --playwright-dir="C:/path/to/node_modules" --browser="C:/path/to/chrome.exe"
```

Exports default to `artifacts/showcase/`. Pass `--output=...` to choose another directory, or `--preview-only` to run the checks and save stills without encoding. The MP4 is 1920 × 1080, 30 fps, 48 seconds, with no audio. Its typography reflects the rendering machine's installed fonts.
