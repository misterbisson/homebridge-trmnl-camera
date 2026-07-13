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

### Open unknowns

Spike these before writing any Mode B code — any one could reshape or block the
design:

- **Is there a real, documented "list/search TRMNL Recipes" API?** Terminus's
  Gallery page must call something to populate itself; find that actual endpoint
  rather than screen-scraping Terminus's Gallery HTML.
- **Is TRMNL's framework CSS/JS meant to be loaded by third-party software?**
  Terminus's `/extensions/:id/preview` pulls it live from `trmnl.com`'s CDN.
  Hotlinking it ourselves, across every install of this plugin, on every render,
  is a more direct version of the TRMNL ToS/fair-use question that came up early
  in this project's design (the original idea of having the plugin call a data
  Worker's `polling_url` directly, at request time, was set aside partly over
  this same concern — Terminus, TRMNL's own officially-blessed self-hosted path,
  was chosen as an intermediary specifically to avoid it).
- **Ephemeral headless Chromium on Pi ARM/ARM64** — is there a usable system
  `chromium` for one-shot `--headless --screenshot` invocation (spawn,
  screenshot, exit, no persistent process), or would Mode B need to bundle one —
  the same arm64-Linux-Chromium problem that already ruled out Puppeteer for the
  streaming half of this plugin?

### Sequencing

Mode A ships first since it's simpler and already validated end-to-end against a
real Terminus instance. Mode B's three unknowns above should be spiked before any
implementation starts, since any of them could invalidate the approach.
