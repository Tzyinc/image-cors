import express from 'express';
import sharp from 'sharp';
import { applyFilter, DEFAULT_REFRESH_INTERVAL_MS, ImageStore, VALID_FILTERS, VALID_PALETTES } from './image-store.js';

class LruCache {
  #capacity;
  #entries = new Map();

  constructor(capacity) {
    this.#capacity = capacity;
  }

  get size() {
    return this.#entries.size;
  }

  get(key) {
    const value = this.#entries.get(key);
    if (!value) return undefined;
    // Reinserting moves this entry to the newest end of the insertion-ordered map.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key, value) {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#capacity) this.#entries.delete(this.#entries.keys().next().value);
  }

  clear() {
    this.#entries.clear();
  }
}

const PORT = parsePort(process.env.PORT) ?? 3000;
const TRANSFORM_CACHE_CAPACITY = 100;
const refreshIntervalMs = parsePositiveInteger(process.env.REFRESH_INTERVAL_MS) ?? DEFAULT_REFRESH_INTERVAL_MS;
const transformedImageCache = new LruCache(TRANSFORM_CACHE_CAPACITY);
const store = new ImageStore({
  sourceUrl: process.env.IMAGE_SOURCE_URL,
  refreshIntervalMs,
  onRefresh: () => transformedImageCache.clear(),
});
const app = express();

app.get('/health', (_request, response) => response.json({
  ...store.status,
  transformedCacheEntries: transformedImageCache.size,
  transformedCacheCapacity: TRANSFORM_CACHE_CAPACITY,
}));

app.get('/', async (request, response, next) => {
  try {
    const options = parseImageOptions(request.query);
    const cacheKey = transformedCacheKey(options);
    let image = transformedImageCache.get(cacheKey);
    if (!image) {
      image = await createOutputImage(options);
      if (shouldCacheOutput(options)) transformedImageCache.set(cacheKey, image);
    }

    response.set({
      'content-type': outputContentType(options),
      'cache-control': 'public, max-age=60',
      'x-image-filter': options.filter ?? 'none',
      'x-image-palette': options.palette ?? 'normal',
      'x-image-rotation': String(options.rotation),
    });
    response.send(image);
  } catch (error) {
    next(error);
  }
});

async function createOutputImage(options) {
  // Dithering is intentionally deferred until after rotation and reduction. Resizing a
  // pre-dithered source averages away its pixel pattern, especially at small dimensions.
  const deferredDither = options.filter === 'gbdither';
  const source = await store.getImage(deferredDither ? undefined : options.filter, deferredDither ? undefined : options.palette);
  const needsTransform = options.width || options.height || options.rotation !== 0;
  let image = source;
  if (needsTransform) {
    const pipeline = sharp(source);
    if (options.rotation !== 0) pipeline.rotate(options.rotation);
    if (options.width || options.height) {
      pipeline.resize({
        width: options.width,
        height: options.height,
        fit: options.width && options.height ? 'fill' : 'inside',
        withoutEnlargement: true,
        // Prefer the full resampling path over decoder shrink-on-load, which can
        // introduce subtle moiré and rounding artefacts at very small sizes.
        kernel: sharp.kernel.lanczos3,
        fastShrinkOnLoad: false,
      });
      // A restrained final pass restores edge definition lost during reduction.
      pipeline.sharpen({ sigma: 0.5, m1: 0, m2: 1.5 });
    }
    image = await encodeOutput(pipeline, options.filter);
  }
  if (deferredDither) {
    image = await applyFilter(image, 'gbdither');
    if (options.palette === 'flip') image = await sharp(image).negate().png({ palette: true, colours: 2 }).toBuffer();
  }
  return image;
}

function encodeOutput(pipeline, filter) {
  const colours = paletteColourCount(filter);
  return colours
    ? pipeline.png({ palette: true, colours }).toBuffer()
    : pipeline.jpeg().toBuffer();
}

function outputContentType(options) {
  return paletteColourCount(options.filter) ? 'image/png' : 'image/jpeg';
}

function paletteColourCount(filter) {
  if (filter === 'gb') return 4;
  if (filter === 'gbdither') return 2;
  return undefined;
}

function shouldCacheOutput(options) {
  return options.filter === 'gbdither' || options.width || options.height || options.rotation !== 0;
}

function transformedCacheKey({ filter, palette, width, height, rotation }) {
  return JSON.stringify({ filter: filter ?? 'none', palette: palette ?? 'normal', width: width ?? null, height: height ?? null, rotation });
}

app.use((error, _request, response, _next) => {
  const isInputError = error instanceof InputError;
  response.status(isInputError ? 400 : 502).json({ error: error.message });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`Image cache proxy listening on http://localhost:${PORT}`));
  const refresh = () => store.refresh().catch((error) => console.error('Image refresh failed:', error.message));
  // Fetch promptly and then keep the memory cache fresh even when there are no requests.
  refresh();
  setInterval(refresh, refreshIntervalMs);
}

function parseImageOptions(query) {
  const width = parseDimension(query.w, 'w');
  const height = parseDimension(query.h, 'h');
  const filter = query.filter;
  const palette = query.palette;
  const rotation = parseRotation(query.rotate);
  if (filter !== undefined && (typeof filter !== 'string' || !VALID_FILTERS.has(filter))) {
    throw new InputError(`filter must be one of: ${[...VALID_FILTERS].join(', ')}`);
  }
  if (palette !== undefined && (typeof palette !== 'string' || !VALID_PALETTES.has(palette))) {
    throw new InputError(`palette must be one of: ${[...VALID_PALETTES].join(', ')}`);
  }
  return { width, height, filter, palette, rotation };
}

function parseRotation(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^(0|90|180|270)$/.test(value)) {
    throw new InputError('rotate must be one of: 0, 90, 180, 270');
  }
  return Number(value);
}

function parseDimension(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new InputError(`${name} must be a positive integer`);
  const dimension = Number(value);
  if (dimension < 1 || dimension > 8192) throw new InputError(`${name} must be between 1 and 8192`);
  return dimension;
}

function parsePositiveInteger(value) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function parsePort(value) {
  const port = parsePositiveInteger(value);
  return port && port <= 65535 ? port : undefined;
}

class InputError extends Error {}

export { app, LruCache, parseImageOptions };
