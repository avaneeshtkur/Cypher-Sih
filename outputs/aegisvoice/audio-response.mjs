import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}

// Browsers seek WAVs using byte ranges, including before the full clip is buffered.
export async function sendAudio(req, res, filename) {
  const { size } = await stat(filename);
  const range = byteRange(req.headers['if-range'] ? undefined : req.headers.range, size);
  const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (!range) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    res.end();
    return;
  }
  headers['Content-Length'] = range.end - range.start + 1;
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  res.writeHead(range.partial ? 206 : 200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(createReadStream(filename, { start: range.start, end: range.end }), res);
}
