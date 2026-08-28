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
| `/?filter=gbdither` | High-contrast black-and-white error-diffusion dither (cached) |
| `/?filter=gbc` | Game Boy Color–inspired 16-colour palette version (cached) |
| `/?filter=epd4` | Four-colour e-paper palette: black, white, red, yellow (cached) |
| `/?filter=epd7` | EPD7 colours plus four grey background levels (cached) |
| `/?filter=epd7outline` | EPD7 palette with black outlines at every colour boundary (cached) |
| `/?filter=bnwline` | Black-on-white outlines at every EPD7 colour boundary (cached) |
| `/?filter=gboutline` | Four GB greys with black EPD7-derived boundaries (cached) |
| `/?palette=flip` | Inverted-colour palette version (cached) |
| `/?filter=gbc&palette=flip` | Inverted Game Boy Color palette version (cached) |
| `/?rotate=90` | Rotate clockwise by 90° |
| `/?rotate=270&w=320` | Rotate clockwise by 270°, then scale |
| `/?filter=gbdither&h=122&nocache=1` | Regenerate this output without using the transform cache |
| `/?w=400&filter=gb` | Cached filter then on-demand scaling |

Both `w` and `h` must be integers from 1 through 8192. With exactly one dimension supplied, the image is kept within that dimension without enlargement. All filtered source variants are regenerated along with the upstream image every five minutes and retained in memory.

Scaled output uses full Lanczos3 resampling with a light sharpening pass, prioritising crisp detail at small dimensions over the fastest possible resize.

The most recently used 100 transformed outputs (scales, rotations, and dither variants) are cached in memory using an LRU policy. This keeps common sizes fast without retaining every possible query combination. The transformed-output cache is cleared on each upstream refresh, so it cannot serve an outdated image.

Use `nocache=1` to bypass the server-side transform cache for a request. Responses include an `X-Image-Transform-Cache` header with `hit`, `miss`, or `bypass`.

`rotate` accepts only `0`, `90`, `180`, or `270` (clockwise degrees). It is applied before sizing and is deliberately generated per request, like scaling.

The `gbc` filter maps every pixel to a fixed 16-colour RGB555 palette, giving a colourful Game Boy Color look. The palette is defined as `GBC_PALETTE` in `src/image-store.js`, ready to be replaced or made selectable in a future version.

`epd4` maps every source pixel to the nearest of black, white, red, and yellow. `epd7` preserves saturated pixels using the EPD7 chromatic inks (red, yellow, orange, green, blue) and maps neutral pixels to four greys (`0`, `85`, `170`, `255`), keeping a readable background behind the coloured map features. Both are served as lossless indexed PNGs. The four greys are a preview/processing extension: physical EPD7 panels natively provide black and white, not grey ink.

`epd7outline` uses the same EPD7 mapping, then draws one-pixel black outlines wherever any orthogonal neighbouring pixel has a different mapped colour. `bnwline` uses the same boundary detection but discards all fills, producing a pure black-on-white contour map. Both are generated after rotation and scaling so their contours remain crisp.

`gboutline` uses the same EPD7 boundary detection as `bnwline`, but retains a four-shade Game Boy greyscale fill (`40`, `128`, `200`, `255`) and uses true black for the outlines. It is also generated after rotation and scaling.

`gb` uses a shadow-lifted four-level greyscale palette (`40`, `128`, `200`, `255`) with fixed tonal bands, so midtones do not collapse into black. `gbdither` applies Floyd-Steinberg error diffusion after scaling. Source intensities at or below `28` are solid white; those at or above `84` are solid black; the range between them is represented by black-and-white dither pixels.

`gb` is a lossless indexed PNG with at most four palette entries (equivalent to 2-bit colour). `gbdither` is a lossless indexed black-and-white PNG with two palette entries. Both remain lossless after rotation, scaling, or palette flipping.

`palette=flip` inverts the colour palette after the selected filter has been applied. Original, filtered, and flipped variants are all regenerated and cached on each five-minute refresh.

`GET /health` returns cache readiness, last refresh time, and generated filtered-cache keys.
