import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import { Categories } from 'homebridge';
import ffmpegPath from 'ffmpeg-for-homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { TerminusClient } from './terminusClient.js';
import { renderRecipe } from './localRenderer.js';
import { RenderCache, type RenderFn } from './renderCache.js';
import { buildStreamingOptions, TrmnlCameraStreamingDelegate } from './camera.js';
import { convertToJpeg } from './imageConvert.js';

interface FieldValuePair {
  key: string;
  value: string;
}

type ChromiumOptions = { chromiumPath: string; chromiumServiceUrl?: undefined } | { chromiumPath?: undefined; chromiumServiceUrl: string };

interface CameraConfig {
  label: string;
  pollIntervalSeconds?: number;
  streamFps?: number;
  screenWidth?: number;
  screenHeight?: number;
  /** Mode A: renders via a self-hosted Terminus instance. Set this or recipeId, not both. */
  terminusExtensionId?: number;
  /** Mode B: renders locally from a TRMNL Recipe archive. Set this or terminusExtensionId, not both. */
  recipeId?: number;
  fieldValues?: FieldValuePair[];
}

interface TrmnlCameraPlatformConfig extends PlatformConfig {
  terminusBaseUrl?: string;
  terminusEmail?: string;
  terminusPassword?: string;
  /** Mode B: path to a chromium/chromium-browser binary supporting --headless=new --screenshot. Ignored if chromiumServiceUrl is set. */
  chromiumPath?: string;
  /** Mode B: base URL of a docker/chromium-service instance instead of a local binary. Takes precedence over chromiumPath. */
  chromiumServiceUrl?: string;
  cameras?: CameraConfig[];
}

const DEFAULT_POLL_INTERVAL_SECONDS = 900;
const DEFAULT_STREAM_FPS = 1;
const DEFAULT_CHROMIUM_PATH = 'chromium-browser';

export class TrmnlCameraPlatform implements DynamicPlatformPlugin {
  private readonly accessories: PlatformAccessory[] = [];

  constructor(
    private readonly log: Logging,
    private readonly config: TrmnlCameraPlatformConfig,
    private readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => {
      this.discoverCameras();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  private discoverCameras(): void {
    if (!ffmpegPath) {
      this.log.error('No bundled ffmpeg binary is available for this platform; cameras cannot stream or snapshot.');
      return;
    }

    const { terminusBaseUrl, terminusEmail, terminusPassword, chromiumPath, chromiumServiceUrl, cameras } = this.config;
    if (!cameras || cameras.length === 0) {
      this.log.warn('No cameras configured.');
      return;
    }

    const terminusClient = this.buildTerminusClientIfNeeded(cameras, terminusBaseUrl, terminusEmail, terminusPassword);
    if (terminusClient === 'missing-config') {
      return;
    }

    const chromium: ChromiumOptions = chromiumServiceUrl
      ? { chromiumServiceUrl }
      : { chromiumPath: chromiumPath ?? DEFAULT_CHROMIUM_PATH };

    const seenUuids = new Set<string>();
    for (const cameraConfig of cameras) {
      const id = this.identifyCamera(cameraConfig);
      if (!id) {
        this.log.error(
          `Camera "${cameraConfig.label}" must set exactly one of terminusExtensionId or recipeId; skipping.`,
        );
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id.mode}:${id.value}`);
      seenUuids.add(uuid);
      this.configureCamera(uuid, cameraConfig, terminusClient, chromium, ffmpegPath);
    }

    const staleAccessories = this.accessories.filter((accessory) => !seenUuids.has(accessory.UUID));
    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }
  }

  /** Only Mode A (terminusExtensionId) cameras need a TerminusClient; Mode B (recipeId) needs no Terminus at all. */
  private buildTerminusClientIfNeeded(
    cameras: CameraConfig[],
    baseUrl?: string,
    email?: string,
    password?: string,
  ): TerminusClient | undefined | 'missing-config' {
    const needsTerminus = cameras.some((camera) => camera.terminusExtensionId !== undefined);
    if (!needsTerminus) {
      return undefined;
    }
    if (!baseUrl || !email || !password) {
      this.log.error(
        'terminusBaseUrl, terminusEmail, and terminusPassword must be configured for cameras using terminusExtensionId.',
      );
      return 'missing-config';
    }
    return new TerminusClient({ baseUrl, email, password, log: this.log });
  }

  private identifyCamera(cameraConfig: CameraConfig): { mode: 'terminus' | 'recipe'; value: number } | undefined {
    const hasTerminus = cameraConfig.terminusExtensionId !== undefined;
    const hasRecipe = cameraConfig.recipeId !== undefined;
    if (hasTerminus === hasRecipe) {
      return undefined; // neither or both set
    }
    return hasTerminus
      ? { mode: 'terminus', value: cameraConfig.terminusExtensionId! }
      : { mode: 'recipe', value: cameraConfig.recipeId! };
  }

  private configureCamera(
    uuid: string,
    cameraConfig: CameraConfig,
    terminusClient: TerminusClient | undefined,
    chromium: ChromiumOptions,
    ffmpegBinaryPath: string,
  ): void {
    const existing = this.accessories.find((accessory) => accessory.UUID === uuid);
    const accessory = existing ?? new this.api.platformAccessory(cameraConfig.label, uuid, Categories.CAMERA);
    accessory.displayName = cameraConfig.label;

    const pollIntervalSeconds = cameraConfig.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const streamFps = cameraConfig.streamFps ?? DEFAULT_STREAM_FPS;

    const renderFn = this.buildRenderFn(cameraConfig, terminusClient, chromium, ffmpegBinaryPath);
    const renderCache = new RenderCache(pollIntervalSeconds * 1000, renderFn);

    const streamingDelegate = new TrmnlCameraStreamingDelegate(
      cameraConfig.label,
      ffmpegBinaryPath,
      streamFps,
      { getCurrentJpeg: async () => (await renderCache.get(cameraConfig.label)).imageBuffer },
      this.log,
    );

    const cameraController = new this.api.hap.CameraController({
      cameraStreamCount: 2,
      delegate: streamingDelegate,
      streamingOptions: buildStreamingOptions(),
    });

    accessory.configureController(cameraController);

    if (!existing) {
      this.accessories.push(accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  private buildRenderFn(
    cameraConfig: CameraConfig,
    terminusClient: TerminusClient | undefined,
    chromium: ChromiumOptions,
    ffmpegBinaryPath: string,
  ): RenderFn {
    if (cameraConfig.recipeId !== undefined) {
      const fieldValues = Object.fromEntries((cameraConfig.fieldValues ?? []).map(({ key, value }) => [key, value]));
      return async () => {
        const { imageBuffer, contentType } = await renderRecipe({
          recipeId: cameraConfig.recipeId!,
          label: cameraConfig.label,
          fieldValues,
          screenWidth: cameraConfig.screenWidth,
          screenHeight: cameraConfig.screenHeight,
          ...chromium,
        });
        const jpeg = contentType.includes('jpeg') ? imageBuffer : await convertToJpeg(ffmpegBinaryPath, imageBuffer);
        return { imageBuffer: jpeg, contentType: 'image/jpeg' };
      };
    }

    return async () => {
      const { imageBuffer, contentType } = await terminusClient!.render(cameraConfig.terminusExtensionId!);
      const jpeg = contentType.includes('jpeg') ? imageBuffer : await convertToJpeg(ffmpegBinaryPath, imageBuffer);
      return { imageBuffer: jpeg, contentType: 'image/jpeg' };
    };
  }
}
