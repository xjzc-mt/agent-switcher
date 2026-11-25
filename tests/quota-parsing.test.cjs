const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseQuota } = require('../dist/agents/codex');

const short = { usedPercent: 60, windowDurationMins: 300, resetsAt: 2000000000 };
const weekly = { usedPercent: 33, windowDurationMins: 10080, resetsAt: 2000400000 };

test('Antigravity shows an Ultra multiplier only for a matching paid tier ID and name', () => {
  const { antigravityPlan } = require('../dist/antigravity-cli');
  const { planInfo } = require('../renderer/account-policy');
  const name = 'Google AI Ultra';
  assert.equal(antigravityPlan({ name, id: 'g1-ultra-lite-tier' }), 'Google AI Ultra 5×');
  assert.equal(antigravityPlan({ name, id: 'g1-ultra-tier' }), 'Google AI Ultra 20×');
  assert.equal(planInfo({ plan: antigravityPlan({ name, id: 'g1-ultra-tier' }) }, 'agy').label, 'Ultra 20×');
  assert.equal(antigravityPlan({ name, id: 'future-ultra-tier' }), name);
  assert.equal(antigravityPlan({ name }), name);
  assert.equal(antigravityPlan({ name: 'Enterprise', id: 'g1-ultra-tier' }), 'Enterprise');
});

test('CLI status reports a failed platform independently and shows Antigravity quota per model group', async t => {
  const accounts = require('../dist/accounts');
  const { runStatus } = require('../dist/commands/status');
  const log = t.mock.method(console, 'log', () => {});
  t.mock.method(accounts, 'activeProfile', agent => {
    if (agent.id === 'codex') throw new Error('fixture read failure');
    return 'fixture';
  });
  t.mock.method(accounts, 'refreshAccount', async () => ({
    available: true, account: 'fixture', quota: { buckets: [{ id: 'gemini', label: 'Gemini', windows: [{usedPercent: 30, windowMins: 300}] }] },
  }));
  await runStatus([{ id: 'codex', label: 'Codex' }, { id: 'agy', label: 'Antigravity' }]);
  const output = log.mock.calls.map(call => call.arguments[0]).join('\n');
  assert.match(output, /Codex.*error reading status/);
  assert.match(output, /Antigravity.*Gemini.*300.*70%/);
});

test('empty and partial bucket maps retain fields from the same legacy bucket', () => {
  const legacy = { planType: 'plus', primary: short, secondary: weekly };
  const empty = parseQuota({ rateLimits: legacy, rateLimitsByLimitId: {} });
  assert.equal(empty.buckets.length, 1);
  assert.equal(empty.primaryWindow.resetsAt, short.resetsAt);
  assert.equal(empty.secondaryWindow.resetsAt, weekly.resetsAt);
  const swapped = parseQuota({ rateLimits: { primary: weekly, secondary: short } });
  assert.equal(swapped.primaryWindow.windowMins, 10080);
  assert.equal(swapped.secondaryWindow.windowMins, 300);
  const partial = parseQuota({ rateLimits: legacy, rateLimitsByLimitId: { codex: { primary: { ...short, usedPercent: 70 } } } });
  assert.equal(partial.plan, 'plus');
  assert.equal(partial.primaryWindow.usedPercent, 70);
  assert.equal(partial.secondaryWindow.resetsAt, weekly.resetsAt);
  assert.equal(partial.buckets[0].windows[1].resetsAt, weekly.resetsAt);
});

test('explicitly absent windows are not resurrected from legacy or plan defaults', () => {
  const quota = parseQuota({
    rateLimits: { primary: short, secondary: weekly },
    rateLimitsByLimitId: { codex: { planType: 'plus', primary: short, secondary: null } },
  });
  assert.equal(quota.secondaryWindow, undefined);
  assert.equal(quota.buckets[0].windows.length, 1);
  const noReset = parseQuota({ rateLimits: { planType: 'plus', secondary: { usedPercent: 30, windowDurationMins: 10080 } } });
  assert.equal(noReset.secondaryWindow.resetsAt, undefined);
});

test('model-specific legacy buckets never become general Codex quotas or credits', () => {
  const quota = parseQuota({ rateLimits: { limitId: 'base_model_inference', primary: weekly, credits: { balance: '50' } } });
  assert.equal(quota.primaryWindow, undefined);
  assert.equal(quota.secondaryWindow, undefined);
  assert.equal(quota.credits, undefined);
  assert.equal(quota.buckets[0].id, 'base_model_inference');
  assert.equal(quota.buckets[0].windows[0].resetsAt, weekly.resetsAt);
  const mixed = parseQuota({ rateLimits: { limitId: 'other', secondary: weekly }, rateLimitsByLimitId: { codex: { primary: short } } });
  assert.equal(mixed.primaryWindow.windowMins, 300);
  assert.equal(mixed.secondaryWindow, undefined);
});

test('malformed durations and reset timestamps remain unknown without losing valid usage', () => {
  for (const value of [0, Infinity, '10080']) {
    const quota = parseQuota({ rateLimits: { primary: { usedPercent: 20, windowDurationMins: value, resetsAt: value } } });
    assert.equal(quota.primaryWindow.usedPercent, 20);
    assert.equal(quota.primaryWindow.windowMins, undefined);
    assert.equal(quota.primaryWindow.resetsAt, undefined);
  }
  const outOfDateRange = parseQuota({ rateLimits: { primary: { usedPercent: 20, resetsAt: Number.MAX_VALUE } } });
  assert.equal(outOfDateRange.primaryWindow.resetsAt, undefined);
  for (const value of [NaN, '20']) {
    assert.equal(parseQuota({ rateLimits: { primary: { usedPercent: value } } }).primaryWindow, undefined);
  }
  assert.equal(parseQuota({ rateLimits: { primary: { usedPercent: -5 } } }).primaryWindow.usedPercent, 0);
  assert.equal(parseQuota({ rateLimits: { primary: { usedPercent: 120 } } }).primaryWindow.usedPercent, 100);
});

test('null and malformed response entries do not crash quota refresh', () => {
  for (const value of [null, { rateLimitsByLimitId: { codex: null } }]) {
    assert.equal(parseQuota(value), undefined);
  }
  const quota = parseQuota({ rateLimitsByLimitId: { invalid: null, codex: { primary: short } } });
  assert.equal(quota.primaryWindow.resetsAt, short.resetsAt);
  assert.equal(quota.buckets.length, 1);
});

test('reset card counts remain authoritative when details are null, empty or capped', () => {
  for (const credits of [null, [], [{id:'reset-1',resetType:'codexRateLimits',status:'available',expiresAt:null,title:'额度重置卡'}]]) {
    const q=parseQuota({rateLimits:{primary:short},rateLimitResetCredits:{availableCount:3,credits}});
    assert.equal(q.resetCredits.availableCount,3);
    assert.equal(q.resetCredits.credits?.length,credits?.length);
    if(credits?.length)assert.equal(q.resetCredits.credits[0].expiresAt,null);
  }
  const q=parseQuota({rateLimits:{primary:short},rateLimitResetCredits:{availableCount:0,credits:null}});
  assert.equal(q.resetCredits.availableCount,0);
});

test('unknown reset card data does not become zero or non-expiring rights', () => {
  for(const availableCount of [undefined,null,-1,1.5,'2',Number.MAX_SAFE_INTEGER+1]) {
    assert.equal(parseQuota({rateLimits:{primary:short},rateLimitResetCredits:{availableCount,credits:[]}}).resetCredits,undefined);
  }
  const q=parseQuota({rateLimits:{primary:short},rateLimitResetCredits:{availableCount:1,credits:[{id:'r',status:'unknown',expiresAt:'tomorrow'},null]}});
  assert.equal(q.resetCredits.credits.length,1);
  assert.equal(q.resetCredits.credits[0].expiresAt,undefined);
});
