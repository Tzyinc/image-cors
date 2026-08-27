import sharp from 'sharp';

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const VALID_FILTERS = new Set(['bnw', 'gb', 'gbc', 'gbdither']);
const EAGER_FILTERS = new Set(['bnw', 'gb', 'gbc']);
const VALID_PALETTES = new Set(['flip']);
// Avoid pure black for the darkest shade and pure-white-adjacent tones for the
// middle lights. This holds up better on displays that crush shadows or highlights.
const GB_GREYSCALE_LEVELS = [24, 104, 188, 255];

// A compact, Game Boy Color-inspired palette. Each channel is an RGB555 value
// expanded to 8-bit, matching the colour depth of the original CGB hardware.
const GBC_PALETTE = [
  [0, 0, 0], [24, 24, 48], [48, 48, 88], [72, 72, 120],
  [24, 80, 104], [32, 112, 104], [48, 144, 88], [104, 168, 72],
  [176, 184, 80], [224, 168, 72], [216, 112, 64], [184, 64, 64],
  [112, 48, 96], [88, 56, 136], [152, 152, 176], [248, 248, 232],
];

export class ImageStore {
  #sourceUrl;
  #refreshIntervalMs;
  #fetch;
  #original;
  #filtered = new Map();
  #lastUpdatedAt;
  #refreshPromise;
  #onRefresh;

  constructor({
    sourceUrl,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    fetchFn = globalThis.fetch,
    onRefresh,
  } = {}) {
    if (!sourceUrl) throw new Error('IMAGE_SOURCE_URL must be configured');
    this.#sourceUrl = sourceUrl;
    this.#refreshIntervalMs = refreshIntervalMs;
    this.#fetch = fetchFn;
    this.#onRefresh = onRefresh;
  }

  async getImage(filter, palette) {
    if (filter && !VALID_FILTERS.has(filter)) {
      throw new Error(`Unsupported filter: ${filter}`);
    }
    if (palette && !VALID_PALETTES.has(palette)) {
      throw new Error(`Unsupported palette: ${palette}`);
    }

    await this.#refreshIfNeeded();

    if (!filter && !palette) return this.#original;
    const key = cacheKey(filter, palette);
    if (!this.#filtered.has(key)) {
      const base = filter ? await applyFilter(this.#original, filter) : this.#original;
      this.#filtered.set(key, palette === 'flip' ? await flipPalette(base) : base);
    }
    return this.#filtered.get(key);
  }

  get status() {
    return {
      ready: Boolean(this.#original),
      lastUpdatedAt: this.#lastUpdatedAt?.toISOString() ?? null,
      cachedFilters: [...this.#filtered.keys()],
    };
  }

  async refresh() {
    if (this.#refreshPromise) return this.#refreshPromise;

    this.#refreshPromise = (async () => {
      const response = await this.#fetch(this.#sourceUrl, {
        headers: { accept: 'image/*' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Upstream request failed with HTTP ${response.status}`);

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) {
        throw new Error(`Upstream returned unexpected content type: ${contentType || 'unknown'}`);
      }

      const image = Buffer.from(await response.arrayBuffer());
      await sharp(image).metadata(); // Reject malformed image data before replacing a good cache.

      // Build each filter before publishing this refresh, so every cache entry represents
      // the same upstream snapshot and requests never need to warm a newly-cleared cache.
      const filteredEntries = await buildFilteredCache(image);
      this.#original = image;
      this.#filtered = new Map(filteredEntries);
      this.#lastUpdatedAt = new Date();
      this.#onRefresh?.();
    })();

    try {
      await this.#refreshPromise;
    } finally {
      this.#refreshPromise = undefined;
    }
  }

  async #refreshIfNeeded() {
    const stale = !this.#lastUpdatedAt || Date.now() - this.#lastUpdatedAt.getTime() >= this.#refreshIntervalMs;
    if (!stale) return;

    try {
      await this.refresh();
    } catch (error) {
      // A previously cached image remains useful during a transient upstream outage.
      if (!this.#original) throw error;
      console.error('Image refresh failed; serving previous cached image:', error.message);
    }
  }
}

async function buildFilteredCache(image) {
  const unflippedEntries = await Promise.all(
    [...EAGER_FILTERS].map(async (filter) => [cacheKey(filter), await applyFilter(image, filter)]),
  );
  const unflipped = new Map(unflippedEntries);
  const sourceVariants = [[undefined, image], ...[...EAGER_FILTERS].map((filter) => [filter, unflipped.get(cacheKey(filter))])];
  const flippedEntries = await Promise.all(
    sourceVariants.map(async ([filter, source]) => [cacheKey(filter, 'flip'), await flipPalette(source)]),
  );
  return [...unflippedEntries, ...flippedEntries];
}

function cacheKey(filter, palette) {
  return `${filter ?? 'original'}:${palette ?? 'normal'}`;
}

export async function applyFilter(image, filter) {
  const pipeline = sharp(image);
  if (filter === 'bnw') return pipeline.grayscale().threshold(128).jpeg().toBuffer();

  // Four display-friendly grey levels with clearer shadow and highlight separation.
  if (filter === 'gb') {
    return pipeline
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => {
        for (let index = 0; index < data.length; index += info.channels) {
          data[index] = closestGreyscaleLevel(data[index]);
        }
        return sharp(data, { raw: info }).jpeg().toBuffer();
      });
  }

  if (filter === 'gbc') return mapToPalette(image, GBC_PALETTE);
  if (filter === 'gbdither') return ditherGameBoyGreyscale(image);
}

async function ditherGameBoyGreyscale(image) {
  const { data, info } = await sharp(image).grayscale().raw().toBuffer({ resolveWithObject: true });
  const pixels = new Float32Array(info.width * info.height);
  for (let pixel = 0; pixel < pixels.length; pixel += 1) pixels[pixel] = data[pixel * info.channels];

  // Floyd–Steinberg error diffusion into the high-contrast Game Boy grey levels.
  const output = Buffer.alloc(pixels.length);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = y * info.width + x;
      const source = Math.max(0, Math.min(255, pixels[index]));
      const quantized = closestGreyscaleLevel(source);
      const error = source - quantized;
      output[index] = quantized;

      if (x + 1 < info.width) pixels[index + 1] += error * (7 / 16);
      if (y + 1 < info.height) {
        if (x > 0) pixels[index + info.width - 1] += error * (3 / 16);
        pixels[index + info.width] += error * (5 / 16);
        if (x + 1 < info.width) pixels[index + info.width + 1] += error * (1 / 16);
      }
    }
  }

  return sharp(output, { raw: { width: info.width, height: info.height, channels: 1 } }).jpeg().toBuffer();
}

function closestGreyscaleLevel(value) {
  return GB_GREYSCALE_LEVELS.reduce(
    (closest, level) => Math.abs(value - level) < Math.abs(value - closest) ? level : closest,
    GB_GREYSCALE_LEVELS[0],
  );
}

async function mapToPalette(image, palette) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += info.channels) {
    const colour = nearestColour(data[index], data[index + 1], data[index + 2], palette);
    data[index] = colour[0];
    data[index + 1] = colour[1];
    data[index + 2] = colour[2];
  }
  return sharp(data, { raw: info }).jpeg().toBuffer();
}

function flipPalette(image) {
  return sharp(image).negate().jpeg().toBuffer();
}

function nearestColour(red, green, blue, palette) {
  let closest = palette[0];
  let shortestDistance = Infinity;
  for (const colour of palette) {
    const distance = (red - colour[0]) ** 2 + (green - colour[1]) ** 2 + (blue - colour[2]) ** 2;
    if (distance < shortestDistance) {
      closest = colour;
      shortestDistance = distance;
    }
  }
  return closest;
}

export { DEFAULT_REFRESH_INTERVAL_MS, GBC_PALETTE, GB_GREYSCALE_LEVELS, VALID_FILTERS, VALID_PALETTES };
