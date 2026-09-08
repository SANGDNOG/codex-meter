import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

// A separate readline instance per prompt prevents the visible URL/account
// reader from echoing credential input. Only readline owns raw mode; the muted
// sink never forwards characters (or a masked copy) to the real terminal.
export function setupQuestion(prompt, { input = process.stdin, output = process.stdout, secret = false, signals = process } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
    return Promise.reject(new Error('interactive_terminal_required'));
  return new Promise((resolve, reject) => {
    const muted = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : null;
    const wasRaw = Boolean(input.isRaw);
    let reader, finished = false, finalError, answer;
    const cancel = () => finish(new Error('setup_cancelled'));
    const failed = () => finish(new Error('terminal_input_failed'));
    function finish(error, value) {
      finalError ??= error;
      if (finished) return;
      finished = true;
      answer = value;
      signals.off('SIGINT', cancel); signals.off('SIGTERM', cancel);
      reader?.off('close', cancel); reader?.off('SIGINT', cancel);
      reader?.close(); muted?.end();
      try { input.setRawMode(wasRaw); } catch { finalError ??= new Error('terminal_input_failed'); }
      // A write callback can precede its stream's next-tick error event. Keep
      // sanitizing listeners until queued output and that event turn settle.
      const settled = () => setImmediate(() => {
        input.off('error', failed); output.off('error', failed); reader?.off('error', failed);
        if (finalError) reject(finalError); else resolve(answer);
      });
      try { output.write(secret ? '\n' : '', writeError => { if (writeError) failed(); settled(); }); }
      catch { failed(); settled(); }
    }
    try {
      reader = createInterface({ input, output: muted ?? output, terminal: true, historySize: 0 });
      reader.once('close', cancel); reader.once('SIGINT', cancel); reader.on('error', failed);
      input.on('error', failed); output.on('error', failed);
      signals.once('SIGINT', cancel); signals.once('SIGTERM', cancel);
      reader.question(prompt, value => finish(null, value));
      if (secret) output.write(prompt);
    } catch { failed(); }
  });
}
