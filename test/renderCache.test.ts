import { describe, expect, it, vi } from 'vitest';
import { RenderCache } from '../src/renderCache.js';

function makeRender(byte: number): { imageBuffer: Buffer; contentType: string } {
  return { imageBuffer: Buffer.from([byte]), contentType: 'image/jpeg' };
}

describe('RenderCache', () => {
  it('renders on first access and reuses the cached value within the TTL', async () => {
    const renderFn = vi.fn().mockResolvedValue(makeRender(1));
    const cache = new RenderCache(10_000, renderFn);

    const first = await cache.get('camera-a');
    const second = await cache.get('camera-a');

    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(first.imageBuffer).toEqual(second.imageBuffer);
  });

  it('re-renders once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    let call = 0;
    const renderFn = vi.fn().mockImplementation(async () => makeRender(++call));
    const cache = new RenderCache(1_000, renderFn);

    const first = await cache.get('camera-a');
    vi.advanceTimersByTime(1_001);
    const second = await cache.get('camera-a');

    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(first.imageBuffer).not.toEqual(second.imageBuffer);
    vi.useRealTimers();
  });

  it('coalesces concurrent requests into a single in-flight render', async () => {
    let resolveRender: (value: { imageBuffer: Buffer; contentType: string }) => void = () => {};
    const renderFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveRender = resolve; }),
    );
    const cache = new RenderCache(10_000, renderFn);

    const first = cache.get('camera-a');
    const second = cache.get('camera-a');
    resolveRender(makeRender(7));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(firstResult.imageBuffer).toEqual(secondResult.imageBuffer);
  });

  it('keeps separate cache entries per key', async () => {
    const renderFn = vi
      .fn()
      .mockResolvedValueOnce(makeRender(1))
      .mockResolvedValueOnce(makeRender(2));
    const cache = new RenderCache(10_000, renderFn);

    const a = await cache.get('camera-a');
    const b = await cache.get('camera-b');

    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(a.imageBuffer).not.toEqual(b.imageBuffer);
  });

  it('does not cache a failed render, so the next call retries', async () => {
    const renderFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('render failed'))
      .mockResolvedValueOnce(makeRender(3));
    const cache = new RenderCache(10_000, renderFn);

    await expect(cache.get('camera-a')).rejects.toThrow('render failed');
    const result = await cache.get('camera-a');

    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(result.imageBuffer).toEqual(Buffer.from([3]));
  });
});
