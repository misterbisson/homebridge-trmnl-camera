import { randomBytes } from 'node:crypto';
import { Liquid, Tag } from 'liquidjs';
import type { FS, TagToken, TopLevelToken } from 'liquidjs';
import { marked } from 'marked';
import QRCode from 'qrcode';

/**
 * Ports usetrmnl/trmnl-liquid (TRMNL's real Ruby Liquid gem) onto liquidjs, so
 * Recipes written against TRMNL's actual dialect -- not just stock Liquid --
 * render correctly. Filter list and the `{% template %}`/`{% render %}`
 * mechanism are ported directly from that gem's source (lib/trmnl/liquid/
 * filters.rb and template_tag.rb), not guessed. See docs/architecture.md.
 *
 * Returns a fresh engine per call rather than one shared instance: the
 * `{% template %}` tag captures partial bodies into an in-memory map scoped
 * to this engine, and concurrent renders (different cameras can render at the
 * same time) must not share that map -- Recipe authors commonly reuse generic
 * partial names like "main", so cross-render leakage would be a real bug, not
 * just a theoretical one.
 */
export function createTrmnlLiquidEngine(): Liquid {
  const templates = new Map<string, string>();
  const fs: FS = {
    readFileSync: (file) => {
      const body = templates.get(file);
      if (body === undefined) {
        throw new Error(`Liquid template "${file}" not found -- no {% template ${file} %} block defined before this {% render %}.`);
      }
      return body;
    },
    readFile: async (file) => fs.readFileSync(file),
    existsSync: (file) => templates.has(file),
    exists: async (file) => templates.has(file),
    resolve: (_dir, file) => file,
    dirname: () => '.',
  };

  const engine = new Liquid({ fs, root: ['.'], relativeReference: false });
  engine.registerTag('template', createTemplateTag(templates));
  registerTrmnlFilters(engine);
  return engine;
}

/**
 * `{% template name %}...{% endtemplate %}` captures its raw, unparsed body
 * (not its rendered output) into `templates`, keyed by name, and itself
 * renders to nothing. `{% render "name" %}` -- liquidjs's stock tag -- then
 * resolves against `templates` via the engine's `fs`. Ported from
 * TRMNL::Liquid::TemplateTag + TRMNL::Liquid::MemorySystem.
 */
function createTemplateTag(templates: Map<string, string>) {
  return class TemplateTag extends Tag {
    private readonly capturedName: string;
    private readonly rawTokens: TopLevelToken[] = [];

    constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
      super(tagToken, remainTokens, liquid);
      this.capturedName = tagToken.args.trim();

      while (remainTokens.length) {
        const token = remainTokens.shift()!;
        if ('name' in token && (token as TagToken).name === 'endtemplate') {
          return;
        }
        this.rawTokens.push(token);
      }
      throw new Error(`{% template ${this.capturedName} %} is not closed with {% endtemplate %}`);
    }

    render(): string {
      templates.set(this.capturedName, this.rawTokens.map((token) => token.getText()).join(''));
      return '';
    }
  };
}

function registerTrmnlFilters(engine: Liquid): void {
  engine.registerFilter('append_random', (value: unknown) => `${value}${randomBytes(2).toString('hex')}`);

  engine.registerFilter('days_ago', (value: unknown, timezone = 'UTC') => {
    const days = Number(value) || 0;
    const target = new Date(Date.now() - days * 86_400_000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(target);
  });

  engine.registerFilter('group_by', (collection: unknown, key: string) => {
    if (!Array.isArray(collection)) {
      return {};
    }
    const groups: Record<string, unknown[]> = {};
    for (const item of collection) {
      const groupKey = String((item as Record<string, unknown>)?.[key] ?? '');
      (groups[groupKey] ??= []).push(item);
    }
    return groups;
  });

  engine.registerFilter('find_by', (collection: unknown, key: string, value: unknown, fallback: unknown = null) => {
    if (!Array.isArray(collection)) {
      return fallback;
    }
    return collection.find((item) => (item as Record<string, unknown>)?.[key] === value) ?? fallback;
  });

  engine.registerFilter('markdown_to_html', async (markdown: unknown) => marked.parse(String(markdown ?? '')));

  engine.registerFilter('number_with_delimiter', (value: unknown, delimiter = ',', separator = '.') => {
    const [whole, fraction] = String(value).split('.') as [string, string | undefined];
    const withDelimiter = whole.replace(/\B(?=(\d{3})+(?!\d))/g, delimiter);
    return fraction !== undefined ? `${withDelimiter}${separator}${fraction}` : withDelimiter;
  });

  engine.registerFilter('number_to_currency', (value: unknown, unit = '$', delimiter = ',', separator = '.', precision = 2) => {
    const num = Number(value);
    if (Number.isNaN(num)) {
      return String(value);
    }
    const [whole, fraction = ''] = num.toFixed(precision).split('.') as [string, string | undefined];
    const withDelimiter = whole.replace(/\B(?=(\d{3})+(?!\d))/g, delimiter);
    return fraction ? `${unit}${withDelimiter}${separator}${fraction}` : `${unit}${withDelimiter}`;
  });

  engine.registerFilter('l_date', (value: unknown, format?: string, _locale = 'en') => formatDate(value, format));
  engine.registerFilter('map_to_i', (collection: unknown) => (Array.isArray(collection) ? collection.map((v) => parseInt(String(v), 10) || 0) : collection));

  engine.registerFilter('pluralize', (singular: unknown, count: unknown, options: { plural?: string } = {}) => {
    const n = Number(count) || 0;
    const plural = options?.plural ?? `${singular}s`;
    return `${n} ${n === 1 ? singular : plural}`;
  });

  engine.registerFilter('json', (value: unknown) => JSON.stringify(value));
  engine.registerFilter('parse_json', (value: unknown) => {
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  });

  engine.registerFilter('sample', (arr: unknown) => (Array.isArray(arr) && arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : arr));
  engine.registerFilter('where_exp', (collection: unknown, variable: string, expression: string) => whereExp(collection, variable, expression));

  engine.registerFilter('ordinalize', (value: unknown, strftimeFormat: string) => {
    const date = toDate(value);
    if (!date) {
      return String(value);
    }
    const ordinalDay = ordinalSuffix(date.getUTCDate());
    return formatDate(date, strftimeFormat.replace('<<ordinal_day>>', ordinalDay));
  });

  engine.registerFilter('qr_code', async (data: unknown, _size = 11, level = '', _view = 'responsive') => {
    const errorCorrectionLevel = (['l', 'm', 'q', 'h'].includes(String(level).toLowerCase())
      ? String(level).toLowerCase()
      : 'h') as QRCode.QRCodeErrorCorrectionLevel;
    return QRCode.toString(String(data), { type: 'svg', errorCorrectionLevel });
  });
}

function ordinalSuffix(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) {
    return `${day}th`;
  }
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

function toDate(value: unknown): Date | undefined {
  if (value === 'now' || value === 'today') {
    return new Date();
  }
  if (typeof value === 'number') {
    return new Date(value * 1000);
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** Minimal strftime-token formatter covering the tokens TRMNL Recipes actually use (l_date/ordinalize). Not a full strftime implementation. */
function formatDate(value: unknown, format?: string): string {
  const date = toDate(value);
  if (!date) {
    return String(value);
  }
  if (!format) {
    return date.toISOString();
  }
  // UTC throughout, not local time: a bare date-only string like "2025-01-02"
  // parses as UTC midnight, and reading it back with local getters shifts the
  // day in any negative-UTC-offset timezone (most of the Americas).
  const month = MONTHS[date.getUTCMonth()] ?? '';
  const weekday = WEEKDAYS[date.getUTCDay()] ?? '';
  return format
    .replace(/%Y/g, String(date.getUTCFullYear()))
    .replace(/%y/g, String(date.getUTCFullYear()).slice(-2))
    .replace(/%B/g, month)
    .replace(/%b/g, month.slice(0, 3))
    .replace(/%A/g, weekday)
    .replace(/%a/g, weekday.slice(0, 3))
    .replace(/%m/g, pad2(date.getUTCMonth() + 1))
    .replace(/%d/g, pad2(date.getUTCDate()))
    .replace(/%H/g, pad2(date.getUTCHours()))
    .replace(/%M/g, pad2(date.getUTCMinutes()))
    .replace(/%S/g, pad2(date.getUTCSeconds()))
    .replace(/%I/g, pad2(date.getUTCHours() % 12 || 12))
    .replace(/%p/g, date.getUTCHours() >= 12 ? 'PM' : 'AM');
}

const WHERE_EXP_TOKEN_RE = /"[^"]*"|'[^']*'|\S+/g;
const COMPARISON_OPERATORS = new Set(['==', '!=', '>=', '<=', '>', '<', 'contains']);

/**
 * Safe (no eval/new Function) subset of Ruby Liquid's Condition parser, matching
 * TRMNL::Liquid::Filters#where_exp: `left [operator right]` comparisons chained
 * with and/or, left-to-right. Operands are either the loop `variable`'s
 * (dotted) properties, quoted literals, numbers, true/false/nil, or -- unlike
 * the real gem, which can reference any Liquid context variable -- otherwise
 * treated as an opaque string literal. That's a deliberate, documented
 * limitation: resolving arbitrary outer-scope variables here would mean
 * re-implementing Liquid variable lookup from scratch for a filter no tested
 * Recipe has needed yet.
 */
function whereExp(collection: unknown, variable: string, expression: string): unknown[] {
  if (!Array.isArray(collection)) {
    return [];
  }
  const tokens = expression.match(WHERE_EXP_TOKEN_RE) ?? [];
  return collection.filter((item) => evalWhereExpChain(tokens.slice(), variable, item));
}

function evalWhereExpChain(tokens: string[], variable: string, item: unknown): boolean {
  let result = evalWhereExpComparison(tokens, variable, item);
  while (tokens.length > 0 && (tokens[0] === 'and' || tokens[0] === 'or')) {
    const op = tokens.shift();
    const rhs = evalWhereExpComparison(tokens, variable, item);
    result = op === 'and' ? (result && rhs) : (result || rhs);
  }
  return result;
}

function evalWhereExpComparison(tokens: string[], variable: string, item: unknown): boolean {
  const left = resolveWhereExpOperand(tokens.shift(), variable, item);
  if (tokens.length > 0 && COMPARISON_OPERATORS.has(tokens[0] ?? '')) {
    const operator = tokens.shift()!;
    const right = resolveWhereExpOperand(tokens.shift(), variable, item);
    switch (operator) {
      case '==': return left == right; // eslint-disable-line eqeqeq -- Liquid values are loosely typed (string vs number)
      case '!=': return left != right; // eslint-disable-line eqeqeq
      case '>': return (left as number) > (right as number);
      case '<': return (left as number) < (right as number);
      case '>=': return (left as number) >= (right as number);
      case '<=': return (left as number) <= (right as number);
      case 'contains':
        if (typeof left === 'string') return left.includes(String(right));
        if (Array.isArray(left)) return left.includes(right);
        return false;
      default: return false;
    }
  }
  return Boolean(left);
}

function resolveWhereExpOperand(token: string | undefined, variable: string, item: unknown): unknown {
  if (token === undefined) {
    return undefined;
  }
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'nil' || token === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);

  if (token === variable) {
    return item;
  }
  if (token.startsWith(`${variable}.`)) {
    return token.slice(variable.length + 1).split('.').reduce<unknown>(
      (value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined),
      item,
    );
  }
  return token;
}
