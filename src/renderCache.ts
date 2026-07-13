export interface CachedRender {
  imageBuffer: Buffer;
  contentType: string;
  renderedAt: number;
}

export type RenderFn = () => Promise<{ imageBuffer: Buffer; contentType: string }>;

interface CacheEntry {
  render: CachedRender | undefined;
  inFlight: Promise<CachedRender> | undefined;
}

/**
 * Per-camera cache with TTL-based staleness and request coalescing: concurrent
 * callers hitting a stale/empty entry share one in-flight render instead of each
 * triggering their own Terminus build.
 */
export class RenderCache {
  private readonly ttlMs: number;
  private readonly renderFn: RenderFn;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(ttlMs: number, renderFn: RenderFn) {
    this.ttlMs = ttlMs;
    this.renderFn = renderFn;
  }

  /** Returns a fresh-enough render for `key`, triggering a render if none is cached or the cache is stale. */
  async get(key: string): Promise<CachedRender> {
    const entry = this.entries.get(key) ?? { render: undefined, inFlight: undefined };
    this.entries.set(key, entry);

    if (entry.render && !this.isStale(entry.render)) {
      return entry.render;
    }

    if (entry.inFlight) {
      return entry.inFlight;
    }

    const inFlight = this.renderFn()
      .then(({ imageBuffer, contentType }) => {
        const render: CachedRender = { imageBuffer, contentType, renderedAt: Date.now() };
        entry.render = render;
        return render;
      })
      .finally(() => {
        entry.inFlight = undefined;
      });

    entry.inFlight = inFlight;
    return inFlight;
  }

  private isStale(render: CachedRender): boolean {
    return Date.now() - render.renderedAt >= this.ttlMs;
  }
}
