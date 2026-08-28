#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { createMeterServer } from '../lib/server.js';

const stateFile = process.env.CODEX_METER_STATE || path.join(os.homedir(), '.codex-meter-server', 'state.json');
const host = process.env.CODEX_METER_HOST || '127.0.0.1';
const port = Number(process.env.CODEX_METER_PORT || 8787);
const server = createMeterServer({ stateFile });
server.listen(port, host, () => console.log(`codex-meter listening on http://${host}:${port}`));
