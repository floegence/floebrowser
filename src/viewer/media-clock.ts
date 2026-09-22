export type MediaClock = {
  origin?: number;
  audio?: number;
  video?: number;
};

/**
 * WebRTC audio and video senders can expose different RTP timestamp origins
 * even when they belong to one source element. Keep their first decoded media
 * units on one playback timeline while preserving each track's elapsed time.
 */
export function alignMediaTimestamp(
  clock: MediaClock,
  track: 'audio' | 'video',
  timestamp: number,
): number {
  if (!Number.isFinite(timestamp)) return timestamp;
  clock.origin ??= timestamp;
  clock[track] ??= timestamp;
  return clock.origin + (timestamp - clock[track]);
}
