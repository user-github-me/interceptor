'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ layout, preserve } = {}) {
  const source = fs.readFileSync(require.resolve('../lab-ui.js'), 'utf8');
  const applyBackup = source.slice(source.indexOf('async function applyBackup('), source.indexOf('\nasync function bindLab()'));
  let current = 'original', undo;
  const main = { inert: false };
  const busy = [];
  const context = vm.createContext({
    state: { attached: false, queue: [] }, workflowState: { runner: { running: false } }, repeaterBusy: false,
    labState: { ready: true, storageBlocked: false, activeTest: false, restoring: false },
    localSaveTimer: null, clearTimeout,
    $: (selector) => { assert.equal(selector, 'main'); return main; },
    setBackupBusy(value) { busy.push(value); },
    LocalStore: { read: async () => current, preserve: async (snapshot) => { await preserve?.(); undo = snapshot; } },
    flushLocalSave: async () => {}, captureWorkspace: () => current,
    restoreWorkspace(workspace) { current = workspace.marker; },
    Layout: { restore: async () => { await layout?.(); } },
    saveSettings() {}, saveRepeaters() {}, toast() {},
  });
  vm.runInContext(applyBackup, context);
  return {
    context, main, busy,
    run: (workspace) => context.applyBackup(workspace),
    get current() { return current; }, get undo() { return undo; },
    get restoring() { return context.labState.restoring; },
  };
}

test('overlapping restores cannot overwrite the original undo snapshot', async () => {
  const reached = deferred(), release = deferred();
  const h = harness({ layout: async () => { reached.resolve(); await release.promise; } });
  const first = h.run({ marker: 'restored', layout: {} });
  await reached.promise;
  assert.equal(h.main.inert, true, 'workspace editing is blocked while replacement is in flight');
  assert.equal(h.restoring, true);
  await assert.rejects(h.run({ marker: 'second' }), /restore is already running/);
  assert.equal(h.undo, 'original');
  release.resolve(); await first;
  assert.equal(h.current, 'restored');
  assert.equal(h.undo, 'original');
  assert.equal(h.restoring, false);
  assert.equal(h.main.inert, false);
  assert.deepEqual(h.busy, [true, false]);
});

test('failed preservation leaves the original workspace and releases restore controls', async () => {
  const h = harness({ preserve: async () => { throw new Error('fixture quota failure'); } });
  await assert.rejects(h.run({ marker: 'replacement', layout: {} }), /fixture quota failure/);
  assert.equal(h.current, 'original');
  assert.equal(h.restoring, false);
  assert.equal(h.main.inert, false);
  assert.deepEqual(h.busy, [true, false]);
});

test('failed layout restore retains undo and permits recovery through a subsequent restore', async () => {
  let fail = true;
  const h = harness({ layout: async () => { if (fail) throw new Error('fixture layout failure'); } });
  await assert.rejects(h.run({ marker: 'replacement', layout: {} }), /fixture layout failure/);
  assert.equal(h.undo, 'original');
  assert.equal(h.restoring, false);
  assert.equal(h.main.inert, false);
  fail = false;
  await h.run({ marker: h.undo, layout: {} });
  assert.equal(h.current, 'original');
});
