// Closed wire schema. Deliberately excludes Hub URL, label, alias, email and credentials.
export const HUB_RANGES = ['today','7d','30d','all'];
export const HUB_TOKENS = ['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens','reasoningOutputTokens','totalTokens'];
export const HUB_COUNTS = ['requests','attemptCount','measuredAttempts','reportedAttempts','estimatedAttempts','unmeteredAttempts'];
export const HUB_STATUSES = ['available','unavailable','ambiguous','account_removed','identity_conflict','malformed','read_failed','stale'];
export function exactHub(value, keys) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==[...keys].sort().join())throw new Error('invalid_hub_payload');
}
export function hubTime(value) {
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error('invalid_hub_time');
  return value;
}
export function validateHubUsage(value) {
  exactHub(value,['range','observedAt','since','status','tokens','counts','coverage']);
  if(!HUB_RANGES.includes(value.range)||!HUB_STATUSES.includes(value.status))throw new Error('invalid_hub_usage');
  hubTime(value.observedAt);if(value.since!==null)hubTime(value.since);
  if(value.status!=='available') {
    if(value.tokens!==null||value.counts!==null||value.coverage!==null||value.since!==null)throw new Error('invalid_hub_usage');
  } else {
    exactHub(value.tokens,HUB_TOKENS);exactHub(value.counts,HUB_COUNTS);
    for(const token of Object.values(value.tokens))if(typeof token!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(token)||BigInt(token)>9223372036854775807n)throw new Error('invalid_hub_tokens');
    for(const count of Object.values(value.counts))if(!Number.isSafeInteger(count)||count<0)throw new Error('invalid_hub_counts');
    if(typeof value.coverage!=='number'||!Number.isFinite(value.coverage)||value.coverage<0||value.coverage>1)throw new Error('invalid_hub_coverage');
  }
  return value;
}
export function validateHubQuota(value) {
  exactHub(value,['observedAt','status','windows']);hubTime(value.observedAt);
  if(!HUB_STATUSES.includes(value.status)||!Array.isArray(value.windows)||value.windows.length>32)throw new Error('invalid_hub_quota');
  if((value.status==='available')!==Boolean(value.windows.length))throw new Error('invalid_hub_quota');
  const ids=new Set();
  for(const w of value.windows){
    exactHub(w,['limitId','durationMinutes','usedPercent','resetsAt']);
    if(!/^(weekly|monthly|short|custom-[0-9]{1,2})$/.test(w.limitId)||ids.has(w.limitId))throw new Error('invalid_hub_window');ids.add(w.limitId);
    if(w.durationMinutes!==null&&(!Number.isSafeInteger(w.durationMinutes)||w.durationMinutes<=0||w.durationMinutes>525600))throw new Error('invalid_hub_window');
    if(typeof w.usedPercent!=='number'||!Number.isFinite(w.usedPercent)||w.usedPercent<0||w.usedPercent>100)throw new Error('invalid_hub_window');
    if(w.resetsAt!==null)hubTime(w.resetsAt);
  }
  return value;
}
