'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(initial, failure = false) {
  const values = { localDataDisclosure: initial };
  const writes = [];
  const context = vm.createContext({
    Date, chrome: { storage: { local: {
      get: async () => { if (failure) throw Error('storage unavailable'); return values; },
      set: async (data) => { if (failure) throw Error('storage unavailable'); Object.assign(values, data); writes.push(data); },
    } } },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../consent.js'), 'utf8'), context);
  return { api: context.Disclosure, values, writes };
}

test('disclosure requires the current revision and explicit acknowledgment', async () => {
  for (const saved of [undefined, {}, { revision: 0, acceptedAt: 'old' }, { revision: 1 }, { revision: 1, acceptedAt: 'invalid' }, { revision: 2, acceptedAt: 'future' }]) {
    assert.equal(await harness(saved).api.accepted(), false);
  }
  const { api, values, writes } = harness();
  assert.equal(await api.accepted(), false);
  await api.acknowledge();
  assert.equal(writes.length, 1);
  assert.equal(values.localDataDisclosure.revision, 1);
  assert.ok(Number.isFinite(Date.parse(values.localDataDisclosure.acceptedAt)));
  assert.equal(await api.accepted(), true);
  delete values.localDataDisclosure;
  assert.equal(await api.accepted(), false, 'revocation is freshly read');
});

test('unavailable disclosure storage fails closed and does not acknowledge', async () => {
  const { api, writes } = harness({ revision: 1, acceptedAt: 'old' }, true);
  assert.equal(await api.accepted(), false);
  await assert.rejects(api.acknowledge(), /storage unavailable/);
  assert.equal(writes.length, 0);
});
