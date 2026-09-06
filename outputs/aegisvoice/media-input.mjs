export const MAX_MEDIA_MEGABYTES = 64;
export const MAX_MEDIA_BYTES = MAX_MEDIA_MEGABYTES * 1024 * 1024;
export const MEDIA_ACCEPT = '.wav,.mp3,.m4a,.mp4,.mov,.webm,.ogg,.flac,audio/*,video/mp4,video/quicktime';

export function assertMediaInput(value, label = 'Media file') {
  const size = Number(value?.size ?? value?.byteLength);
  if (!Number.isFinite(size)) throw new TypeError(`${label} size is unavailable.`);
  if (size <= 0) throw new Error(`${label} is empty.`);
  if (size > MAX_MEDIA_BYTES) throw new Error(`${label} exceeds ${MAX_MEDIA_MEGABYTES} MB.`);
  return value;
}

export function configureMediaInput(input) {
  if (input) input.accept = MEDIA_ACCEPT;
  return input;
}