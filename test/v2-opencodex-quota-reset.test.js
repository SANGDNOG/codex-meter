import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHubQuota,parseHubUsage} from '../v2/agent/opencodex.js';

const NOW=1788930649723,SECONDS=1789437442,MILLIS=1789437442000;
// Independently stated expected date from the real Hub seconds timestamp.
const ISO='2026-09-15T01:57:22.000Z';
const parse=quota=>parseHubQuota({quota:{updatedAt:NOW,...quota}},()=>NOW);
const windows=[
  ['weekly',{weeklyPercent:17},'weeklyResetAt',10080],
  ['monthly',{monthlyPercent:23},'monthlyResetAt',43200],
  ['short',{shortPercent:31,shortWindowSeconds:18000},'shortResetAt',300],
  ['custom-1',{},null,null]
];
const withReset=(percent,key,reset)=>key?{...percent,[key]:reset}:{customWindows:[{label:'custom',percent:41,resetAt:reset}]};

for(const [name,percent,key,duration]of windows){
  test(`${name}: Unix seconds and milliseconds yield the same independent ISO reset`,()=>{
    for(const reset of [SECONDS,MILLIS]){
      const result=parse(withReset(percent,key,reset));
      assert.equal(result.status,'available');assert.equal(result.observedAt,new Date(NOW).toISOString());
      assert.equal(result.windows[0].resetsAt,ISO);assert.equal(result.windows[0].limitId,name);
      assert.equal(result.windows[0].durationMinutes,duration);
      assert.equal(result.windows[0].usedPercent,key?Object.values(percent)[0]:41);
    }
  });
}
test('null, undefined and zero reset sentinels yield null for every window',()=>{
  for(const [,percent,key]of windows)for(const reset of [null,undefined,0])assert.equal(parse(withReset(percent,key,reset)).windows[0].resetsAt,null);
});
test('negative, fractional, nonfinite, nonsafe and nonnumeric resets fail malformed for every window',()=>{
  for(const [,percent,key]of windows)for(const reset of [-1,1.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,'1789437442',true,{}])assert.throws(()=>parse(withReset(percent,key,reset)),/^Error: malformed$/);
});
test('safe integer outside the JS Date range fails malformed',()=>{
  for(const [,percent,key]of windows)assert.throws(()=>parse(withReset(percent,key,8640000000000001)),/^Error: malformed$/);
});
test('threshold is strictly greater than ten billion for millisecond interpretation',()=>{
  assert.equal(parse({weeklyPercent:17,weeklyResetAt:10_000_000_000}).windows[0].resetsAt,'2286-11-20T17:46:40.000Z');
  assert.equal(parse({weeklyPercent:17,weeklyResetAt:10_000_000_001}).windows[0].resetsAt,'1970-04-26T17:46:40.001Z');
});
test('updatedAt remains in the milliseconds domain',()=>{
  assert.equal(parse({weeklyPercent:17,weeklyResetAt:SECONDS}).observedAt,'2026-09-09T05:10:49.723Z');
  assert.equal(parse({updatedAt:1000,weeklyPercent:17,weeklyResetAt:SECONDS}).observedAt,'1970-01-01T00:00:01.000Z');
});
test('shortObservedAt remains milliseconds and preserves older-observation selection',()=>{
  const result=parse({shortPercent:31,shortWindowSeconds:18000,shortResetAt:SECONDS,shortObservedAt:NOW-60000});
  assert.equal(result.observedAt,'2026-09-09T05:09:49.723Z');
  assert.equal(parse({shortPercent:31,shortObservedAt:1000}).observedAt,'1970-01-01T00:00:01.000Z');
});
test('availability, percentages and unknown duration semantics remain unchanged',()=>{
  assert.equal(parse({}).status,'unavailable');
  assert.equal(parseHubQuota({needsReauth:true,quota:{updatedAt:NOW,weeklyPercent:17}},()=>NOW).status,'unavailable');
  const result=parse({weeklyPercent:0,weeklyResetAt:0,shortPercent:100,shortResetAt:SECONDS,customWindows:[{percent:25,resetAt:MILLIS}]});
  assert.deepEqual(result.windows.map(w=>[w.usedPercent,w.durationMinutes]),[[0,10080],[100,null],[25,null]]);
  assert.equal(result.status,'available');
});
test('usage generatedAt and since remain milliseconds',()=>{
  const usage=parseHubUsage({range:'today',surface:'codex',generatedAt:NOW,since:1000,accounts:[]},'today','main',()=>NOW);
  assert.equal(usage.observedAt,'2026-09-09T05:10:49.723Z');assert.equal(usage.since,'1970-01-01T00:00:01.000Z');
});
