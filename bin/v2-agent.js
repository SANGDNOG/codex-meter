#!/usr/bin/env node
import { runAgentCli } from '../v2/agent/cli.js';

runAgentCli().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error?.message ?? 'agent command failed'); process.exitCode = 1;
});