import { open } from 'node:fs/promises';

/** Streams complete lines only. The final unterminated line is deliberately classified partial. */
export async function streamJsonl(filename, onRecord, { maxLineBytes = 4 * 1024 * 1024 } = {}) {
  const stats = { records: 0, malformedLines: 0, partialFinalLines: 0, oversizedLines: 0, disappeared: false };
  let handle;
  try { handle = await open(filename, 'r'); }
  catch (error) { if (error.code === 'ENOENT') { stats.disappeared = true; return stats; } throw error; }
  let carry = '';
  let discardingOversized = false;
  try {
    for await (const chunk of handle.createReadStream({ encoding: 'utf8' })) {
      const lines = (carry + chunk).split('\n'); carry = lines.pop() ?? '';
      for (const line of lines) {
        if (discardingOversized) { discardingOversized = false; continue; }
        if (Buffer.byteLength(line) > maxLineBytes) { stats.oversizedLines++; continue; }
        if (!line.trim()) continue;
        try { await onRecord(JSON.parse(line)); stats.records++; }
        catch (error) { if (error instanceof SyntaxError) stats.malformedLines++; else throw error; }
      }
      if (Buffer.byteLength(carry) > maxLineBytes) { carry = ''; discardingOversized = true; stats.oversizedLines++; }
    }
    if (!discardingOversized && carry.trim()) stats.partialFinalLines++;
  } catch (error) {
    if (error.code === 'ENOENT') stats.disappeared = true;
    else throw error;
  } finally { await handle.close().catch(() => {}); }
  return stats;
}
