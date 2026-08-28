import sharp from 'sharp';

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const VALID_FILTERS = new Set(['bnw', 'gb', 'gbc', 'gbdither', 'epd4', 'epd7', 'epd7outline', 'bnwline', 'gboutline']);
const EAGER_FILTERS = new Set(['bnw', 'gb', 'gbc', 'epd4', 'epd7']);
const VALID_PALETTES = new Set(['flip']);
// Avoid pure black for the darkest shade and pure-white-adjacent tones for the
// middle lights. This holds up better on displays that crush shadows or highlights.
const GB_GREYSCALE_LEVELS = [40, 128, 200, 255];
const DITHER_WHITE_POINT = 28;
const DITHER_BLACK_POINT = 84;

// A compact, Game Boy Color-inspired palette. Each channel is an RGB555 value
// expanded to 8-bit, matching the colour depth of the original CGB hardware.
const GBC_PALETTE = [
  [0, 0, 0], [24, 24, 48], [48, 48, 88], [72, 72, 120],
  [24, 80, 104], [32, 112, 104], [48, 144, 88], [104, 168, 72],
  [176, 184, 80], [224, 168, 72], [216, 112, 64], [184, 64, 64],
  [112, 48, 96], [88, 56, 136], [152, 152, 176], [248, 248, 232],
];

// Common reflective e-paper panel palettes.
const EPD4_PALETTE = [
  [0, 0, 0], [255, 255, 255], [220, 40, 35], [245, 205, 35],
];
const EPD7_PALETTE = [
  [0, 0, 0], [255, 255, 255], [210, 45, 40], [245, 205, 35],
  [235, 125, 35], [45, 140, 80], [45, 95, 180],
];
const EPD7_GREYSCALE_LEVELS = [0, 85, 170, 255];
const EPD7_CHROMATIC_PALETTE = EPD7_PALETTE.slice(2);

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
      this.#filtered.set(key, palette === 'flip' ? await flipPalette(base, paletteColourCount(filter)) : base);
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
    sourceVariants.map(async ([filter, source]) => [cacheKey(filter, 'flip'), await flipPalette(source, paletteColourCount(filter))]),
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
          data[index] = quantiseGbLevel(data[index]);
        }
        return sharp(data, { raw: info }).png({ palette: true, colours: 4 }).toBuffer();
      });
  }

  if (filter === 'gbc') return mapToPalette(image, GBC_PALETTE);
  if (filter === 'gbdither') return ditherGameBoyGreyscale(image);
  if (filter === 'epd4') return mapToPalette(image, EPD4_PALETTE, true);
  if (filter === 'epd7') return mapToEpd7(image);
  if (filter === 'epd7outline') return outlineEpd7(image, true);
  if (filter === 'bnwline') return outlineEpd7(image, false);
  if (filter === 'gboutline') return outlineGb(image);
}

async function ditherGameBoyGreyscale(image) {
  // Compress the chosen source-intensity window to a binary target and diffuse
  // its error at the requested output size. The intentionally inverted mapping
  // keeps values <= 28 white and values >= 84 black.
  const { data, info } = await sharp(image).grayscale().raw().toBuffer({ resolveWithObject: true });
  const values = new Float32Array(info.width * info.height);
  for (let index = 0; index < values.length; index += 1) {
    const sourceValue = data[index * info.channels];
    values[index] = Math.max(
      0,
      Math.min(255, ((DITHER_BLACK_POINT - sourceValue) * 255) / (DITHER_BLACK_POINT - DITHER_WHITE_POINT)),
    );
  }

  const output = Buffer.alloc(values.length);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = y * info.width + x;
      const original = values[index];
      const quantised = original >= 128 ? 255 : 0;
      const error = original - quantised;
      output[index] = quantised;

      // Floyd-Steinberg diffusion. Work strictly left-to-right so the result is
      // deterministic and do it after scaling, where every output pixel matters.
      diffuseError(values, info.width, info.height, x + 1, y, error * (7 / 16));
      diffuseError(values, info.width, info.height, x - 1, y + 1, error * (3 / 16));
      diffuseError(values, info.width, info.height, x, y + 1, error * (5 / 16));
      diffuseError(values, info.width, info.height, x + 1, y + 1, error * (1 / 16));
    }
  }

  return sharp(output, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png({ palette: true, colours: 2 })
    .toBuffer();
}

function quantiseGbLevel(value) {
  const tone = liftShadowDetail(value);
  const index = Math.min(GB_GREYSCALE_LEVELS.length - 1, Math.floor(tone / 64));
  return GB_GREYSCALE_LEVELS[index];
}

function diffuseError(values, width, height, x, y, amount) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const index = y * width + x;
  values[index] = Math.max(0, Math.min(255, values[index] + amount));
}

function liftShadowDetail(value) {
  // A gamma below 1 expands the dark half of the image, where radar detail tends
  // to sit, while retaining a distinct white level for the brightest regions.
  return Math.round(255 * ((Math.max(0, Math.min(255, value)) / 255) ** 0.7));
}

async function mapToPalette(image, palette, lossless = false) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += info.channels) {
    const colour = nearestColour(data[index], data[index + 1], data[index + 2], palette);
    data[index] = colour[0];
    data[index + 1] = colour[1];
    data[index + 2] = colour[2];
  }
  const output = sharp(data, { raw: info });
  return lossless ? output.png({ palette: true, colours: palette.length }).toBuffer() : output.jpeg().toBuffer();
}

async function mapToEpd7(image) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  quantiseEpd7Pixels(data, info);
  return sharp(data, { raw: info }).png({ palette: true, colours: 9 }).toBuffer();
}

async function outlineEpd7(image, retainFills) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  quantiseEpd7Pixels(data, info);
  const output = retainFills ? Buffer.from(data) : Buffer.alloc(info.width * info.height, 255);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (isEpd7Boundary(data, info, x, y)) {
        if (retainFills) {
          const index = (y * info.width + x) * info.channels;
          output[index] = 0;
          output[index + 1] = 0;
          output[index + 2] = 0;
        } else {
          output[y * info.width + x] = 0;
        }
      }
    }
  }
  return retainFills
    ? sharp(output, { raw: info }).png({ palette: true, colours: 9 }).toBuffer()
    : sharp(output, { raw: { width: info.width, height: info.height, channels: 1 } }).png({ palette: true, colours: 2 }).toBuffer();
}

async function outlineGb(image) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const epd7Regions = Buffer.from(data);
  quantiseEpd7Pixels(epd7Regions, info);
  const output = Buffer.alloc(info.width * info.height);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const pixel = y * info.width + x;
      const source = pixel * info.channels;
      const luma = 0.2126 * data[source] + 0.7152 * data[source + 1] + 0.0722 * data[source + 2];
      output[pixel] = isEpd7Boundary(epd7Regions, info, x, y) ? 0 : quantiseGbLevel(luma);
    }
  }
  // Four GB greys plus a true-black outline.
  return sharp(output, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png({ palette: true, colours: 5 })
    .toBuffer();
}

function quantiseEpd7Pixels(data, info) {
  for (let index = 0; index < data.length; index += info.channels) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const colour = isSaturated(red, green, blue)
      ? nearestColour(red, green, blue, EPD7_CHROMATIC_PALETTE)
      : nearestGrey(red, green, blue);
    data[index] = colour[0];
    data[index + 1] = colour[1];
    data[index + 2] = colour[2];
  }
}

function isEpd7Boundary(data, info, x, y) {
  const current = (y * info.width + x) * info.channels;
  return (x > 0 && differentPixel(data, current, current - info.channels))
    || (x + 1 < info.width && differentPixel(data, current, current + info.channels))
    || (y > 0 && differentPixel(data, current, current - info.width * info.channels))
    || (y + 1 < info.height && differentPixel(data, current, current + info.width * info.channels));
}

function differentPixel(data, first, second) {
  return data[first] !== data[second]
    || data[first + 1] !== data[second + 1]
    || data[first + 2] !== data[second + 2];
}

function isSaturated(red, green, blue) {
  const brightest = Math.max(red, green, blue);
  const darkest = Math.min(red, green, blue);
  return brightest > 0 && (brightest - darkest) / brightest >= 0.22;
}

function nearestGrey(red, green, blue) {
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const level = EPD7_GREYSCALE_LEVELS.reduce((closest, candidate) => (
    Math.abs(luma - candidate) < Math.abs(luma - closest) ? candidate : closest
  ));
  return [level, level, level];
}

function flipPalette(image, colours) {
  const pipeline = sharp(image).negate();
  if (colours === 2) return pipeline.png().toBuffer();
  return colours ? pipeline.png({ palette: true, colours }).toBuffer() : pipeline.jpeg().toBuffer();
}

function paletteColourCount(filter) {
  if (filter === 'gb') return 4;
  if (filter === 'gbdither') return 2;
  if (filter === 'epd4') return 4;
  if (filter === 'epd7') return 9;
  if (filter === 'epd7outline') return 9;
  if (filter === 'bnwline') return 2;
  if (filter === 'gboutline') return 5;
  return undefined;
}

function nearestColour(red, green, blue, palette) {
  return palette[nearestColourIndex(red, green, blue, palette)];
}

function nearestColourIndex(red, green, blue, palette) {
  let closestIndex = 0;
  let shortestDistance = Infinity;
  for (const [index, colour] of palette.entries()) {
    const distance = (red - colour[0]) ** 2 + (green - colour[1]) ** 2 + (blue - colour[2]) ** 2;
    if (distance < shortestDistance) {
      closestIndex = index;
      shortestDistance = distance;
    }
  }
  return closestIndex;
}

export {
  DEFAULT_REFRESH_INTERVAL_MS,
  DITHER_BLACK_POINT,
  DITHER_WHITE_POINT,
  EPD4_PALETTE,
  EPD7_CHROMATIC_PALETTE,
  EPD7_GREYSCALE_LEVELS,
  EPD7_PALETTE,
  GBC_PALETTE,
  GB_GREYSCALE_LEVELS,
  VALID_FILTERS,
  VALID_PALETTES,
};
