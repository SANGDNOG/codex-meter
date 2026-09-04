export const AGENT_CAPABILITY_HEADER = 'x-codex-meter-capabilities';
export const AGENT_CAPABILITY_HEADER_VALUE = 'agentConfigurationSchema=1;declarativeProfiles=1;actualState=1';

const ALLOWED = new Set(['agentConfigurationSchema', 'declarativeProfiles', 'actualState']);

export function parseAgentCapabilityHeader(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256) return null;
  const parsed = new Map();
  for (const segment of value.split(';')) {
    const match = segment.match(/^([A-Za-z][A-Za-z0-9]*)=([0-9]+)$/);
    if (!match) return null;
    const [, key, raw] = match;
    if (!ALLOWED.has(key)) return null;
    if (parsed.has(key)) return null;
    parsed.set(key, raw);
  }
  if (parsed.get('agentConfigurationSchema') !== '1' || parsed.get('declarativeProfiles') !== '1'
    || (parsed.has('actualState') && parsed.get('actualState') !== '1')) return null;
  return Object.freeze({
    agentConfigurationSchema: 1,
    declarativeProfiles: true,
    actualState: parsed.get('actualState') === '1'
  });
}

export const SERVER_CAPABILITIES = Object.freeze({
  agentConfigurationSchema: 1,
  declarativeProfiles: true,
  actualState: true
});

export function parseServerCapabilities(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'actualState,agentConfigurationSchema,declarativeProfiles') return null;
  if (value.agentConfigurationSchema !== 1 || value.declarativeProfiles !== true || typeof value.actualState !== 'boolean') return null;
  return Object.freeze({ agentConfigurationSchema: 1, declarativeProfiles: true, actualState: value.actualState });
}
