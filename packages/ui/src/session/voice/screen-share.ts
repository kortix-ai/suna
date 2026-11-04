/**
 * A shared screen, as frames for the relay: ported from the voice lab's call page (its Present button and
 * frame sampler). The first frame goes as soon as there is a picture, then one when the picture changed (its
 * 32x18 grey thumbnail differs) at most every 3 s, and one at least every 20 s. JPEG, longest side 1280 px.
 */

/** The capture a share asks for. */
export const SCREEN_MEDIA: DisplayMediaStreamOptions = { video: { frameRate: { ideal: 10, max: 15 } } };

const MIN_GAP_MS = 3_000;
const MAX_GAP_MS = 20_000;
const SIDE_PX = 1280;
const QUALITY = 0.7;
const CHECK_MS = 500;

export const THUMB_WIDTH = 32;
export const THUMB_HEIGHT = 18;
const THUMB_PIXELS = THUMB_WIDTH * THUMB_HEIGHT;
/** The mean per-pixel difference of two thumbnails from which the picture counts as changed. */
export const MOVED_MEAN = 4;

/** A browser that can share a screen (mobile browsers cannot). */
export const canShareScreen = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/** The grey value of each pixel of a 32x18 RGBA thumbnail. */
export function greyThumb(rgba: ArrayLike<number>): Uint8Array {
  const grey = new Uint8Array(THUMB_PIXELS);
  for (let i = 0; i < THUMB_PIXELS; i++) grey[i] = (rgba[4 * i] + rgba[4 * i + 1] + rgba[4 * i + 2]) / 3;
  return grey;
}

/** The picture changed since `last` (no frame sent yet counts as changed). */
export function thumbMoved(last: Uint8Array | undefined, next: Uint8Array): boolean {
  if (!last) return true;
  let sum = 0;
  for (let i = 0; i < next.length; i++) sum += Math.abs(next[i] - last[i]);
  return sum / next.length >= MOVED_MEAN;
}

export interface ScreenSampler {
  stop(): void;
  /** Sends the frame now, past both gates (the relay asked to look); false while there is no picture. */
  snap(): boolean;
}

/** Samples a playing `video` of the shared screen and passes each frame to `send` as JPEG base64. */
export function sampleScreen(video: HTMLVideoElement, send: (jpeg: string) => void): ScreenSampler {
  const thumb = document.createElement('canvas');
  thumb.width = THUMB_WIDTH;
  thumb.height = THUMB_HEIGHT;
  const thumbContext = thumb.getContext('2d', { willReadFrequently: true });
  let last: Uint8Array | undefined;
  let sentAt = -Infinity;
  let stopped = false;

  const check = (now = false): boolean => {
    if (stopped || !thumbContext || !video.videoWidth) return false;
    const since = performance.now() - sentAt;
    if (!now && since < MIN_GAP_MS) return false;
    thumbContext.drawImage(video, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    const grey = greyThumb(thumbContext.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT).data);
    if (!now && !thumbMoved(last, grey) && since < MAX_GAP_MS) return false;
    last = grey;
    sentAt = performance.now();
    const scale = Math.min(1, SIDE_PX / Math.max(video.videoWidth, video.videoHeight));
    const frame = document.createElement('canvas');
    frame.width = Math.round(video.videoWidth * scale);
    frame.height = Math.round(video.videoHeight * scale);
    frame.getContext('2d')?.drawImage(video, 0, 0, frame.width, frame.height);
    send(frame.toDataURL('image/jpeg', QUALITY).split(',')[1] ?? '');
    return true;
  };

  const timer = setInterval(() => check(), CHECK_MS);
  video.addEventListener('loadeddata', () => check(), { once: true });
  check();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    snap: () => check(true),
  };
}
