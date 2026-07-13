import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLiquidContext, parseSettings, renderMarkup, screenshotViaService } from '../src/localRenderer.js';

// A real settings.yml pulled from a live TRMNL Recipe (id 369398, "Shakespeare
// Quotes") via usetrmnl.com/api/plugin_settings/:id/archive -- see
// docs/architecture.md's "Recipe archive format" section for how this shape
// was confirmed against Terminus's own import code.
const REAL_SETTINGS_YAML = `
---
strategy: polling
no_screen_padding: 'no'
dark_mode: 'no'
static_data: ''
polling_verb: get
framework_version: 3.1.1
serverless_language: ''
polling_url: https://trmnl.bloax.xyz/api/shakespeare-quotes
polling_headers: ''
polling_body: ''
id: 369398
oauth_enabled: 'false'
custom_fields:
- keyname: bio
  name: About This Plugin
  field_type: author_bio
  category: life
  description: A random quote from the works of William Shakespeare.
  github_url: https://github.com/SteveBloX/trmnl-recipes
  email_address: contact@bloax.xyz
name: Shakespeare Quotes
refresh_interval: 480
`;

describe('parseSettings', () => {
  it('parses a real polling-strategy Recipe settings.yml', () => {
    const settings = parseSettings(REAL_SETTINGS_YAML);

    expect(settings.id).toBe(369398);
    expect(settings.name).toBe('Shakespeare Quotes');
    expect(settings.strategy).toBe('polling');
    expect(settings.pollUrl).toBe('https://trmnl.bloax.xyz/api/shakespeare-quotes');
    expect(settings.pollVerb).toBe('GET');
    expect(settings.refreshIntervalMinutes).toBe(480);
  });

  it('drops empty-string polling_headers/polling_body/static_data rather than treating them as data', () => {
    const settings = parseSettings(REAL_SETTINGS_YAML);

    expect(settings.pollHeaders).toBeUndefined();
    expect(settings.pollBody).toBeUndefined();
    expect(settings.staticData).toBeUndefined();
  });

  it('filters out author_bio fields, since they are plugin metadata, not configurable settings', () => {
    const settings = parseSettings(REAL_SETTINGS_YAML);

    expect(settings.customFields).toEqual([]);
  });

  it('parses custom fields with defaults and options', () => {
    const settings = parseSettings(`
---
strategy: polling
polling_url: https://example.com/{{ event_id }}
polling_verb: get
polling_headers: 'Authorization=Bearer%20{{ api_token }}'
polling_body: ''
static_data: ''
id: 1
custom_fields:
- keyname: api_token
  field_type: string
  name: API Token
- keyname: event_id
  field_type: string
  name: Event ID
  default: 66
name: Example
refresh_interval: 15
`);

    expect(settings.pollHeaders).toEqual({ Authorization: 'Bearer {{ api_token }}' });
    expect(settings.customFields).toEqual([
      { keyname: 'api_token', name: 'API Token', fieldType: 'string', description: undefined, options: undefined, default: undefined, optional: false },
      { keyname: 'event_id', name: 'Event ID', fieldType: 'string', description: undefined, options: undefined, default: '66', optional: false },
    ]);
  });
});

describe('renderMarkup', () => {
  // Real bug (found via the live "Blunt Weather" Recipe, id 305453): shared.liquid
  // and full.liquid were rendered as two separate Liquid passes, so {% assign %}
  // variables set in shared.liquid never reached full.liquid. Terminus's own
  // extractor.rb joins the raw source before rendering, not the rendered output.
  it('shares assigned variables between shared.liquid and full.liquid', async () => {
    const shared = '{% assign greeting = "hello" %}';
    const full = '<span>{{ greeting }}</span>';

    const html = await renderMarkup(full, shared, {});

    expect(html.trim()).toBe('<span>hello</span>');
  });

  it('renders full.liquid alone when there is no shared.liquid', async () => {
    const html = await renderMarkup('<span>{{ name }}</span>', undefined, { name: 'Shakespeare Quotes' });

    expect(html).toBe('<span>Shakespeare Quotes</span>');
  });

  // TRMNL's own Ruby Liquid environment registers extra filters beyond stock
  // Liquid; `sample` (confirmed needed by "Blunt Weather") isn't one liquidjs
  // ships by default, so localRenderer registers it itself.
  it('supports the sample filter for picking a random array element', async () => {
    const html = await renderMarkup('{{ items | sample }}', undefined, { items: ['only-option'] });

    expect(html).toBe('only-option');
  });
});

describe('buildLiquidContext', () => {
  // Single-source Recipes (Shakespeare Quotes, Blunt Weather) rely on bare
  // top-level field access, e.g. {{ quote }} -- not {{ IDX_0.quote }}.
  it('merges the first source at the top level for single-source Recipes', () => {
    const context = buildLiquidContext([{ quote: 'to be or not to be' }], {});

    expect(context.quote).toBe('to be or not to be');
    expect(context.IDX_0).toEqual({ quote: 'to be or not to be' });
  });

  // Paperboy (id 152705) is multi-source: an RSS feed and an unrelated
  // device-telemetry beacon, referenced in markup as IDX_0/IDX_1.
  it('exposes every poll source as IDX_N for multi-source Recipes', () => {
    const context = buildLiquidContext([{ rss: 'feed-data' }, { ok: true }], {});

    expect(context.IDX_0).toEqual({ rss: 'feed-data' });
    expect(context.IDX_1).toEqual({ ok: true });
    // The primary source's fields are still merged at the top level too.
    expect(context.rss).toBe('feed-data');
  });

  it('merges the trmnl.* context alongside poll sources', () => {
    const context = buildLiquidContext([{ a: 1 }], { trmnl: { plugin_settings: { instance_name: 'Test' } } });

    expect(context.a).toBe(1);
    expect((context.trmnl as { plugin_settings: { instance_name: string } }).plugin_settings.instance_name).toBe('Test');
  });
});

describe('screenshotViaService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts html/width/height and returns the response body as a buffer', async () => {
    const pngBytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => pngBytes.buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await screenshotViaService('http://localhost:3000', '<html></html>', 800, 480);

    expect(result).toEqual(Buffer.from(pngBytes));
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/screenshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<html></html>', width: 800, height: 480 }),
    });
  });

  it('strips trailing slashes from the service URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    vi.stubGlobal('fetch', fetchMock);

    await screenshotViaService('http://localhost:3000/', '<html></html>', 800, 480);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/screenshot', expect.anything());
  });

  it('throws with the response body on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }));

    await expect(screenshotViaService('http://localhost:3000', '<html></html>', 800, 480)).rejects.toThrow('boom');
  });
});
