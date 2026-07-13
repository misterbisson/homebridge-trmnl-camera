import { spawn } from 'node:child_process';

/** Converts an image (PNG or otherwise ffmpeg-decodable) buffer to a JPEG buffer via ffmpeg. */
export function convertToJpeg(ffmpegBinaryPath: string, input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBinaryPath, [
      '-loglevel', 'error',
      '-f', 'image2pipe',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-f', 'mjpeg',
      'pipe:1',
    ]);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new Error(`ffmpeg PNG->JPEG conversion exited with code ${code}: ${Buffer.concat(stderr).toString('utf8')}`));
      }
    });

    proc.stdin.end(input);
  });
}
