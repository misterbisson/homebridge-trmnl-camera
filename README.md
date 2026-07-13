# homebridge-trmnl-camera

Homebridge platform plugin that renders any [TRMNL](https://usetrmnl.com) Recipe or Terminus extension as a HomeKit camera. Configure one or more entries and each becomes a camera accessory showing a glanceable snapshot of that plugin's current rendered output, with a low-fps live view looping the same static frame (inspired by [homebridge-website-to-camera](https://github.com/werthdavid/homebridge-website-to-camera)).

Nothing here is specific to any one TRMNL plugin. This plugin is a thin client: trigger a render, cache the result, serve it to HomeKit — via either of two interchangeable rendering modes, mixed freely across cameras in the same config.

## Two rendering modes

**Mode A — bring your own [Terminus](https://github.com/usetrmnl/terminus).** You run and maintain a self-hosted Terminus instance yourself; this plugin logs in, triggers a build for a configured extension ID, and scrapes the rendered image.

```
TRMNL extension (Liquid + data source) → Terminus (self-hosted, does the render) → this plugin (caches + serves) → HomeKit camera
```

**Mode B — self-contained, no Terminus needed.** Point a camera at a public [TRMNL Recipe](https://trmnl.com/recipes) ID instead, and this plugin does the rendering itself: downloads the Recipe's archive, fetches its data source, renders its Liquid template (including TRMNL's real custom filters and `{% template %}`/`{% render %}` tags — see [docs/architecture.md](docs/architecture.md)), and screenshots it via an ephemeral headless Chromium process.

```
TRMNL Recipe (downloaded archive) → this plugin (fetches data + renders Liquid + screenshots) → HomeKit camera
```

Both modes reduce to the same thing under the hood — render an image, cache it, serve it — so a single Homebridge instance can run some cameras against Terminus and others self-contained, side by side.

See [docs/architecture.md](docs/architecture.md) for how each mode works internally and what's been verified so far, and [docs/roadmap.md](docs/roadmap.md) for ideas parked for later.

## Requirements

- Homebridge 1.8+ or 2.0+.
- **For Mode A cameras**: a running [Terminus](https://github.com/usetrmnl/terminus) instance, reachable from the Homebridge host, with at least one extension already configured.
- **For Mode B cameras**: a `chromium`/`chromium-browser` binary on the Homebridge host supporting `--headless=new --screenshot` (confirmed working via the `chromium-browser` apt package on Raspberry Pi OS).

## Configuration

```json
{
  "platform": "TrmnlCamera",
  "terminusBaseUrl": "http://vanessapi.tail9a4f0.ts.net:2300",
  "terminusEmail": "you@example.com",
  "terminusPassword": "...",
  "chromiumPath": "chromium-browser",
  "cameras": [
    {
      "label": "VRM Dashboard",
      "terminusExtensionId": 12,
      "pollIntervalSeconds": 900,
      "streamFps": 1
    },
    {
      "label": "Shakespeare Quotes",
      "recipeId": 369398,
      "fieldValues": [],
      "pollIntervalSeconds": 900,
      "streamFps": 1
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `terminusBaseUrl` | Base URL of the Terminus instance. Only needed if any camera sets `terminusExtensionId`. |
| `terminusEmail` / `terminusPassword` | Credentials for the Terminus account used to trigger renders (Terminus has no token-based API; this drives its session-cookie login). Only needed for Mode A cameras. |
| `chromiumPath` | Path to a chromium/chromium-browser binary (default `chromium-browser`). Only needed if any camera sets `recipeId`. Ignored if `chromiumServiceUrl` is set. |
| `chromiumServiceUrl` | Base URL of a [`docker/chromium-service`](docker/chromium-service) instance instead of a local binary — for hosts where Homebridge itself runs in a container with no working Chromium (e.g. Ubuntu images, where `chromium-browser`/`firefox` are snap-transitional stubs). Takes precedence over `chromiumPath`. |
| `cameras[].label` | Accessory name shown in the Home app. |
| `cameras[].terminusExtensionId` | **Mode A.** Numeric ID of the Terminus extension to render (visible in its URL, e.g. `/extensions/12`). Set this or `recipeId`, not both. |
| `cameras[].recipeId` | **Mode B.** Numeric ID of a public TRMNL Recipe (from [trmnl.com/recipes.json](https://trmnl.com/recipes.json) or a Recipe's URL). Set this or `terminusExtensionId`, not both. |
| `cameras[].fieldValues` | **Mode B only.** Array of `{key, value}` pairs for the Recipe's custom fields (e.g. an API token or location). Fields left unset fall back to the Recipe's own default. |
| `cameras[].screenWidth` / `cameras[].screenHeight` | **Mode B only.** Rendered image dimensions (default 800×480). |
| `cameras[].pollIntervalSeconds` | How often to trigger a fresh render (default 900s / 15min, matching TRMNL's own typical refresh cadence). Also the cache TTL. |
| `cameras[].streamFps` | Framerate advertised for live view of the (static) rendered frame (default 1). |

### Adding a new camera

**Mode A (Terminus):**
1. In Terminus, add the extension you want to display — either write its Liquid + Exchange by hand, or import it from the [Gallery](https://usetrmnl.com/recipes).
2. Note its extension ID from the URL (`/extensions/<id>`).
3. Add an entry to `cameras` with that `terminusExtensionId`.

**Mode B (self-contained):**
1. Find a Recipe at [trmnl.com/recipes](https://trmnl.com/recipes) and note its numeric ID.
2. Add an entry to `cameras` with that `recipeId`, plus `fieldValues` for any custom fields it requires (check the Recipe's page for what it needs).

Either way: restart Homebridge and a new camera accessory appears for pairing. No code changes are ever needed — the `cameras` array is the entire extension point.

## Design notes

- **No dependency on `homebridge-camera-ffmpeg`**: `ffmpeg` is bundled directly via [`ffmpeg-for-homebridge`](https://github.com/homebridge/ffmpeg-for-homebridge) (prebuilt ARM64 binaries), so this plugin has no runtime dependency on another Homebridge plugin.
- **Caching + request coalescing**: [`src/renderCache.ts`](src/renderCache.ts) caches each camera's rendered JPEG for `pollIntervalSeconds`. Concurrent snapshot requests during a stale-cache moment share one in-flight render instead of each triggering their own.
- **Live view of a static image**: [`src/camera.ts`](src/camera.ts) loops the cached JPEG through `ffmpeg` into a low-fps H.264/SRTP stream — there's no enforced minimum HomeKit streaming framerate, and a static frame compresses to near-nothing via P/B-frame prediction.
- **HomeKit Secure Video timeline is not implemented yet.** This first pass only advertises snapshot + live view.
- **Mode B renders TRMNL's actual Liquid dialect**, not just stock Liquid — see [`src/trmnlLiquid.ts`](src/trmnlLiquid.ts), ported from [`usetrmnl/trmnl-liquid`](https://github.com/usetrmnl/trmnl-liquid), TRMNL's own gem.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run against a real Homebridge instance locally with `homebridge -D -U <path-to-a-scratch-config-dir>`.
