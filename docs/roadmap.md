# Roadmap / backlog

Ideas that have been discussed and are worth pursuing later, but are deliberately
not being worked on now. See [architecture.md](architecture.md) for the
current, in-progress design; this file is for things parked past that.

**Priority right now: a full end-to-end working solution first.** Mode B's
renderer handles real Recipes correctly (see architecture.md), but nothing
here should be started until a camera actually works end-to-end in Homebridge
— render pipeline wired into `platform.ts`, a real camera paired and showing
a real Recipe's output in the Home app. Everything below waits for that.

## Mode C — authenticate against the user's own TRMNL account (proposed 2026-07-14)

Instead of (or alongside) Mode B's plan to browse public Recipes and build a
settings-form UI from scratch, let the user authenticate with their own
`trmnl.com` account (a personal API key from `trmnl.com/account`, the same
mechanism `trmnlp login` uses) and read their **own already-configured**
plugin instances directly:

- `GET /api/plugin_settings` — list the user's own plugins (private + public
  they've created), authenticated via `Authorization: Bearer <api_key>`.
- `GET /api/plugin_settings/:id/archive` — download that instance's archive.
  This is the **same zip shape** (`settings.yml` + `full.liquid` etc.) already
  parsed for public Recipes — confirmed by reading `usetrmnl/trmnlp`'s
  `api_client.rb` and `commands/list.rb`.

**Why this is attractive**: if that authenticated archive includes the
instance's actual resolved `custom_fields_values` (not just field
definitions), a user who already has a `trmnl.com` account with plugins
configured — including private ones, like a real VRM Dashboard setup — could
skip re-entering any configuration in Homebridge at all: paste an API key,
pick from a list, done. This would replace most of Mode B's still-unbuilt
step 2 (the dynamic settings-form UI) for anyone with an existing account.

**Two things to spike before designing further** (not yet done):

1. Does `GET /api/plugin_settings/:id/archive` actually embed the real,
   resolved `custom_fields_values` for a private instance, or is it the same
   field-*definitions*-only shape already seen from anonymous public Recipe
   downloads? This is the whole value proposition — if it's the latter, Mode C
   only changes the browse step, not the configuration step.
2. Does `trmnl.com` allow creating an account / getting a personal API key
   without owning a physical TRMNL device? If not, Mode C only helps users who
   already have TRMNL hardware, which may or may not match this plugin's
   actual userbase.

**Also confirmed while researching this**: the `/api/plugin_settings*` REST
shape isn't `trmnl.com`-exclusive — `trmnlp`'s `base_url` is configurable, and
its own source comments mention other BYOS servers implementing the same API
with their own token format (likely Laravel/Sanctum-based servers like
LaraPaper, not Terminus — no evidence found that Terminus implements this
REST API; its own client (`src/terminusClient.ts`) still has to screen-scrape
Terminus's web UI instead). Not pursuing a Terminus API client swap now, but
worth knowing this pattern generalizes if that ever becomes worthwhile.

**Status**: parked. `trmnl-vrm`'s own `settings.yml` has a real `id: 376561`
already assigned, suggesting the user may already have a `trmnl.com` account
this could be spiked against — revisit this file when ready to pick it up.
