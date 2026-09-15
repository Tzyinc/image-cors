import { chromium } from 'playwright';
import {
  applyFilter,
  applyPaletteFlip,
  buildFilteredCache,
  DEFAULT_REFRESH_INTERVAL_MS,
  VALID_FILTERS,
  VALID_PALETTES,
} from './image-store.js';

const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 720;
const DEFAULT_WAIT_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ScreenshotStore {
  #url;
  #refreshIntervalMs;
  #viewport;
  #fullPage;
  #waitMs;
  #timeoutMs;
  #original;
  #filtered = new Map();
  #lastUpdatedAt;
  #refreshPromise;
  #onRefresh;

  constructor({
    sourceUrl,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    viewportWidth = DEFAULT_VIEWPORT_WIDTH,
    viewportHeight = DEFAULT_VIEWPORT_HEIGHT,
    fullPage = false,
    waitMs = DEFAULT_WAIT_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onRefresh,
  } = {}) {
    this.#url = sourceUrl;
    this.#refreshIntervalMs = refreshIntervalMs;
    this.#viewport = { width: viewportWidth, height: viewportHeight };
    this.#fullPage = fullPage;
    this.#waitMs = waitMs;
    this.#timeoutMs = timeoutMs;
    this.#onRefresh = onRefresh;
  }

  get configured() {
    return Boolean(this.#url);
  }

  get status() {
    return {
      configured: this.configured,
      ready: Boolean(this.#original),
      lastUpdatedAt: this.#lastUpdatedAt?.toISOString() ?? null,
      cachedFilters: [...this.#filtered.keys()],
      viewport: this.#viewport,
      fullPage: this.#fullPage,
    };
  }

  async getImage(filter, palette) {
    if (!this.#url) throw new Error('SCREENSHOT_URL must be configured when SOURCE_TYPE=screenshot');
    if (filter && !VALID_FILTERS.has(filter)) throw new Error(`Unsupported filter: ${filter}`);
    if (palette && !VALID_PALETTES.has(palette)) throw new Error(`Unsupported palette: ${palette}`);

    await this.#refreshIfNeeded();
    if (!filter && !palette) return this.#original;

    const key = `${filter ?? 'original'}:${palette ?? 'normal'}`;
    if (!this.#filtered.has(key)) {
      // Non-eager filters are generated once per source snapshot and retained
      // until the next screenshot refresh, matching ImageStore behaviour.
      const base = filter ? await applyFilter(this.#original, filter) : this.#original;
      this.#filtered.set(key, palette ? await applyPaletteFlip(base, filter) : base);
    }
    return this.#filtered.get(key);
  }

  async refresh() {
    if (!this.#url) return;
    if (this.#refreshPromise) return this.#refreshPromise;

    this.#refreshPromise = (async () => {
      const pageUrl = new URL(this.#url);
      if (!['http:', 'https:'].includes(pageUrl.protocol)) {
        throw new Error('SCREENSHOT_URL must use http or https');
      }

      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: this.#viewport });
        page.setDefaultNavigationTimeout(this.#timeoutMs);
        await page.goto(pageUrl.toString(), { waitUntil: 'domcontentloaded' });
        if (this.#waitMs > 0) await page.waitForTimeout(this.#waitMs);
        const image = await page.screenshot({ type: 'png', fullPage: this.#fullPage });
        const filteredEntries = await buildFilteredCache(image);
        this.#original = image;
        this.#filtered = new Map(filteredEntries);
        this.#lastUpdatedAt = new Date();
        this.#onRefresh?.();
      } finally {
        await browser.close();
      }
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
      if (!this.#original) throw error;
      console.error('Screenshot refresh failed; serving previous cached screenshot:', error.message);
    }
  }
}

export {
  DEFAULT_TIMEOUT_MS as DEFAULT_SCREENSHOT_TIMEOUT_MS,
  DEFAULT_VIEWPORT_HEIGHT as DEFAULT_SCREENSHOT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH as DEFAULT_SCREENSHOT_VIEWPORT_WIDTH,
  DEFAULT_WAIT_MS as DEFAULT_SCREENSHOT_WAIT_MS,
};
