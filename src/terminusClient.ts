export interface TerminusClientOptions {
  baseUrl: string;
  email: string;
  password: string;
  /** Max time to wait for a triggered build to finish rendering. */
  buildTimeoutMs?: number;
  /** Interval between polls while waiting for a build to finish. */
  pollIntervalMs?: number;
  log?: {
    debug: (message: string) => void;
    warn: (message: string) => void;
  };
}

export interface RenderResult {
  imageBuffer: Buffer;
  contentType: string;
  imageUrl: string;
}

const CSRF_FIELD_RE = /name="_csrf_token"\s+value="([^"]+)"/;
const UPLOAD_IMG_RE = /<img[^>]+src="([^"]*\/uploads\/[^"]+)"/;

/**
 * Client for Terminus (usetrmnl/terminus), the self-hosted TRMNL render server.
 * Terminus has no documented token-based API — this drives its session-cookie web
 * login and scrapes the extension page for the rendered screen image, same as a
 * browser would. Field names (_csrf_token, login form) were confirmed against a
 * live instance during development; re-verify against the deployed Pi instance
 * if Terminus's UI changes.
 */
export class TerminusClient {
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly buildTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly log: NonNullable<TerminusClientOptions['log']>;

  private sessionCookie: string | undefined;
  private readonly lastKnownImageUrl = new Map<number, string>();

  constructor(options: TerminusClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.email = options.email;
    this.password = options.password;
    this.buildTimeoutMs = options.buildTimeoutMs ?? 20_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_500;
    this.log = options.log ?? { debug: () => {}, warn: () => {} };
  }

  /** Triggers a render for the given extension and returns the resulting image. */
  async render(extensionId: number): Promise<RenderResult> {
    await this.ensureSession();

    const csrfToken = await this.fetchCsrfToken(`/extensions/${extensionId}`);
    const buildRes = await this.request(`/extensions/${extensionId}/build`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/vnd.turbo-stream.html, text/html',
      },
      body: new URLSearchParams({ _csrf_token: csrfToken }).toString(),
    });
    if (!buildRes.ok) {
      throw new Error(`Terminus build trigger failed for extension ${extensionId}: HTTP ${buildRes.status}`);
    }

    const imageUrl = await this.waitForRenderedImage(extensionId);
    const imageRes = await this.request(imageUrl);
    if (!imageRes.ok) {
      throw new Error(`Failed to fetch rendered image at ${imageUrl}: HTTP ${imageRes.status}`);
    }

    this.lastKnownImageUrl.set(extensionId, imageUrl);
    return {
      imageBuffer: Buffer.from(await imageRes.arrayBuffer()),
      contentType: imageRes.headers.get('content-type') ?? 'image/png',
      imageUrl,
    };
  }

  private async waitForRenderedImage(extensionId: number): Promise<string> {
    const previousUrl = this.lastKnownImageUrl.get(extensionId);
    const deadline = Date.now() + this.buildTimeoutMs;
    let lastSeenUrl: string | undefined;

    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      const html = await this.fetchText(`/extensions/${extensionId}`);
      const foundUrl = html.match(UPLOAD_IMG_RE)?.[1];
      if (!foundUrl) {
        continue;
      }
      lastSeenUrl = foundUrl;
      if (lastSeenUrl !== previousUrl) {
        return lastSeenUrl;
      }
    }

    if (lastSeenUrl) {
      this.log.warn(
        `Terminus extension ${extensionId}: build did not produce a new image within ${this.buildTimeoutMs}ms; using latest known render.`,
      );
      return lastSeenUrl;
    }

    throw new Error(`Terminus extension ${extensionId}: no rendered image found after triggering a build.`);
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionCookie) {
      return;
    }
    await this.login();
  }

  private async login(): Promise<void> {
    const loginHtml = await this.fetchText('/login');
    const csrfToken = extractCsrfToken(loginHtml);

    const res = await this.request('/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _csrf_token: csrfToken,
        'user[email]': this.email,
        'user[password]': this.password,
      }).toString(),
    });

    const cookie = res.headers.get('set-cookie');
    if (!cookie || (res.status !== 302 && res.status !== 200)) {
      throw new Error(`Terminus login failed: HTTP ${res.status}`);
    }
    this.sessionCookie = cookie.split(';')[0] ?? cookie;
    this.log.debug('Terminus session established.');
  }

  private async fetchCsrfToken(path: string): Promise<string> {
    return extractCsrfToken(await this.fetchText(path));
  }

  private async fetchText(path: string): Promise<string> {
    const res = await this.request(path);
    if (!res.ok) {
      throw new Error(`Terminus request to ${path} failed: HTTP ${res.status}`);
    }
    return res.text();
  }

  private async request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers = new Headers(init.headers);
    if (this.sessionCookie) {
      headers.set('cookie', this.sessionCookie);
    }
    return fetch(url, { ...init, headers });
  }
}

function extractCsrfToken(html: string): string {
  const token = html.match(CSRF_FIELD_RE)?.[1];
  if (!token) {
    throw new Error('Could not find CSRF token in Terminus response.');
  }
  return token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
