import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Liquid } from 'liquidjs';
import { load as loadYaml } from 'js-yaml';

const RECIPE_ARCHIVE_URL = 'https://usetrmnl.com/api/plugin_settings/%id%/archive';
const FRAMEWORK_CSS_URL = 'https://trmnl.com/css/latest/plugins.css';
const FRAMEWORK_JS_URL = 'https://trmnl.com/js/latest/plugins.js';

const DEFAULT_SCREEN_WIDTH = 800;
const DEFAULT_SCREEN_HEIGHT = 480;
const DEFAULT_CHROMIUM_PATH = 'chromium-browser';
/** Time to let plugins.js's data-value-fit autosizing settle before the screenshot is taken. */
const RENDER_SETTLE_MS = 4000;

const liquid = new Liquid();

/**
 * TRMNL's own Ruby Liquid environment registers extra filters beyond stock
 * Liquid (confirmed via usetrmnl/trmnlp's TRMNL::Liquid environment, which
 * takes a list of registered filters). `sample` (pick one random array
 * element, e.g. `{{ lines | sample }}`) is confirmed needed by the "Blunt
 * Weather" Recipe; add more here as real Recipes surface them.
 */
liquid.registerFilter('sample', (arr: unknown) => (Array.isArray(arr) && arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : arr));

export interface CustomField {
  keyname: string;
  name?: string;
  fieldType: string;
  description?: string;
  options?: string[];
  default?: string;
  optional?: boolean;
}

export interface RecipeSettings {
  id: number;
  name: string;
  strategy: 'polling' | 'static';
  pollUrl?: string;
  pollVerb: string;
  pollHeaders?: Record<string, string>;
  pollBody?: Record<string, unknown>;
  staticData?: Record<string, unknown>;
  customFields: CustomField[];
  refreshIntervalMinutes: number;
}

export interface LocalRenderOptions {
  /** TRMNL Recipe ID, e.g. from https://trmnl.com/recipes.json. */
  recipeId: number;
  /** Camera label, exposed to the template as trmnl.plugin_settings.instance_name. */
  label: string;
  /** Values for the recipe's custom_fields, keyed by keyname. Missing keys fall back to the field's own default. */
  fieldValues?: Record<string, string>;
  /** Stable ID exposed as trmnl.device.friendly_id. Defaults to a slug of `label` -- we have no real device, so any stable string is fine. */
  friendlyId?: string;
  /** Exposed as trmnl.user.utc_offset (seconds east of UTC). Defaults to 0 (UTC). */
  utcOffsetSeconds?: number;
  screenWidth?: number;
  screenHeight?: number;
  /** Path to a chromium/chromium-browser binary supporting --headless=new --screenshot. */
  chromiumPath?: string;
}

/**
 * Renders a TRMNL Recipe locally: downloads its archive, fetches its data source,
 * renders its Liquid markup, and screenshots it via an ephemeral headless Chromium
 * process (spawned per render, not persistent). See docs/architecture.md ("Mode B")
 * for how each step's shape was confirmed against Terminus's own import code.
 */
export async function renderRecipe(options: LocalRenderOptions): Promise<{ imageBuffer: Buffer; contentType: string }> {
  const { settingsYaml, fullLiquid, sharedLiquid } = await fetchRecipeArchive(options.recipeId);
  const settings = parseSettings(settingsYaml);
  const fieldValues = mergeFieldDefaults(settings.customFields, options.fieldValues ?? {});
  const trmnlContext = buildTrmnlContext(options.label, fieldValues, {
    friendlyId: options.friendlyId,
    utcOffsetSeconds: options.utcOffsetSeconds,
  });
  const polledData = await fetchPolledData(settings, fieldValues, trmnlContext);
  const context = buildLiquidContext(polledData, trmnlContext);
  const contentHtml = await renderMarkup(fullLiquid, sharedLiquid, context);

  const width = options.screenWidth ?? DEFAULT_SCREEN_WIDTH;
  const height = options.screenHeight ?? DEFAULT_SCREEN_HEIGHT;
  const pageHtml = buildPage(contentHtml);
  const imageBuffer = await screenshotHtml(pageHtml, width, height, options.chromiumPath ?? DEFAULT_CHROMIUM_PATH);

  return { imageBuffer, contentType: 'image/png' };
}

async function fetchRecipeArchive(
  recipeId: number,
): Promise<{ settingsYaml: string; fullLiquid: string; sharedLiquid: string | undefined }> {
  const url = RECIPE_ARCHIVE_URL.replace('%id%', String(recipeId));
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download Recipe ${recipeId} archive: HTTP ${res.status}`);
  }

  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const entries = new Map(zip.getEntries().map((entry) => [entry.entryName, entry]));
  const settingsEntry = entries.get('settings.yml');
  const fullEntry = entries.get('full.liquid');
  if (!settingsEntry || !fullEntry) {
    throw new Error(`Recipe ${recipeId} archive is missing settings.yml or full.liquid.`);
  }

  return {
    settingsYaml: settingsEntry.getData().toString('utf8'),
    fullLiquid: fullEntry.getData().toString('utf8'),
    sharedLiquid: entries.get('shared.liquid')?.getData().toString('utf8'),
  };
}

export function parseSettings(settingsYaml: string): RecipeSettings {
  const raw = loadYaml(settingsYaml) as Record<string, unknown>;

  return {
    id: Number(raw.id),
    name: String(raw.name ?? ''),
    strategy: raw.strategy === 'static' ? 'static' : 'polling',
    pollUrl: nonEmptyString(raw.polling_url),
    pollVerb: (nonEmptyString(raw.polling_verb) ?? 'get').toUpperCase(),
    pollHeaders: parseQueryHash(raw.polling_headers),
    pollBody: parseJsonHash(raw.polling_body),
    staticData: parseJsonHash(raw.static_data),
    customFields: parseCustomFields(raw.custom_fields),
    refreshIntervalMinutes: Number(raw.refresh_interval ?? 15),
  };
}

function parseCustomFields(raw: unknown): CustomField[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((field): field is Record<string, unknown> => !!field && field.field_type !== 'author_bio')
    .map((field) => ({
      keyname: String(field.keyname),
      name: field.name ? String(field.name) : undefined,
      fieldType: String(field.field_type ?? 'string'),
      description: field.description ? String(field.description) : undefined,
      options: Array.isArray(field.options) ? field.options.map(String) : undefined,
      default: field.default !== undefined && field.default !== null ? String(field.default) : undefined,
      optional: Boolean(field.optional),
    }));
}

function mergeFieldDefaults(fields: CustomField[], provided: Record<string, string>): Record<string, string> {
  const result = { ...provided };
  for (const field of fields) {
    if (result[field.keyname] === undefined && field.default !== undefined) {
      result[field.keyname] = field.default;
    }
  }
  return result;
}

interface DeviceContextOptions {
  friendlyId?: string;
  utcOffsetSeconds?: number;
}

/**
 * Builds the trmnl.* namespace shared by both the poll-templating step and
 * markup rendering. device.percent_charged and (implicitly) signal strength
 * follow usetrmnl/trmnl-display's own convention for non-e-ink Linux clients:
 * it hardcodes battery-voltage 100.00 and rssi 0 rather than reading real
 * hardware, since there's no battery to read. friendly_id/utc_offset have no
 * real device either, so default to a stable slug of the label and UTC.
 */
function buildTrmnlContext(
  label: string,
  fieldValues: Record<string, string>,
  device: DeviceContextOptions,
): Record<string, unknown> {
  return {
    trmnl: {
      plugin_settings: {
        instance_name: label,
        custom_fields_values: fieldValues,
      },
      device: {
        friendly_id: device.friendlyId ?? slugify(label),
        percent_charged: 100,
      },
      system: {
        timestamp_utc: Math.floor(Date.now() / 1000),
      },
      user: {
        utc_offset: device.utcOffsetSeconds ?? 0,
      },
    },
  };
}

function slugify(label: string): string {
  const slug = label.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return slug.length > 0 ? slug.slice(0, 12) : 'HBTC';
}

async function fetchPolledData(
  settings: RecipeSettings,
  fieldValues: Record<string, string>,
  trmnlContext: Record<string, unknown>,
): Promise<unknown> {
  if (settings.strategy === 'static') {
    return settings.staticData ?? {};
  }
  if (!settings.pollUrl) {
    throw new Error(`Recipe ${settings.id} (${settings.name}) has no polling_url configured.`);
  }

  // Recipe authors reference custom field values both ways in the wild --
  // bare `{{ latitude }}` (Shakespeare Quotes, Paperboy) and fully-qualified
  // `{{ trmnl.plugin_settings.custom_fields_values.latitude }}` (Blunt
  // Weather) -- so both need to resolve here, not just in markup.
  const pollContext = { ...fieldValues, ...trmnlContext };

  const url = await renderLiquidString(settings.pollUrl, pollContext);
  const headers: Record<string, string> = {};
  if (settings.pollHeaders) {
    for (const [key, value] of Object.entries(settings.pollHeaders)) {
      headers[key] = await renderLiquidString(value, pollContext);
    }
  }

  const isBodylessVerb = settings.pollVerb === 'GET' || settings.pollVerb === 'HEAD';
  const body = !isBodylessVerb && settings.pollBody
    ? JSON.stringify(await renderLiquidDeep(settings.pollBody, pollContext))
    : undefined;
  if (body !== undefined) {
    headers['content-type'] ??= 'application/json';
  }

  const res = await fetch(url, { method: settings.pollVerb, headers, body });
  if (!res.ok) {
    throw new Error(`Recipe ${settings.id} data source returned HTTP ${res.status} for ${url}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  return contentType.includes('json') ? res.json() : { raw: await res.text() };
}

function buildLiquidContext(polledData: unknown, trmnlContext: Record<string, unknown>): Record<string, unknown> {
  const base = polledData && typeof polledData === 'object' && !Array.isArray(polledData)
    ? (polledData as Record<string, unknown>)
    : { data: polledData };

  return { ...base, ...trmnlContext };
}

/**
 * shared.liquid and full.liquid must render as ONE Liquid pass, not two: shared.liquid
 * is typically just `{% assign %}` statements (or a `{% template %}` definition, for
 * Recipes using TRMNL's custom tags) that full.liquid depends on being in the same
 * variable scope. Matches Terminus's own extractor.rb, which joins the raw source
 * before rendering rather than rendering each file separately.
 */
export async function renderMarkup(fullLiquid: string, sharedLiquid: string | undefined, context: Record<string, unknown>): Promise<string> {
  const source = [sharedLiquid, fullLiquid].filter((part): part is string => !!part).join('\n\n');
  return liquid.parseAndRender(source, context);
}

/**
 * Matches usetrmnl/trmnlp's own render_html.erb (TRMNL's official local
 * preview tool) as closely as possible: bare .screen class with no
 * width/height/overflow override (plugins.css sizes it intrinsically), the
 * Inter font it expects, and the script loaded in <head> un-deferred, same as
 * both trmnlp and Terminus do it. See docs/architecture.md's "localRenderer.ts
 * status" note for why the earlier version (explicit .screen sizing +
 * overflow:hidden on .screen) silently pushed .title_bar out of frame.
 */
function buildPage(contentHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<link rel="stylesheet" href="${FRAMEWORK_CSS_URL}">
<script src="${FRAMEWORK_JS_URL}"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap" rel="stylesheet">
</head>
<body class="environment trmnl">
<div class="screen">
<div class="view view--full">
${contentHtml}
</div>
</div>
</body>
</html>
`;
}

async function screenshotHtml(html: string, width: number, height: number, chromiumPath: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'trmnl-render-'));
  try {
    const htmlPath = path.join(dir, 'page.html');
    const pngPath = path.join(dir, 'shot.png');
    await writeFile(htmlPath, html, 'utf8');
    await runChromiumScreenshot(chromiumPath, htmlPath, pngPath, width, height);
    return await readFile(pngPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runChromiumScreenshot(
  chromiumPath: string,
  htmlPath: string,
  pngPath: string,
  width: number,
  height: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(chromiumPath, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      `--virtual-time-budget=${RENDER_SETTLE_MS}`,
      `--screenshot=${pngPath}`,
      `--window-size=${width},${height}`,
      `file://${htmlPath}`,
    ]);

    const stderr: Buffer[] = [];
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`chromium screenshot exited with code ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
      }
    });
  });
}

async function renderLiquidString(template: string, context: Record<string, unknown>): Promise<string> {
  return liquid.parseAndRender(template, context);
}

async function renderLiquidDeep(value: unknown, context: Record<string, unknown>): Promise<unknown> {
  if (typeof value === 'string') {
    return renderLiquidString(value, context);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => renderLiquidDeep(item, context)));
  }
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, val]) => [key, await renderLiquidDeep(val, context)] as const),
    );
    return Object.fromEntries(entries);
  }
  return value;
}

function nonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseQueryHash(raw: unknown): Record<string, string> | undefined {
  const str = nonEmptyString(raw);
  if (!str) {
    return undefined;
  }
  const result = Object.fromEntries(new URLSearchParams(str));
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseJsonHash(raw: unknown): Record<string, unknown> | undefined {
  const str = nonEmptyString(raw);
  if (!str) {
    return undefined;
  }
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
