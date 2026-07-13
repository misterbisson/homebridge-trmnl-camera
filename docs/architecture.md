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

Two real bugs found and fixed in the process, both by diffing against
`usetrmnl/trmnlp`'s own `web/views/render_html.erb` (TRMNL's official local
plugin-preview tool — the single best ground truth for "how is a plugin
supposed to be wrapped for screenshotting," since that's exactly its job):

1. Content must be wrapped in `<div class="view view--full">…</div>` inside
   `.screen` — omitting that wrapper (easy to miss; Terminus's own layout
   transform does this too, but it wasn't obvious until tested) left
   `data-value-fit`-sized text invisible even though the framework CSS/JS had
   loaded fine.
2. `.screen` must **not** get explicit `width`/`height`/`overflow` CSS from
   us — `plugins.css` sizes it intrinsically, and trmnlp's own template sets
   none of those either. The original version of this code set all three,
   which silently pushed `.title_bar` (the icon/label/tags footer) out of the
   visible frame. Also missing: the Inter font (`fonts.googleapis.com`),
   which trmnlp's template loads and `plugins.css` expects — without it,
   text fell back to a generic sans-serif.

Current state after both fixes: the main content area (quote text, book
title, author, correctly sized and typeset in Inter/serif) renders correctly
against live data. `.title_bar` now renders *as a box* (its background is
visible) but its contents — icon, `{{ trmnl.plugin_settings.instance_name }}`,
`{{ tags | join: ", " }}` — are not visible inside it. Ruled out: render
timing (identical result from `RENDER_SETTLE_MS` 3000 through 8000ms) and the
hotlinked icon URL (resolves fine, 200, when redirects are followed, which a
real browser does automatically). Leading unconfirmed hypothesis: this
Recipe's `settings.yml` pins `framework_version: 3.1.1`, but we always hotlink
`.../latest/plugins.css`+`.js` — if "latest" has since diverged from 3.1.1,
`.title_bar`'s internal layout could easily have changed. Worth checking
whether the framework CDN serves versioned URLs (`.../3.1.1/plugins.css`) we
could pin to instead of `latest`, before spending more time on this.

### Real-plugin survey: Paperboy and Blunt Weather (2026-07-13)

Scope note: running Terminus to support *other physical TRMNL devices* stays
out of scope (per [[feedback-scope-terminus-is-overkill]]), but rendering
*typical Recipes correctly* is squarely in scope — that's the actual point of
Mode B. Pulled two more real Recipe archives to check what "typical" requires
beyond Shakespeare Quotes' easy case.

**Paperboy** (id 152705, hundreds of newspaper front pages) turned out to be
the complex outlier, not the typical case: its `full.liquid` is just
`{% render "main", data: data, trmnl: trmnl, IDX_0: IDX_0, IDX_1: IDX_1 %}`,
with real markup living in `shared.liquid` inside `{% template main %}…
{% endtemplate %}` — custom Liquid tags `liquidjs` doesn't have. Its
`polling_url` is *two* newline-separated URLs (one RSS feed, one a
device-battery-telemetry beacon we have no reason to call), referenced in
markup as `IDX_0`/`IDX_1` — i.e. TRMNL supports multiple poll sources per
plugin, with XML/RSS response parsing, not just single-JSON. Its `newspaper`
custom field is `multiple: true` (array-valued, not a plain string). None of
this is implemented; still an open gap, deliberately deferred (see below).

**Blunt Weather** (id 305453, Open-Meteo-backed sarcastic weather commentary)
was the more representative "typical plugin" case — clean single-JSON poll,
no multi-source/XML/custom-tag complexity — and exercising it end-to-end
found two real, now-fixed bugs plus confirmed one design decision:

1. **Bug: `shared.liquid` and `full.liquid` were rendered as two separate
   Liquid passes.** `{% assign %}` variables set in `shared.liquid` (which is
   *all* Blunt Weather's `shared.liquid` is — no custom tags, just plain
   assigns) never reached `full.liquid`'s render context, so every derived
   value (`mood_line`, `weather_category`, `sunrise_fmt`, …) came out empty.
   Terminus's own `extractor.rb` joins the raw *source* before rendering, not
   the rendered *output* — `renderMarkup()` now does the same (concatenate,
   then one `parseAndRender` call). This was silent and easy to miss because
   each half rendered "successfully" on its own, just with entirely blank
   assigned values.
2. **Bug: custom field values weren't available during poll-templating.**
   Blunt Weather's `polling_url` references
   `{{ trmnl.plugin_settings.custom_fields_values.latitude }}` (the
   fully-qualified path), while Shakespeare Quotes and Paperboy both used the
   bare `{{ fieldname }}` shorthand — both conventions are apparently normal
   among Recipe authors. `fetchPolledData()` now templates against
   `{ ...fieldValues, ...trmnlContext }`, so both resolve.
3. **Design decision: `trmnl.device.*`/`trmnl.system.*`/`trmnl.user.*` need
   stub values**, grounded in `usetrmnl/trmnl-display` (TRMNL's official
   Linux/Raspberry Pi client) rather than guessed — that client has no real
   battery, so it just hardcodes `battery-voltage: 100.00` and `rssi: 0` in
   every request rather than reading real hardware. `buildTrmnlContext()`
   follows the same precedent: `device.percent_charged = 100`,
   `device.friendly_id` = a slug of the camera label (no real device, any
   stable string works), `system.timestamp_utc` = real current time,
   `user.utc_offset` = 0 (UTC) unless overridden via `LocalRenderOptions`.

Also added: a `sample` Liquid filter (`{{ lines | sample }}`, pick one random
array element) — confirmed needed by Blunt Weather, not present in stock
`liquidjs`. TRMNL's own Ruby Liquid environment explicitly supports
registering extra filters (per `trmnlp`'s `renderer.rb`), so this is expected,
not a red flag; more may surface as more Recipes get exercised.

Verified end-to-end against real coordinates: correct icon, correct
temperature (`"It's now 60°F, but it feels like 61°F"`), correct sunrise/
sunset, correct sarcastic mood line selection. New visual issue surfaced:
the mood-line text overflows past the 480px frame on longer lines — same
*class* of layout-fit issue as `.title_bar` above, not yet root-caused;
noted here rather than chased further this pass.

**Still deliberately out of scope for now** (Paperboy-class plugins):
multi-source (`IDX_N`) polling, XML/RSS response parsing, and TRMNL's custom
`{% template %}`/`{% render %}` Liquid tags. Worth returning to once it's
clear how common this shape actually is among Recipes the user cares about —
right now it's a sample size of one.

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
