# Architecture

This plugin supports two interchangeable ways of getting a rendered image for
a given TRMNL plugin, mixed freely across cameras in the same config. Both are
implemented today.

## Scope (settled 2026-07-13)

This plugin's rendering scope is bounded by what
[Terminus](https://github.com/usetrmnl/terminus) itself supports — not the
full TRMNL platform. Straight from Terminus's own roadmap table
([`doc/extensions.adoc`](https://github.com/usetrmnl/terminus/blob/main/doc/extensions.adoc)):

| Feature | Terminus status |
| --- | --- |
| Private extensions | 🟢 Supported |
| Public extensions | 🟢 Supported |
| Recipes | 🟢 Supported |
| Import (Core) | 🟢 Supported |
| Import/Export (Terminus) | 🟢 Supported |
| **Native** | **⚪️ Planned** |
| **Third Party** | **⚪️ Planned** |

**In scope, both modes**: community Recipes — Liquid template + `settings.yml`
+ a polling or static data source, browsable via
[`trmnl.com/recipes.json`](https://trmnl.com/recipes.json) and downloadable
via `usetrmnl.com/api/plugin_settings/:id/archive`.

**Out of scope for now**: native/first-party TRMNL plugins (Weather, Hacker
News, PurpleAir, Lunar Calendar, Alpenglow, Wiki Random Article, Days Left in
Year, and others listed at
[`trmnl.com/integrations`](https://trmnl.com/integrations)) and third-party
marketplace plugins. Not because they were ruled out on their merits — because
**Terminus itself doesn't support them either** (marked ⚪️ *Planned* in its
own roadmap, not 🟢 *Supported*). There's no existing self-hosted renderer to
match for that category; supporting it would mean writing bespoke per-plugin
integrations (each native plugin is a server-side Ruby class + data-fetching
logic + ERB view, not a downloadable Liquid archive — see
[`usetrmnl/plugins`](https://github.com/usetrmnl/plugins), and most have no
public source at all), not extending a generic renderer. If this becomes a
real ask later, treat it as new scope, not a Mode A/B gap to close.

**Why this framing matters**: it keeps "is Mode B good enough" well-defined.
Mode B is measured against Terminus's Recipe-rendering completeness — which is
why the [`trmnl-liquid`](https://github.com/usetrmnl/trmnl-liquid) port exists
(below), since Terminus's own `Gemfile` depends on that gem directly
(`gem "trmnl-liquid", "~> 0.6"`) and Mode B needs the same fidelity, not
Terminus's full feature set (Postgres, accounts, playlists, native plugins —
deliberately not being replicated either; see "Mode B" below for why running
full Terminus was ruled out in the first place).

## Mode A — bring your own Terminus

Config is `terminusBaseUrl` + credentials (see [README](../README.md#configuration)).
The plugin is a thin HTTP client (`src/terminusClient.ts`) that logs into a
self-hosted [Terminus](https://github.com/usetrmnl/terminus) instance, triggers a
build for a configured extension ID, and scrapes the resulting rendered image.
The user runs and maintains Terminus themselves; its own web UI handles browsing
and configuring plugins. This plugin doesn't know or care what any given
extension displays.

**Status**: implemented and validated end-to-end against a real Terminus
instance. Deploying Terminus on `vanessapi` (the project's own Pi) for further
testing is currently blocked — its userspace is 32-bit Raspbian bullseye
(`armhf`), and Terminus's own images (Postgres 18, Valkey 9, the Terminus app
image) only publish `amd64`/`arm64` manifests. No other 64-bit host is
available right now; not being actively worked around (would need reimaging
the Pi or a different host). This is part of why Mode B — which needs nothing
Docker-based — became the priority instead (see "Native plugins and Terminus
comparison" below for the full reasoning).

## Mode B — self-contained, no external Terminus

Running a full Terminus instance is real ongoing maintenance — Postgres, Redis,
Sidekiq, a web app, user accounts — for a need that's actually much narrower:
pick N plugins, render each on an interval, serve as a HomeKit camera. Terminus
doesn't offer a way to use just its render engine without the rest of the app, so
Mode B means building a narrower renderer, not slimming Terminus down.

### Current status (2026-07-14)

**Implemented and wired into the plugin end-to-end.** A camera configured with
`recipeId` (instead of `terminusExtensionId`) renders via `src/localRenderer.ts`
with no Terminus involved at all — see `platform.ts`'s mode dispatch and
`config.schema.json`'s `recipeId`/`fieldValues`/`screenWidth`/`screenHeight`/
`chromiumPath` fields, and the [README](../README.md#configuration) for the
user-facing config shape.

What this renders correctly today, confirmed against real, live Recipes:

- **Shakespeare Quotes** (id 369398) — simplest case: single JSON poll, no
  required config fields.
- **Blunt Weather** (id 305453) — real custom fields (lat/long/unit) templated
  into the poll request; TRMNL's `sample` filter; the fully-qualified
  `trmnl.plugin_settings.custom_fields_values.*` field-access convention.
- **Paperboy** (id 152705) — the most complex Recipe tested: TRMNL's custom
  `{% template %}`/`{% render %}` Liquid tags, multi-source polling (an RSS
  feed + an unrelated device-telemetry beacon, both fetched independently),
  and XML/RSS response parsing. Renders a real, live newspaper front page.

Verified end-to-end in an actual Homebridge process (not just the render
pipeline standalone): the plugin loads, `platform.ts` registers a full HomeKit
camera accessory (`AccessoryInformation` + two `CameraRTPStreamManagement`
services) for a `recipeId`-configured camera with no Terminus config present
at all. Not yet verified: pairing that accessory with a real Home app on a
real device (needs the user's own iOS device) — the Homebridge-level wiring is
confirmed, actual HomeKit pairing is the remaining step.

**Known, non-blocking gaps**:
- A layout-fit issue where some Recipes' text/`.title_bar` content overflows
  or doesn't render within the configured screen height on certain inputs
  (first seen with Shakespeare Quotes' `.title_bar`, also seen in Blunt
  Weather's longer mood lines) — see "`localRenderer.ts` status" below.
  Leading unconfirmed hypothesis: a `framework_version` pin mismatch (Recipes
  pin a specific version in `settings.yml`; this plugin always hotlinks
  `.../latest/`).
- No settings-form or Recipe-browse UI yet (`fieldValues` must be entered by
  hand in `config.schema.json`'s array-of-`{key,value}` field). See
  [docs/roadmap.md](roadmap.md) for the "authenticate against the user's own
  TRMNL account" idea that could simplify or replace this.
- Native/third-party plugins are out of scope (see "Scope" above).

The rest of this section is a chronological technical record of how each piece
above was built and verified — useful as reference/rationale, not required
reading to understand current status.

<details>
<summary>In this mode the plugin absorbs what Terminus normally provides (original design, 2026-07-12)</summary>

1. **Browse/select plugins** — inside Homebridge's config UI (a Homebridge UI X
   custom UI panel backed by the plugin's own endpoints), search TRMNL Recipes
   (`trmnl.com/recipes.json`) and/or enter a private plugin ID, then download
   its archive (`usetrmnl.com/api/plugin_settings/:id/archive`, a zip — see
   "Recipe archive format" below). **Not built yet** — see "Known,
   non-blocking gaps" above.
2. **Configure plugin options** — the archive's `settings.yml` has a
   `custom_fields` array (e.g. VRM Dashboard's `vrm_token` /
   `vrm_installation_id` / `timezone`); render a form from it and store the
   entered values per-camera. **Not built yet** — currently a manual
   `fieldValues` array in config instead.
3. **Render** — fetch the plugin's data source (`polling_url` /
   `polling_headers` / `polling_body`, Liquid-templated with the custom field
   values — the same shape as Terminus's Exchange), render `full.liquid` to
   HTML with `liquidjs`, wrap it in a page that hotlinks
   `trmnl.com/css/latest/plugins.css` + `.../plugins.js` (matches Terminus's
   own behavior, not a new integration), and screenshot via an **ephemeral**
   headless Chromium (spawned per render, exiting after — not a persistent
   browser process, ruled out elsewhere in this project for Pi resource
   reasons). **Built** — this is `src/localRenderer.ts`.

</details>

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
  `full.liquid` (+ `shared.liquid` when present); the half/quadrant layouts
  are for physical e-ink models, not a HomeKit camera tile.
- `settings.yml` fields that matter: `strategy` (`polling` or `static` —
  `oauth` strategy is out of scope, same as Terminus itself doesn't support
  it), `polling_url` / `polling_verb` / `polling_headers` / `polling_body`
  (the data-source request; `polling_url` may itself contain Liquid, e.g.
  `{{ vrm_token }}`-style templating against custom field values, and may be
  more than one newline-separated URL — see "Multi-source polling" below),
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
  doesn't need that indirection since it isn't going through Terminus.)
- Markup uses TRMNL Design System classes (`.layout`, `.flex`, `.flex--col`,
  `.value`, `.value--large`, `.label`, `.title_bar`, `.title`, `.image`, plus
  `data-value-fit`/`data-value-fit-max-height` attributes for JS-driven
  autosizing text) — these only render correctly with `plugins.css`/
  `plugins.js` loaded, and the autosize JS needs a moment to settle before the
  screenshot is taken (not just "load and shoot immediately").

### Shared contract

Both modes reduce to the same interface further down the stack —
`render(id) → { imageBuffer, contentType }` — so `renderCache.ts`, `camera.ts`,
and `platform.ts` don't need to know which mode is active per camera; only
`terminusClient.ts` (Mode A) vs. `localRenderer.ts` (Mode B) differ, dispatched
in `platform.ts` based on whether a camera config sets `terminusExtensionId`
or `recipeId`.

### Open unknowns — spiked 2026-07-12, all resolved favorably

- **Is there a real, documented "list/search TRMNL Recipes" API?** Yes —
  `GET https://trmnl.com/recipes.json`, no auth. Params: `search` (name match),
  `sort-by` (oldest/newest/popularity/fork/install), `user_id`, `per_page` (max
  100, default 25). Response: paginated `data` array of
  `{id, user_id, name, published_at, icon_url, icon_content_type,
  screenshot_url, author_bio, custom_fields, stats}` plus pagination `meta`.
  `custom_fields` is exactly the settings-form data a future browse/select UI
  would need. Verified live. Docs (docs.trmnl.com/go/public-api/recipes-api)
  still call it "alpha, may move to `/api/recipes` or `/api/plugins`" — the
  stated deadline has passed and the endpoint hasn't moved, but re-check
  before building against it since it's explicitly unstable.
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
  enough precedent: Mode B hotlinks the same two URLs at render time, matching
  Terminus's own behavior rather than pushing any new ToS boundary.
- **Ephemeral headless Chromium on the Pi** — confirmed working, empirically, on
  `vanessapi` itself. `chromium-browser` 126.0.6478.164 is already installed via
  apt (`archive.raspberrypi.org`, armhf — yes, 32-bit; this works despite the
  Docker/Terminus 32-bit blocker because it's a native apt package, not a
  container image). `chromium-browser --headless=new --disable-gpu --no-sandbox
  --screenshot=out.png --window-size=800,480 file:///path/to.html` produced a
  correct PNG from local HTML in ~5s wall-clock, with zero lingering process
  afterward. No Puppeteer/Playwright needed (both have real arm32 gaps), no
  bundled binary needed.

### `localRenderer.ts` status — bugs found while building it

Two real bugs found and fixed early on, both by diffing against
`usetrmnl/trmnlp`'s own `web/views/render_html.erb` (TRMNL's official local
plugin-preview tool — the single best ground truth for "how is a plugin
supposed to be wrapped for screenshotting," since that's exactly its job):

1. Content must be wrapped in `<div class="view view--full">…</div>` inside
   `.screen` — omitting that wrapper left `data-value-fit`-sized text
   invisible even though the framework CSS/JS had loaded fine.
2. `.screen` must **not** get explicit `width`/`height`/`overflow` CSS from
   us — `plugins.css` sizes it intrinsically, and trmnlp's own template sets
   none of those either. The original version of this code set all three,
   which silently pushed `.title_bar` (the icon/label/tags footer) out of the
   visible frame. Also missing: the Inter font (`fonts.googleapis.com`), which
   trmnlp's template loads and `plugins.css` expects — without it, text fell
   back to a generic sans-serif.

After both fixes: main content areas (quote text, weather text, newspaper
images) render correctly against live data, in the right font. `.title_bar`'s
box renders but its contents (icon, instance label, tags) are still not
reliably visible — ruled out render timing (`RENDER_SETTLE_MS` 3000 through
8000ms, no difference) and the hotlinked icon URL (resolves fine). Leading
unconfirmed hypothesis: Recipes pin a `framework_version` in `settings.yml`
(e.g. `3.1.1`), but this plugin always hotlinks `.../latest/plugins.css`+`.js`
— if "latest" has diverged from what a given Recipe was built against,
`.title_bar`'s internal layout could easily have changed. Worth checking
whether the framework CDN serves versioned URLs we could pin to instead of
`latest`, if this becomes worth chasing further.

### Real-plugin survey: Paperboy and Blunt Weather (2026-07-13)

Pulled two more real Recipe archives beyond Shakespeare Quotes to check what
"typical" requires.

**Paperboy** (id 152705, hundreds of newspaper front pages) turned out to be
the complex outlier: its `full.liquid` is just
`{% render "main", data: data, trmnl: trmnl, IDX_0: IDX_0, IDX_1: IDX_1 %}`,
with real markup living in `shared.liquid` inside `{% template main %}…
{% endtemplate %}` — custom Liquid tags stock `liquidjs` doesn't have. Its
`polling_url` is *two* newline-separated URLs (one RSS feed, one a
device-battery-telemetry beacon), referenced in markup as `IDX_0`/`IDX_1`.
Its `newspaper` custom field is `multiple: true` (array-valued). All of this
is now implemented — see "`trmnl-liquid` port" and "Multi-source polling"
below.

**Blunt Weather** (id 305453, Open-Meteo-backed sarcastic weather commentary)
was the more representative "typical plugin" case — clean single-JSON poll —
and exercising it end-to-end found two real bugs (now fixed) plus one design
decision:

1. **Bug: `shared.liquid` and `full.liquid` were rendered as two separate
   Liquid passes.** `{% assign %}` variables set in `shared.liquid` never
   reached `full.liquid`'s render context, so every derived value (`mood_line`,
   `weather_category`, `sunrise_fmt`, …) came out empty. Terminus's own
   `extractor.rb` joins the raw *source* before rendering, not the rendered
   *output* — `renderMarkup()` now does the same (concatenate, then one
   `parseAndRender` call). This was silent and easy to miss because each half
   rendered "successfully" on its own, just with entirely blank assigned
   values.
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
   `device.friendly_id` = a slug of the camera label, `system.timestamp_utc` =
   real current time, `user.utc_offset` = 0 (UTC) unless overridden.

Verified end-to-end against real coordinates: correct icon, correct
temperature, correct sunrise/sunset, correct sarcastic mood line selection.

### Native plugins and Terminus comparison (2026-07-13)

Before investing further in Mode B, checked whether Terminus (Mode A) already
solves the harder cases for free:

- Native/first-party plugins (Weather, Hacker News, PurpleAir, Lunar
  Calendar, Alpenglow, Wiki Random Article, Days Left in Year — all seven
  checked via `trmnl.com/integrations/*`) are a different category entirely,
  not Recipes: `keyname`-addressed, not numeric-ID; not downloadable via the
  archive endpoint (confirmed 404); server-side Ruby (`.rb` class + `.html.erb`
  views) that only run on TRMNL's own infrastructure
  (`usetrmnl/plugins`, "non-exhaustive collection... in sharing these assets
  we intend to provide transparency," explicitly not meant to "just work" if
  self-hosted). Some (Hacker News) are fully open and trivial to port — two
  public, unauthenticated API calls. Others (Weather, PurpleAir, Alpenglow)
  have **zero public source** at all in that repo.
- Terminus's own docs (`doc/extensions.adoc`) mark "Native" support as
  ⚪️ *Planned*, not 🟢 *Supported* — same gap, not a Mode A advantage. This
  isn't a Mode A vs. Mode B tradeoff; nobody's self-hosted option handles
  native plugins today.
- Terminus's `Gemfile` depends directly on `gem "trmnl-liquid", "~> 0.6"` —
  TRMNL's real Ruby Liquid gem — so it renders every community Recipe
  (including Paperboy's custom tags) correctly, by construction. That was a
  genuine Terminus advantage for Recipes specifically, until the
  `trmnl-liquid` port below closed the gap — weighed against Terminus still
  being blocked on `vanessapi` (32-bit, no arm64 images).

Given native/third-party plugin support is equally unsolved either way, and
Recipe-rendering completeness is "critical" (user's framing), the decision was
to close Mode B's gap with Terminus on Recipes rather than revisit Mode A's
deployment blocker — i.e. port `trmnl-liquid` itself.

### `trmnl-liquid` port (2026-07-13)

Found and ported `usetrmnl/trmnl-liquid` directly — the actual Ruby gem
source (`lib/trmnl/liquid/filters.rb`, `template_tag.rb`, `memory_system.rb`),
not a guess and not another project's JS reimplementation. New module
`src/trmnlLiquid.ts`, `createTrmnlLiquidEngine()`:

- **All 16 filters** the gem defines: `append_random`, `days_ago`, `group_by`,
  `find_by`, `markdown_to_html` (via `marked`), `number_with_delimiter`,
  `number_to_currency`, `l_date`, `map_to_i`, `pluralize`, `json`,
  `parse_json`, `sample`, `where_exp`, `ordinalize`, `qr_code` (via `qrcode`,
  SVG output). `where_exp` (filter a collection by a Ruby-Liquid-condition-like
  expression string, e.g. `where_exp: "item", "item.active == true"`) is
  hand-parsed (tokenize, evaluate) rather than using `eval`/`new Function` —
  Recipes are untrusted third-party content downloaded from a marketplace, so
  executing constructed JS from their template text would be a real
  code-execution surface. Deliberate limitation: only resolves the loop
  variable's own (dotted) properties, not arbitrary outer-scope Liquid
  variables like the real gem can — not needed by anything tested so far.
- **`{% template name %}...{% endtemplate %}` + `{% render "name" %}`**
  (Paperboy's blocker): turned out to be simple, not deep parser surgery. The
  gem's version is one custom Liquid block tag (`TemplateTag`) that captures
  its raw, unparsed body into an in-memory map keyed by name
  (`MemorySystem#register`), plus Liquid's own **standard**, built-in `render`
  tag pointed at that map instead of real files. `liquidjs` already supports
  both custom tags and a pluggable `FS` for `render`/`include` lookups, so
  this ported directly — see `createTemplateTag()` (modeled on liquidjs's own
  built-in `RawTag`) and the `fs` object passed to `new Liquid({fs, ...})`.
- **One engine per `renderRecipe()` call, not a shared module-level instance.**
  The template-capture map is scoped to the engine that creates it; a shared
  instance would let concurrent renders (different cameras render
  independently) leak captured partials across each other, and Recipe authors
  commonly reuse generic partial names like "main" — a real collision risk,
  not theoretical.

**Verified against real Recipes**: Blunt Weather still renders correctly
(regression check). Paperboy's `{% template %}`/`{% render %}` now genuinely
executes — confirmed by rendering its raw HTML directly: the "main" partial's
CSS, `.frontpage` div, and `.title_bar` all came through correctly.

**`usetrmnl/inker`** (a TypeScript/React/Prisma BYOS server, a different
project from Terminus) was checked as a reference too — it has its own
`PluginRendererService` using `liquidjs` and a comparable filter set. Two
things *not* adopted from it: its `TRMNL_CSS` is a ~12KB hand-authored
approximation of the real framework, not the actual vendored `plugins.css`
(12.6KB vs. our hotlinked file's 13.5MB) — a fidelity risk, not a shortcut
worth taking. Its persistent-Puppeteer-browser pattern also wasn't adopted
(ephemeral chromium was already deliberately chosen for Pi resource reasons).
One thing worth borrowing later: it embeds the Inter font as base64 `data:`
URIs instead of hotlinking Google Fonts, avoiding an external font-CDN
round-trip on every render — not done yet, noted as a cheap future
improvement.

### Multi-source (`IDX_N`) polling (2026-07-13) — Paperboy fully closed

`RecipeSettings.pollUrl` can be more than one URL, newline-separated in the
same `settings.yml` field — confirmed via Paperboy: an RSS feed on one line, an
unrelated device-battery-telemetry beacon on the next. `fetchPolledData()`
splits on newlines, Liquid-templates and fetches each URL independently (same
shared verb/headers/body across all of them — `settings.yml` only has one
field for each, not per-URL), and returns an array of results instead of a
single value. `buildLiquidContext()` exposes every result as `IDX_0`/`IDX_1`/…
(TRMNL's real, native indexing — confirmed directly in Paperboy's
`full.liquid`) while *also* merging the first source's fields at the top
level, so single-source Recipes (bare `{{ quote }}` access) keep working
unchanged.

Response parsing branches on content-type: JSON as before, XML/RSS via
`fast-xml-parser` (confirmed against Paperboy's real feed — `rss.channel.item`
comes out as a 332-element array, exactly what its Liquid expects), anything
else as `{ raw: text }`. A failed source (network error, non-2xx) degrades to
`{}` rather than failing the whole render — a flaky secondary source (like a
telemetry beacon) shouldn't blank out a Recipe whose primary source succeeded;
Recipes typically already guard missing data with their own
`{% if %}`/fallback branches.

**Verified end-to-end against the real, live Paperboy Recipe**: a genuine,
current New York Times front page rendered correctly — live RSS fetch, XML
parse, random-newspaper-selection Liquid logic, and the `{% template %}`/
`{% render %}` mechanism, all working together.

## Next steps

1. **Real HomeKit pairing verification** — the Homebridge-level wiring is
   confirmed (accessory registers correctly with proper camera services for
   both modes); pairing with a real Home app on a real device hasn't been
   done yet.
2. The `.title_bar`/layout-fit issue (see "`localRenderer.ts` status" above),
   if it turns out to matter for real use.
3. Ideas parked in [docs/roadmap.md](roadmap.md) (e.g. a third mode that
   authenticates against the user's own TRMNL account) — deliberately not
   started until (1) is done.
