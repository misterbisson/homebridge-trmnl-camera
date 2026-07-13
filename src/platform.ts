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
import { RenderCache } from './renderCache.js';
import { buildStreamingOptions, TrmnlCameraStreamingDelegate } from './camera.js';
import { convertToJpeg } from './imageConvert.js';

interface CameraConfig {
  label: string;
  terminusExtensionId: number;
  pollIntervalSeconds?: number;
  streamFps?: number;
}

interface TrmnlCameraPlatformConfig extends PlatformConfig {
  terminusBaseUrl?: string;
  terminusEmail?: string;
  terminusPassword?: string;
  cameras?: CameraConfig[];
}

const DEFAULT_POLL_INTERVAL_SECONDS = 900;
const DEFAULT_STREAM_FPS = 1;

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

    const { terminusBaseUrl, terminusEmail, terminusPassword, cameras } = this.config;
    if (!terminusBaseUrl || !terminusEmail || !terminusPassword) {
      this.log.error('terminusBaseUrl, terminusEmail, and terminusPassword must be configured.');
      return;
    }
    if (!cameras || cameras.length === 0) {
      this.log.warn('No cameras configured.');
      return;
    }

    const terminusClient = new TerminusClient({
      baseUrl: terminusBaseUrl,
      email: terminusEmail,
      password: terminusPassword,
      log: this.log,
    });

    const seenUuids = new Set<string>();
    for (const cameraConfig of cameras) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${cameraConfig.terminusExtensionId}`);
      seenUuids.add(uuid);
      this.configureCamera(uuid, cameraConfig, terminusClient, ffmpegPath);
    }

    const staleAccessories = this.accessories.filter((accessory) => !seenUuids.has(accessory.UUID));
    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    }
  }

  private configureCamera(
    uuid: string,
    cameraConfig: CameraConfig,
    terminusClient: TerminusClient,
    ffmpegBinaryPath: string,
  ): void {
    const existing = this.accessories.find((accessory) => accessory.UUID === uuid);
    const accessory = existing ?? new this.api.platformAccessory(cameraConfig.label, uuid, Categories.CAMERA);
    accessory.displayName = cameraConfig.label;

    const pollIntervalSeconds = cameraConfig.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const streamFps = cameraConfig.streamFps ?? DEFAULT_STREAM_FPS;

    const renderCache = new RenderCache(pollIntervalSeconds * 1000, async () => {
      const { imageBuffer, contentType } = await terminusClient.render(cameraConfig.terminusExtensionId);
      const jpeg = contentType.includes('jpeg') ? imageBuffer : await convertToJpeg(ffmpegBinaryPath, imageBuffer);
      return { imageBuffer: jpeg, contentType: 'image/jpeg' };
    });

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
}
