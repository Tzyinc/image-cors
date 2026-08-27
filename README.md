# Image cache proxy

A Node.js image proxy that fetches an upstream image at startup and refreshes its in-memory original and filtered-image caches every five minutes. If a later refresh fails, it keeps serving the last successful image.

## Run

Requires Node.js 20 or later.

```sh
npm install
npm start
```

`npm start` runs with Node.js watch mode and automatically restarts after source-file changes.

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
| `/?filter=gbdither` | Four-tone Game Boy error-diffusion dither (cached) |
| `/?filter=gbc` | Game Boy Color–inspired 16-colour palette version (cached) |
| `/?palette=flip` | Inverted-colour palette version (cached) |
| `/?filter=gbc&palette=flip` | Inverted Game Boy Color palette version (cached) |
| `/?rotate=90` | Rotate clockwise by 90° |
| `/?rotate=270&w=320` | Rotate clockwise by 270°, then scale |
| `/?filter=gbdither&h=122&nocache=1` | Regenerate this output without using the transform cache |
| `/?w=400&filter=gb` | Cached filter then on-demand scaling |

Both `w` and `h` must be integers from 1 through 8192. With exactly one dimension supplied, the image is kept within that dimension without enlargement. All filtered source variants are regenerated along with the upstream image every five minutes and retained in memory.

Scaled output uses full Lanczos3 resampling with a light sharpening pass, prioritising crisp detail at small dimensions over the fastest possible resize.

The most recently used 100 transformed outputs (scales, rotations, and `gbdither` variants) are cached in memory using an LRU policy. This keeps common sizes fast without retaining every possible query combination. The transformed-output cache is cleared on each upstream refresh, so it cannot serve an outdated image.

Use `nocache=1` to bypass the server-side transform cache for a request. Responses include an `X-Image-Transform-Cache` header with `hit`, `miss`, or `bypass`.

`rotate` accepts only `0`, `90`, `180`, or `270` (clockwise degrees). It is applied before sizing and is deliberately generated per request, like scaling.

The `gbc` filter maps every pixel to a fixed 16-colour RGB555 palette, giving a colourful Game Boy Color look. The palette is defined as `GBC_PALETTE` in `src/image-store.js`, ready to be replaced or made selectable in a future version.

`gb` uses a shadow-lifted four-level greyscale palette (`40`, `128`, `200`, `255`) with fixed tonal bands, so midtones do not collapse into black. `gbdither` applies Floyd-Steinberg error diffusion to those same four levels after scaling, so it adds texture without turning the dark-grey band into dense black dots.

`gb` and `gbdither` are served as lossless indexed PNGs with at most four palette entries (equivalent to 2-bit colour). Both remain lossless after rotation, scaling, or palette flipping.

`palette=flip` inverts the colour palette after the selected filter has been applied. Original, filtered, and flipped variants are all regenerated and cached on each five-minute refresh.

`GET /health` returns cache readiness, last refresh time, and generated filtered-cache keys.
