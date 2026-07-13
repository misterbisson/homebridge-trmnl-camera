import { randomInt } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'homebridge';
import { H264Level, H264Profile, SRTPCryptoSuites, StreamRequestTypes } from 'homebridge';
import type {
  CameraStreamingDelegate,
  CameraStreamingOptions,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';

export interface CameraSnapshotSource {
  /** Returns the current cached JPEG frame for this camera, rendering one if none is cached yet. */
  getCurrentJpeg(): Promise<Buffer>;
}

interface PendingSession {
  targetAddress: string;
  targetVideoPort: number;
  localVideoPort: number;
  ssrc: number;
  cryptoSuite: SRTPCryptoSuites;
  srtp: Buffer;
}

interface OngoingSession {
  process: ChildProcessWithoutNullStreams;
  localVideoPort: number;
  tmpDir: string;
}

const H264_PROFILE_NAMES: Record<H264Profile, string> = {
  [H264Profile.BASELINE]: 'baseline',
  [H264Profile.MAIN]: 'main',
  [H264Profile.HIGH]: 'high',
};

const H264_LEVEL_NAMES: Record<H264Level, string> = {
  [H264Level.LEVEL3_1]: '3.1',
  [H264Level.LEVEL3_2]: '3.2',
  [H264Level.LEVEL4_0]: '4.0',
};

const VIDEO_RESOLUTIONS: [number, number, number][] = [
  [1280, 720, 30],
  [640, 360, 30],
  [320, 180, 30],
];

export function buildStreamingOptions(): CameraStreamingOptions {
  return {
    supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
    video: {
      codec: {
        profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
        levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
      },
      resolutions: VIDEO_RESOLUTIONS,
    },
  };
}

const usedLocalPorts = new Set<number>();

function reserveLocalPort(): number {
  for (let port = 5011; ; port++) {
    if (!usedLocalPorts.has(port)) {
      usedLocalPorts.add(port);
      return port;
    }
  }
}

/**
 * Serves a Terminus-rendered frame as a HomeKit camera: snapshots come straight from
 * the render cache, and live "streaming" loops that same static frame through ffmpeg
 * into a low-fps H.264/SRTP stream rather than decoding/re-rendering per session.
 */
export class TrmnlCameraStreamingDelegate implements CameraStreamingDelegate {
  private readonly pendingSessions = new Map<string, PendingSession>();
  private readonly ongoingSessions = new Map<string, OngoingSession>();

  constructor(
    private readonly label: string,
    private readonly ffmpegBinaryPath: string,
    private readonly streamFps: number,
    private readonly source: CameraSnapshotSource,
    private readonly log: Logger,
  ) {}

  handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.source
      .getCurrentJpeg()
      .then((jpeg) => callback(undefined, jpeg))
      .catch((error: Error) => {
        this.log.warn(`[${this.label}] snapshot failed: ${error.message}`);
        callback(error);
      });
  }

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const localVideoPort = reserveLocalPort();
    const ssrc = randomInt(1, 0x7fffffff);

    this.pendingSessions.set(request.sessionID, {
      targetAddress: request.targetAddress,
      targetVideoPort: request.video.port,
      localVideoPort,
      ssrc,
      cryptoSuite: request.video.srtpCryptoSuite,
      srtp: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
    });

    const response: PrepareStreamResponse = {
      video: {
        port: localVideoPort,
        ssrc,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
    };
    callback(undefined, response);
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        return;
      case StreamRequestTypes.RECONFIGURE:
        callback();
        return;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        return;
    }
  }

  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {
    const session = this.pendingSessions.get(request.sessionID);
    this.pendingSessions.delete(request.sessionID);
    if (!session) {
      callback(new Error(`No pending session for ${request.sessionID}`));
      return;
    }

    let tmpDir: string;
    let jpegFilePath: string;
    try {
      const jpeg = await this.source.getCurrentJpeg();
      tmpDir = await mkdtemp(join(tmpdir(), 'trmnl-camera-'));
      jpegFilePath = join(tmpDir, 'frame.jpg');
      await writeFile(jpegFilePath, jpeg);
    } catch (error) {
      usedLocalPorts.delete(session.localVideoPort);
      callback(error as Error);
      return;
    }

    const { video } = request;
    const profile = H264_PROFILE_NAMES[video.profile];
    const level = H264_LEVEL_NAMES[video.level];
    const fps = Math.min(this.streamFps, video.fps) || this.streamFps;

    const args = [
      '-loglevel', 'error',
      '-re',
      '-loop', '1',
      '-i', jpegFilePath,
      '-map', '0:v',
      '-an', '-sn', '-dn',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-vf', `scale=${video.width}:${video.height}`,
      '-profile:v', profile,
      '-level:v', level,
      '-b:v', `${video.max_bit_rate}k`,
      '-bufsize', `${video.max_bit_rate * 2}k`,
      '-payload_type', String(video.pt),
      '-ssrc', String(session.ssrc),
      '-f', 'rtp',
    ];

    if (session.cryptoSuite !== SRTPCryptoSuites.NONE) {
      args.push(
        '-srtp_out_suite',
        session.cryptoSuite === SRTPCryptoSuites.AES_CM_256_HMAC_SHA1_80
          ? 'AES_CM_256_HMAC_SHA1_80'
          : 'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params', session.srtp.toString('base64'),
      );
    }

    const scheme = session.cryptoSuite !== SRTPCryptoSuites.NONE ? 'srtp' : 'rtp';
    args.push(
      `${scheme}://${session.targetAddress}:${session.targetVideoPort}` +
        `?rtcpport=${session.targetVideoPort}&localrtcpport=${session.localVideoPort}&pkt_size=${video.mtu}`,
    );

    const proc = spawn(this.ffmpegBinaryPath, args, { env: process.env });
    let started = false;

    proc.stderr.on('data', (chunk: Buffer) => {
      this.log.debug(`[${this.label}] ffmpeg: ${chunk.toString('utf8')}`);
      if (!started) {
        started = true;
        callback();
      }
    });
    proc.on('error', (error) => {
      this.log.warn(`[${this.label}] ffmpeg failed to start: ${error.message}`);
      if (!started) {
        started = true;
        callback(error);
      }
    });
    proc.on('exit', (code, signal) => {
      if (code !== null && code !== 0 && code !== 255) {
        this.log.warn(`[${this.label}] ffmpeg exited with code ${code} (signal ${signal ?? 'none'})`);
      }
    });

    this.ongoingSessions.set(request.sessionID, { process: proc, localVideoPort: session.localVideoPort, tmpDir });
  }

  private stopStream(sessionID: string): void {
    this.pendingSessions.delete(sessionID);
    const session = this.ongoingSessions.get(sessionID);
    if (!session) {
      return;
    }
    this.ongoingSessions.delete(sessionID);
    usedLocalPorts.delete(session.localVideoPort);
    session.process.kill('SIGKILL');
    void rm(session.tmpDir, { recursive: true, force: true });
  }
}
