# chromium-service

Minimal ephemeral headless-Chromium screenshot service for Mode B rendering
(`src/localRenderer.ts`). See `server.js` for the full "why" comment.

**Why this exists**: on hosts where Homebridge itself runs inside a Docker
container whose userspace has no working Chromium (e.g. Ubuntu-based images,
where `chromium-browser`/`firefox` are snap-transitional stubs and `snapd`
doesn't run in containers), point the plugin at this sidecar instead of a
local binary. Alpine ships a real, working, non-snap `chromium` package for
32-bit ARM (the same architecture `ffmpeg-for-homebridge` itself targets), so
this runs as its own small container rather than trying to get Chromium
working inside the Homebridge image.

## Deploying alongside Homebridge

Assumes the Homebridge container runs with `network_mode: host` (as it does
in this project's own `homebridge-pi` setup) — this service does too, so
they share `localhost` without publishing any port beyond the host itself
(`server.js` binds `127.0.0.1` only, not `0.0.0.0`).

```bash
# on the Homebridge host
git clone https://github.com/misterbisson/homebridge-trmnl-camera ~/chromium-service-src
cd ~/chromium-service-src/docker/chromium-service
docker compose up -d --build
curl http://localhost:3000/health   # -> ok
```

Then set `chromiumServiceUrl` to `http://localhost:3000` in the plugin's
config instead of `chromiumPath`.

## API

- `GET /health` → `200 ok`
- `POST /screenshot` — body `{ "html": string, "width": number, "height": number }`,
  response `image/png` bytes. Spawns a fresh Chromium process per request and
  exits (no persistent browser instance), matching the local-binary path's
  design for the same Pi-resource reasons.

## Updating

```bash
cd ~/chromium-service-src && git pull
cd docker/chromium-service && docker compose up -d --build
```
