# Architecture

This plugin is meant to support two ways of getting a rendered image for a given
TRMNL plugin. Only the first is built today.

## Mode A — bring your own Terminus (current)

Config is `terminusBaseUrl` + credentials (see [README](../README.md#configuration)).
The plugin is a thin HTTP client (`src/terminusClient.ts`) that logs into a
self-hosted [Terminus](https://github.com/usetrmnl/terminus) instance, triggers a
build for a configured extension ID, and scrapes the resulting rendered image.
The user runs and maintains Terminus themselves; its own web UI handles browsing
and configuring plugins. This plugin doesn't know or care what any given
extension displays.

## Mode B — self-contained, no external Terminus (planned, not started)

Running a full Terminus instance is real ongoing maintenance — Postgres, Redis,
Sidekiq, a web app, user accounts — for a need that's actually much narrower:
pick N plugins, render each on an interval, serve as a HomeKit camera. Terminus
doesn't offer a way to use just its render engine without the rest of the app, so
Mode B means building a narrower renderer, not slimming Terminus down.

In this mode the plugin would absorb what Terminus normally provides:

1. **Browse/select plugins** — inside Homebridge's config UI (a Homebridge UI X
   custom UI panel backed by the plugin's own endpoints), search TRMNL Recipes
   and/or enter a private plugin ID.
2. **Configure plugin options** — fetch the plugin's `settings.yml` custom-field
   definitions (e.g. VRM Dashboard's `vrm_token` / `vrm_installation_id` /
   `timezone`) and render a form for them, storing values per-camera.
3. **Render** — fetch the plugin's data source with those fields Liquid-templated
   into headers/URL (the same shape as Terminus's Exchange), render the Liquid
   template to HTML with `liquidjs`, load TRMNL's framework CSS/JS for correct
   layout, and screenshot via an **ephemeral** headless Chromium (spawned per
   render, exiting after — not a persistent browser process, which was already
   ruled out elsewhere in this project for Pi resource reasons).

### Shared contract

Both modes should reduce to the same interface further down the stack —
`render(id) → { imageBuffer, contentType }` — so `renderCache.ts`, `camera.ts`,
and `platform.ts` don't need to know which mode is active. Only
`terminusClient.ts` (Mode A) vs. a future `localRenderer.ts` (Mode B) differ.

### Open unknowns — spiked 2026-07-12, all resolved favorably

- **Is there a real, documented "list/search TRMNL Recipes" API?** Yes —
  `GET https://trmnl.com/recipes.json`, no auth. Params: `search` (name match),
  `sort-by` (oldest/newest/popularity/fork/install), `user_id`, `per_page` (max
  100, default 25). Response: paginated `data` array of
  `{id, user_id, name, published_at, icon_url, icon_content_type,
  screenshot_url, author_bio, custom_fields, stats}` plus pagination `meta`.
  `custom_fields` is exactly the settings-form data Mode B step 2 needs.
  Verified live (returned real recipes, e.g. "GamesDoneQuick", "Shakespeare
  Quotes"). Docs (docs.trmnl.com/go/public-api/recipes-api) still call it
  "alpha, may move to `/api/recipes` or `/api/plugins` before end of 2025" —
  that date has passed and the endpoint hasn't moved, but re-check before
  building against it since it's explicitly unstable.
- **Is TRMNL's framework CSS/JS meant to be loaded by third-party software?**
  Non-issue — `usetrmnl/trmnl-component` (the actual framework, MIT licensed)
  explicitly documents local self-hosting as a supported install path
  (`<script src="trmnl-component.js">`), not just its CDN URL. Mode B should
  vendor/bundle the file locally rather than hotlink `trmnl.com`'s CDN on every
  render — sidesteps the ToS/fair-use question entirely instead of resolving it.
- **Ephemeral headless Chromium on the Pi** — confirmed working, empirically, on
  `vanessapi` itself. `chromium-browser` 126.0.6478.164 is already installed via
  apt (`archive.raspberrypi.org`, armhf — yes, 32-bit; this works despite the
  Docker/Terminus 32-bit blocker because it's a native apt package, not a
  container image). `chromium-browser --headless=new --disable-gpu --no-sandbox
  --screenshot=out.png --window-size=800,480 file:///path/to.html` produced a
  correct PNG from local HTML in ~5s wall-clock, with zero lingering process
  afterward (`ps aux` clean within 1s of exit). No Puppeteer/Playwright needed
  (both have real arm32 gaps), no bundled binary needed.

### Sequencing

Mode A ships first since it's simpler and already validated end-to-end against a
real Terminus instance (though its own next step, deploying Terminus on
`vanessapi`, is now blocked — see below). Mode B's three unknowns are now
de-risked; next step is designing `localRenderer.ts` against the shared
`render()` contract, not further spiking.

### Mode A status update (2026-07-12)

Deploying Terminus on `vanessapi` for Mode A testing is blocked: the Pi's
userspace is 32-bit Raspbian bullseye (`armhf`), and Terminus's own images
(Postgres 18, Valkey 9, the Terminus app image) only publish `amd64`/`arm64`
manifests — no 32-bit ARM builds exist to pull. No other 64-bit host is
available right now. This is unresolved and not being actively worked around
(would require reimaging the Pi's OS or sourcing a different host); it's part
of why Mode B — which turns out to need nothing Docker-based, just the apt
`chromium-browser` package that already works on this exact 32-bit install —
is the more immediately viable path forward.
