import { describe, expect, it } from 'vitest';
import { createTrmnlLiquidEngine } from '../src/trmnlLiquid.js';

async function render(source: string, context: Record<string, unknown> = {}): Promise<string> {
  return createTrmnlLiquidEngine().parseAndRender(source, context);
}

describe('trmnl-liquid filters (ported from usetrmnl/trmnl-liquid)', () => {
  it('append_random appends a random hex suffix', async () => {
    const html = await render('{{ "chart-" | append_random }}');
    expect(html).toMatch(/^chart-[0-9a-f]{4}$/);
  });

  it('group_by groups an array by key', async () => {
    const html = await render(
      '{% assign g = items | group_by: "kind" %}{{ g.fruit | size }},{{ g.veg | size }}',
      { items: [{ kind: 'fruit', name: 'apple' }, { kind: 'veg', name: 'carrot' }, { kind: 'fruit', name: 'pear' }] },
    );
    expect(html).toBe('2,1');
  });

  it('find_by finds the first matching item, else falls back', async () => {
    const found = await render(
      '{% assign match = items | find_by: "id", 2 %}{{ match.id }}',
      { items: [{ id: 1 }, { id: 2 }] },
    );
    expect(found).toBe('2');

    const fallback = await render(
      '{% assign match = items | find_by: "id", 99, "none" %}{{ match }}',
      { items: [{ id: 1 }] },
    );
    expect(fallback).toBe('none');
  });

  it('number_with_delimiter formats thousands', async () => {
    expect(await render('{{ 1234567 | number_with_delimiter }}')).toBe('1,234,567');
    expect(await render('{{ 1234.5 | number_with_delimiter }}')).toBe('1,234.5');
  });

  it('number_to_currency formats currency', async () => {
    expect(await render('{{ 10420 | number_to_currency: "£" }}')).toBe('£10,420.00');
  });

  it('pluralize prepends the count', async () => {
    expect(await render('{{ "book" | pluralize: 2 }}')).toBe('2 books');
    expect(await render('{{ "book" | pluralize: 1 }}')).toBe('1 book');
  });

  it('json / parse_json round-trip', async () => {
    expect(await render('{{ data | json }}', { data: { a: 1 } })).toBe('{"a":1}');
    expect(await render('{% assign obj = text | parse_json %}{{ obj.a }}', { text: '{"a":42}' })).toBe('42');
  });

  it('sample picks the only element from a single-item array', async () => {
    expect(await render('{{ items | sample }}', { items: ['only'] })).toBe('only');
  });

  it('map_to_i converts strings to integers', async () => {
    expect(await render('{{ "5, 4, 3" | split: ", " | map_to_i | join: "," }}')).toBe('5,4,3');
  });

  it('where_exp filters a collection by a simple comparison', async () => {
    const html = await render(
      '{% assign active = items | where_exp: "item", "item.active == true" %}{{ active | size }}',
      { items: [{ active: true }, { active: false }, { active: true }] },
    );
    expect(html).toBe('2');
  });

  it('ordinalize inserts the ordinal day into a format string', async () => {
    expect(await render('{{ "2025-01-02" | ordinalize: "<<ordinal_day>> of the month" }}')).toBe('2nd of the month');
  });

  it('qr_code renders an SVG', async () => {
    const html = await render('{{ "https://example.com" | qr_code }}');
    expect(html).toContain('<svg');
  });
});

describe('trmnl-liquid {% template %}/{% render %} tags (ported from TemplateTag/MemorySystem)', () => {
  it('renders a named template block defined earlier in the same source', async () => {
    const source = `
      {% template main %}<span>{{ name }}</span>{% endtemplate %}
      {% render "main", name: "Paperboy" %}
    `;
    const html = await render(source);
    expect(html).toContain('<span>Paperboy</span>');
  });

  it('does not leak captured templates across separate render calls', async () => {
    const engine = createTrmnlLiquidEngine();
    await engine.parseAndRender('{% template main %}first{% endtemplate %}');

    // A fresh engine (as used per-render in localRenderer.ts) must not see the
    // previous engine's captured "main" template.
    const other = createTrmnlLiquidEngine();
    await expect(other.parseAndRender('{% render "main" %}')).rejects.toThrow();
  });
});
