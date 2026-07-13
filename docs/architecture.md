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
   (`trmnl.com/recipes.json`) and/or enter a private plugin ID, then download
   its archive (`usetrmnl.com/api/plugin_settings/:id/archive`, a zip — see
   "Recipe archive format" below).
2. **Configure plugin options** — the archive's `settings.yml` has a
   `custom_fields` array (e.g. VRM Dashboard's `vrm_token` /
   `vrm_installation_id` / `timezone`); render a form from it and store the
   entered values per-camera.
3. **Render** — fetch the plugin's data source (`polling_url` /
   `polling_headers` / `polling_body`, Liquid-templated with the custom field
   values — the same shape as Terminus's Exchange), render `full.liquid` to
   HTML with `liquidjs`, wrap it in a page that hotlinks
   `trmnl.com/css/latest/plugins.css` + `.../plugins.js` (see below — this
   matches Terminus's own behavior, not a new integration), and screenshot via
   an **ephemeral** headless Chromium (spawned per render, exiting after — not
   a persistent browser process, which was already ruled out elsewhere in this
   project for Pi resource reasons).

### Recipe archive format (confirmed 2026-07-12, from Terminus's own import code and a real downloaded Recipe)

Traced from `usetrmnl/terminus`'s
`app/aspects/extensions/importers/remote/*` (the code Terminus itself uses to
import a Recipe) and a real archive pulled for a live Recipe (id 369398,
"Shakespeare Quotes"):

- `GET https://usetrmnl.com/api/plugin_settings/:id/archive` returns a zip, no
  auth required. Confirmed contents for a polling-strategy Recipe: `settings.yml`,
  `full.liquid`, `half_horizontal.liquid`, `half_vertical.liquid`,
  `quadrant.liquid` (and optionally `shared.liquid`, a partial some Recipes
  prepend to every layout — not present in this one). Mode B only needs
  `full.liquid`; the half/quadrant layouts are for physical e-ink models, not
  a HomeKit camera tile.
- `settings.yml` fields that matter: `strategy` (`polling` or `static` —
  `oauth` strategy is out of scope, same as Terminus itself doesn't support
  it), `polling_url` / `polling_verb` / `polling_headers` / `polling_body`
  (the data-source request; `polling_url` may itself contain Liquid, e.g.
  `{{ vrm_token }}`-style templating against custom field values),
  `static_data` (for `static` strategy, no request needed), `custom_fields`
  (settings-form definitions — `keyname`/`field_type`/`name`/`description`/
  `options`/`default`/`optional`), `refresh_interval` (minutes).
- **`full.liquid`'s variable conventions are TRMNL-native, not
  Terminus-internal** — confirmed directly in Shakespeare Quotes' `full.liquid`:
  bare variables like `{{ quote }}`, `{{ book }}`, `{{ tags }}` are merged
  straight from the polled JSON response's top-level keys (TRMNL's plugin
  convention: whatever the data source returns becomes directly addressable in
  the template); `{{ trmnl.plugin_settings.instance_name }}` is the
  user-assigned camera/plugin label; `{{ trmnl.plugin_settings.custom_fields_values.KEYNAME }}`
  reads a configured custom field's value. (Terminus itself rewrites these into
  its own internal `source_1.*`/`extension.*` namespacing on import — Mode B
  doesn't need that indirection since it isn't going through Terminus; render
  directly against a Liquid context shaped like
  `{ ...polledJson, trmnl: { plugin_settings: { instance_name, custom_fields_values } } }`.)
- Markup uses TRMNL Design System classes (`.layout`, `.flex`, `.flex--col`,
  `.value`, `.value--large`, `.label`, `.title_bar`, `.title`, `.image`, plus
  `data-value-fit`/`data-value-fit-max-height` attributes for JS-driven
  autosizing text) — these only render correctly with `plugins.css`/
  `plugins.js` loaded, and the autosize JS needs a moment to settle before the
  screenshot is taken (not just "load and shoot immediately").
- Terminus's own render page (`app/templates/layouts/extension.html.erb`)
  wraps content as `<body class="trmnl"><div class="screen">…parsed
  full.liquid…</div></body>`, with a `.screen { … }` inline style block holding
  device-specific CSS custom properties (width/height/etc., normally sourced
  from Terminus's own device-model config). Mode B has no device model system,
  so it should set its own fixed `--screen-width`/`--screen-height` (matching
  whatever resolution the camera advertises) rather than depending on
  Terminus's model data.

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
  Correction to an earlier version of this doc: `usetrmnl/trmnl-component`
  (MIT, self-hostable) is a *different*, unrelated embeddable device-bezel
  widget for marketing pages — not the design system plugin markup actually
  depends on. The real dependency is `https://trmnl.com/css/latest/plugins.css`
  + `https://trmnl.com/js/latest/plugins.js`, which has no public repo or
  self-hostable alternative; it's CDN-only. But Terminus's own extension-preview
  layout (`app/templates/layouts/extension.html.erb` in `usetrmnl/terminus`,
  TRMNL's own officially-blessed self-hosted reference implementation) hotlinks
  those exact two URLs live, on every render, unconditionally. That's good
  enough precedent: if TRMNL's own reference self-host does this, it's the
  intended integration model, not something we'd be pushing new ToS boundaries
  on. Mode B should do the same — hotlink at render time, matching Terminus's
  own behavior, rather than trying to vendor an asset that isn't distributed
  for vendoring.
- **Ephemeral headless Chromium on the Pi** — confirmed working, empirically, on
  `vanessapi` itself. `chromium-browser` 126.0.6478.164 is already installed via
  apt (`archive.raspberrypi.org`, armhf — yes, 32-bit; this works despite the
  Docker/Terminus 32-bit blocker because it's a native apt package, not a
  container image). `chromium-browser --headless=new --disable-gpu --no-sandbox
  --screenshot=out.png --window-size=800,480 file:///path/to.html` produced a
  correct PNG from local HTML in ~5s wall-clock, with zero lingering process
  afterward (`ps aux` clean within 1s of exit). No Puppeteer/Playwright needed
  (both have real arm32 gaps), no bundled binary needed.

### `localRenderer.ts` status (2026-07-12)

The `render(id) → {imageBuffer, contentType}` path is implemented
(`src/localRenderer.ts`) and validated end-to-end against a real, live Recipe
(id 369398, "Shakespeare Quotes", strategy `polling`, zero required config
fields): downloads the archive, parses `settings.yml`, fetches live data from
the Recipe's own `polling_url`, renders `full.liquid` with `liquidjs`, wraps it
in a page that hotlinks `plugins.css`/`plugins.js`, and screenshots it via
`chromium-browser --headless=new` — producing a correct, readable 800×480 PNG
with the live-fetched quote text, book title, and author, correctly styled by
the framework CSS. Verified via a throwaway script driving the Pi's
`chromium-browser` over SSH (no Chromium on the dev Mac); not yet wired into a
vitest test that spawns Chromium (network + binary dependent, doesn't belong
in CI as-is).

One real bug found and fixed in the process: the content must be wrapped in
`<div class="view view--full">…</div>` inside `.screen` — omitting that
wrapper (easy to miss; Terminus's own layout transform does this, but it
wasn't obvious until tested) left `data-value-fit`-sized text invisible even
though the framework CSS/JS had loaded fine. `RENDER_SETTLE_MS` (the
`--virtual-time-budget` passed to Chromium) is 3000ms — confirmed sufficient
even though `plugins.css` alone is a surprisingly large ~13.5MB download.

Not yet built: the settings-form values used in this test were all defaults
(no custom fields required for this particular Recipe) — a Recipe with real
required custom fields (e.g. VRM Dashboard's `vrm_token`) hasn't been exercised
yet. Also unverified: the `.title_bar` (icon/label/tags footer) rendered
correctly in an earlier debug pass but wasn't visible in the final cropped
screenshot — worth confirming it's actually present at the bottom of the frame
before calling visual output "done," not just the main content area.

### Sequencing

Mode A ships first since it's simpler and already validated end-to-end against a
real Terminus instance (though its own next step, deploying Terminus on
`vanessapi`, is now blocked — see below). Mode B's renderer core now works;
next steps are the browse/select and settings-form UI pieces, plus wiring
`localRenderer.ts` into `platform.ts` behind a config option alongside Mode A.

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
