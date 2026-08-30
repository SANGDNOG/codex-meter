import { open } from 'node:fs/promises';

export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

/** Reads bytes from offset, yielding complete LF-terminated lines only. Never returns raw malformed content. */
export async function readCompleteLines(filename, offset, {
  maxLineBytes = DEFAULT_MAX_LINE_BYTES, discardUntilNewline = false,
  maxReadBytes = 8 * 1024 * 1024, maxLines = 10_000
} = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxReadBytes) || maxReadBytes < maxLineBytes
    || !Number.isSafeInteger(maxLines) || maxLines < 1) throw new TypeError('invalid JSONL read bounds');
  const result = { lines: [], nextOffset: offset, malformedLines: 0, oversizedLines: 0, partialLines: 0, discardUntilNewline };
  let handle;
  try { handle = await open(filename, 'r'); } catch (error) { if (error.code === 'ENOENT') return { ...result, disappeared: true }; throw error; }
  let position = offset; let lineStart = offset; let chunks = []; let length = 0; let oversized = false;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let stopped = false;
    while (!stopped) {
      const remainingBound = Math.max(1, maxReadBytes + 1 - (position - offset));
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remainingBound), position);
      if (!bytesRead) break;
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 10) continue;
        const segment = buffer.subarray(segmentStart, index); position += index - segmentStart + 1;
        if (result.discardUntilNewline) result.discardUntilNewline = false;
        else if (!oversized) {
          if (length + segment.length <= maxLineBytes) {
            chunks.push(Buffer.from(segment));
            const raw = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
            if (raw.trim()) {
              try { result.lines.push({ record: JSON.parse(raw), start: lineStart, end: position }); }
              catch { result.malformedLines++; }
            }
          } else result.oversizedLines++;
        }
        chunks = []; length = 0; oversized = false; lineStart = position; segmentStart = index + 1;
        if (result.lines.length >= maxLines || position - offset >= maxReadBytes) { stopped = true; break; }
      }
      if (stopped) continue;
      const tail = buffer.subarray(segmentStart, bytesRead); position += tail.length;
      if (!result.discardUntilNewline && !oversized) {
        if (length + tail.length <= maxLineBytes) { chunks.push(Buffer.from(tail)); length += tail.length; }
        else { oversized = true; chunks = []; result.oversizedLines++; }
      }
      // Once an over-limit record is known to be unusable, advance in bounded pieces while
      // remembering to discard through its eventual newline. This prevents an unterminated
      // multi-gigabyte record from monopolizing one reconciliation pass.
      if ((oversized || result.discardUntilNewline) && position - offset >= maxReadBytes) {
        result.discardUntilNewline = true; lineStart = position; chunks = []; length = 0; stopped = true;
      }
    }
    // Complete lines advance normally; an oversized partial advances in bounded discard mode.
    result.nextOffset = lineStart;
    if (position > lineStart || result.discardUntilNewline) result.partialLines = 1;
    return result;
  } finally { await handle.close(); }
}

export async function safeBaseline(filename) {
  const handle = await open(filename, 'r');
  try {
    const info = await handle.stat();
    if (!info.size) return { offset: 0, discardUntilNewline: false };
    const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, info.size - 1);
    return { offset: info.size, discardUntilNewline: byte[0] !== 10 };
  } finally { await handle.close(); }
}
