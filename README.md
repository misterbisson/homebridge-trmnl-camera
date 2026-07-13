# homebridge-trmnl-camera

Homebridge platform plugin that renders any [TRMNL](https://usetrmnl.com) plugin — private or a public [Recipe](https://usetrmnl.com/recipes) — as a HomeKit camera. Point it at a self-hosted [Terminus](https://github.com/usetrmnl/terminus) instance and configure one or more extension IDs; each becomes a camera accessory showing a glanceable snapshot of that extension's current rendered output, with a low-fps live view looping the same static frame (inspired by [homebridge-website-to-camera](https://github.com/werthdavid/homebridge-website-to-camera)).

Nothing here is specific to any one TRMNL plugin — the rendering itself happens in Terminus. This plugin is a thin client: trigger a render, cache the result, serve it to HomeKit.

## How it fits together

```
TRMNL extension (Liquid + data source) → Terminus (self-hosted, does the render) → this plugin (caches + serves) → HomeKit camera
```

Terminus does the actual Liquid-to-image rendering for whatever extensions are configured in it. This plugin doesn't know or care what any given extension displays — it just asks Terminus for the latest render of a given extension ID on a schedule, caches it, and exposes it as a camera snapshot + live view.

## Requirements

- A running [Terminus](https://github.com/usetrmnl/terminus) instance, reachable from the Homebridge host, with at least one extension already configured (private Liquid + Exchange, or imported from the Gallery).
- Homebridge 1.8+ or 2.0+.

## Configuration

```json
{
  "platform": "TrmnlCamera",
  "terminusBaseUrl": "http://vanessapi.tail9a4f0.ts.net:2300",
  "terminusEmail": "you@example.com",
  "terminusPassword": "...",
  "cameras": [
    {
      "label": "VRM Dashboard",
      "terminusExtensionId": 12,
      "pollIntervalSeconds": 900,
      "streamFps": 1
    }
  ]
}
```

| Field | Description |
| --- | --- |
| `terminusBaseUrl` | Base URL of the Terminus instance. |
| `terminusEmail` / `terminusPassword` | Credentials for the Terminus account used to trigger renders (Terminus has no token-based API; this drives its session-cookie login). |
| `cameras[].label` | Accessory name shown in the Home app. |
| `cameras[].terminusExtensionId` | Numeric ID of the Terminus extension to render (visible in its URL, e.g. `/extensions/12`). |
| `cameras[].pollIntervalSeconds` | How often to trigger a fresh render (default 900s / 15min, matching TRMNL's own typical refresh cadence). Also the cache TTL. |
| `cameras[].streamFps` | Framerate advertised for live view of the (static) rendered frame (default 1). |

### Adding a new camera

1. In Terminus, add the extension you want to display — either write its Liquid + Exchange by hand, or import it from the [Gallery](https://usetrmnl.com/recipes).
2. Note its extension ID from the URL (`/extensions/<id>`).
3. Add an entry to `cameras` in this plugin's config with that ID.
4. Restart Homebridge. A new camera accessory appears for pairing.

No code changes are ever needed to add a camera — the `cameras` array is the entire extension point.

## Design notes

- **No dependency on `homebridge-camera-ffmpeg`**: `ffmpeg` is bundled directly via [`ffmpeg-for-homebridge`](https://github.com/homebridge/ffmpeg-for-homebridge) (prebuilt ARM64 binaries), so this plugin has no runtime dependency on another Homebridge plugin.
- **Caching + request coalescing**: [`src/renderCache.ts`](src/renderCache.ts) caches each camera's rendered JPEG for `pollIntervalSeconds`. Concurrent snapshot requests during a stale-cache moment share one in-flight Terminus render instead of each triggering their own.
- **Live view of a static image**: [`src/camera.ts`](src/camera.ts) loops the cached JPEG through `ffmpeg` into a low-fps H.264/SRTP stream — there's no enforced minimum HomeKit streaming framerate, and a static frame compresses to near-nothing via P/B-frame prediction.
- **HomeKit Secure Video timeline is not implemented yet.** This first pass only advertises snapshot + live view.
- **Bring-your-own Terminus is the first of two planned rendering modes.** See [docs/architecture.md](docs/architecture.md) for the self-contained (no external Terminus) mode this plugin is meant to grow into, and the open questions blocking it.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run against a real Homebridge instance locally with `homebridge -D -U <path-to-a-scratch-config-dir>`.
