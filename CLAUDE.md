# CLAUDE.md

Guidance for Claude Code sessions in this repo. See [README.md](README.md) for setup/config,
[docs/architecture.md](docs/architecture.md) for current status + how each mode works, and
[docs/roadmap.md](docs/roadmap.md) for parked ideas — this file covers conventions and gotchas
that aren't obvious from the code itself.

## Scope discipline

This plugin's rendering scope is bounded by what [Terminus](https://github.com/usetrmnl/terminus)
itself supports (community Recipes), not the full TRMNL platform — see
[docs/architecture.md](docs/architecture.md#scope-settled-2026-07-13) for the reasoning and the
roadmap table it's based on. Native/third-party TRMNL plugins (Weather, Hacker News, etc.) are
deliberately out of scope; don't treat a request to support one as an obvious yes, and don't
assume "Terminus doesn't do X either" settles whether Mode B should — check
docs/architecture.md's scope section first.

## Documentation over memory or issues

Persist project decisions and technical findings in `docs/architecture.md` (current state +
chronological technical record) or `docs/roadmap.md` (parked ideas), not GitHub issues — the user
has explicitly said they don't want issues used for tracking in this repo. `docs/architecture.md`
leads with a "Current status" summary per mode; keep new dated findings appended below that,
don't bury the current state under a pile of history.

## Ground truth over guessing or reimplementations

When porting TRMNL/Terminus behavior (Liquid filters, custom tags, archive formats, rendering
quirks), trace the actual official source — `usetrmnl/terminus`, `usetrmnl/trmnlp`,
`usetrmnl/trmnl-liquid` — rather than guessing or copying another project's reimplementation
(e.g. `usetrmnl/inker`'s JS port was useful corroboration but the real Ruby gem was the actual
reference for `src/trmnlLiquid.ts`). Verify against real, live Recipes (Shakespeare Quotes id
369398, Blunt Weather id 305453, Paperboy id 152705 are the three currently-verified test cases),
not just unit tests — several real bugs (the shared.liquid/full.liquid single-pass-render fix,
the `.view view--full` wrapper, the missing Inter font) were only caught this way.

## Security

Recipes are untrusted third-party content downloaded from a public marketplace. Don't use
`eval`/`new Function` on anything derived from Recipe template text — see `where_exp` in
`src/trmnlLiquid.ts` for a hand-parsed alternative to that pattern.

## Local verification pipeline

```bash
npm run typecheck && npm test && npm run build
```

Network- and Chromium-dependent code (Recipe fetching, `localRenderer.ts`'s screenshot step) isn't
covered by vitest — verify manually against a live Recipe (see `docs/architecture.md` for the
throwaway-script pattern used throughout this project) and note what was checked in the commit
message, the way past commits on this repo do.

## Git discipline

- Always ask before `git push`, every time — a prior push does not authorize the next one, even
  moments later in the same conversation.
- Commit messages should explain *why*, including what broke and was fixed, not just *what*
  changed — see this repo's own log for the expected level of detail.

## Live infrastructure (`vanessapi`)

This plugin is deployed for real on the project's production Homebridge instance (Pi, Tailscale
hostname `vanessapi.tail9a4f0.ts.net`, Homebridge dashboard at `:8581`), alongside
`homebridge-signalk` and `homebridge-unifi-protect` — treat that container as shared,
consequential infrastructure, not a sandbox:
- Never `cat` the live `config.json` directly — it contains other plugins' embedded credentials.
  Use a targeted read (e.g. a small Node script printing just `platforms[].platform`/`name`) when
  you need to inspect its structure.
- Confirm explicitly before any action that touches the running container (restarts, `docker
  exec` writes, dependency installs) — a specific proposal needs its own explicit yes, even right
  after a related one was approved.
- The plugin is installed by cloning this repo directly into the Homebridge container's
  `node_modules/homebridge-trmnl-camera` and building in place (it isn't published to npm) — see
  docs/architecture.md's "Deployed on vanessapi" section for the exact steps.
- `docker/chromium-service/` exists because that container has no working Chromium (Ubuntu's
  `chromium-browser`/`firefox` are snap-transitional stubs; snapd doesn't run in containers) — see
  its own README before assuming a local `chromiumPath` will work there.
- The container's bundled `avahi-daemon` conflicts with the host's own (both share one interface
  via `network_mode: host`), producing cosmetic "Host name conflict" log spam. This is
  **documented and deliberately not fixed** in the sibling `homebridge-pi` repo's
  `docker-compose.yml` — disabling it breaks `homebridge-signalk`'s `.local` device resolution.
  Don't re-attempt that fix without re-reading that note first.
- `homebridge-pi` is a separate repo (`misterbisson/homebridge-pi`) scoped to Homebridge core
  config, not this plugin — the Pi's own local clone of it can be stale/diverged from the
  canonical GitHub history (confirmed 2026-07-14), so prefer the Mac's own clone for changes there
  when both are available.

## Sibling repos

- [`trmnl-vrm`](https://github.com/misterbisson/trmnl-vrm) — the actual driving use case (VRM
  Dashboard), a Cloudflare Worker + `trmnlp` plugin project, not yet tested end-to-end through this
  plugin (not published as a Gallery Recipe, so it can't use `renderRecipe(recipeId)` directly —
  would need sourcing its Liquid/settings from GitHub instead of the archive endpoint).
- [`homebridge-pi`](https://github.com/misterbisson/homebridge-pi) — Homebridge core Docker Compose
  config for `vanessapi`. Don't fold this plugin's own infrastructure (like `chromium-service`)
  into that repo; keep it in this one, deployed alongside.
