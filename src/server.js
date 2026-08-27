import express from 'express';
import sharp from 'sharp';
import { DEFAULT_REFRESH_INTERVAL_MS, ImageStore, VALID_FILTERS, VALID_PALETTES } from './image-store.js';

const PORT = parsePort(process.env.PORT) ?? 3000;
const refreshIntervalMs = parsePositiveInteger(process.env.REFRESH_INTERVAL_MS) ?? DEFAULT_REFRESH_INTERVAL_MS;
const store = new ImageStore({
  sourceUrl: process.env.IMAGE_SOURCE_URL,
  refreshIntervalMs,
});
const app = express();

app.get('/health', (_request, response) => response.json(store.status));

app.get('/', async (request, response, next) => {
  try {
    const options = parseImageOptions(request.query);
    const source = await store.getImage(options.filter, options.palette);

    // Scaling is intentionally not cached: Sharp transforms the small in-memory source cheaply,
    // while avoiding an unbounded cache for arbitrary width/height combinations.
    const image = options.width || options.height
      ? await sharp(source)
          .resize({
            width: options.width,
            height: options.height,
            fit: options.width && options.height ? 'fill' : 'inside',
            withoutEnlargement: true,
          })
          .jpeg()
          .toBuffer()
      : source;

    response.set({
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=60',
      'x-image-filter': options.filter ?? 'none',
      'x-image-palette': options.palette ?? 'normal',
    });
    response.send(image);
  } catch (error) {
    next(error);
  }
});

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
  if (filter !== undefined && (typeof filter !== 'string' || !VALID_FILTERS.has(filter))) {
    throw new InputError(`filter must be one of: ${[...VALID_FILTERS].join(', ')}`);
  }
  if (palette !== undefined && (typeof palette !== 'string' || !VALID_PALETTES.has(palette))) {
    throw new InputError(`palette must be one of: ${[...VALID_PALETTES].join(', ')}`);
  }
  return { width, height, filter, palette };
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

export { app, parseImageOptions };
