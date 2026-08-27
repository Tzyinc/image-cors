# Image cache proxy

A Node.js image proxy that fetches an upstream image at startup and refreshes its in-memory original and filtered-image caches every five minutes. If a later refresh fails, it keeps serving the last successful image.

## Run

Requires Node.js 20 or later.

```sh
npm install
npm start
```

The server listens on `http://localhost:3000` by default. `IMAGE_SOURCE_URL` is required and must point to an upstream image. `PORT` and `REFRESH_INTERVAL_MS` are also configurable.

```sh
IMAGE_SOURCE_URL=https://example.com/radar.jpg npm start
```

An [.env.example](/Users/tenzy/Documents/fun/image-cache-proxy/.env.example) lists the settings. The service reads environment variables supplied by its process manager or shell; it intentionally does not load `.env` files itself.

## Endpoints

`GET /` serves the cached JPEG.

| Request | Result |
| --- | --- |
| `/` | Original cached image |
| `/?w=400` | 400px wide, aspect ratio retained |
| `/?h=300` | 300px tall, aspect ratio retained |
| `/?w=400&h=300` | Stretched to exactly 400 × 300px |
| `/?filter=bnw` | Black-and-white version (cached) |
| `/?filter=gb` | Four-level greyscale version (cached) |
| `/?filter=gbdither` | Four-level Game Boy greyscale with dithering (cached) |
| `/?filter=gbc` | Game Boy Color–inspired 16-colour palette version (cached) |
| `/?palette=flip` | Inverted-colour palette version (cached) |
| `/?filter=gbc&palette=flip` | Inverted Game Boy Color palette version (cached) |
| `/?rotate=90` | Rotate clockwise by 90° |
| `/?rotate=270&w=320` | Rotate clockwise by 270°, then scale |
| `/?w=400&filter=gb` | Cached filter then on-demand scaling |

Both `w` and `h` must be integers from 1 through 8192. With exactly one dimension supplied, the image is kept within that dimension without enlargement. All filtered source variants are regenerated along with the upstream image every five minutes and retained in memory; scaled output is deliberately generated per request.

`rotate` accepts only `0`, `90`, `180`, or `270` (clockwise degrees). It is applied before sizing and is deliberately generated per request, like scaling.

The `gbc` filter maps every pixel to a fixed 16-colour RGB555 palette, giving a colourful Game Boy Color look. The palette is defined as `GBC_PALETTE` in `src/image-store.js`, ready to be replaced or made selectable in a future version.

`gbdither` uses Floyd–Steinberg dithering with the same four grey levels as `gb`, preserving more visual detail in gradients at the cost of a deliberate pixel pattern.

`palette=flip` inverts the colour palette after the selected filter has been applied. Original, filtered, and flipped variants are all regenerated and cached on each five-minute refresh.

`GET /health` returns cache readiness, last refresh time, and generated filtered-cache keys.
