'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../lab-ui.js'), 'utf8');
const workspace = (name) => ({ name, history: [], repeaters: [], collections: [], environments: [], runnerResults: [], findings: [], websocketFrames: [] });

// Exercise the actual event handlers, delaying only file I/O at the boundary.
function harness() {
  const elements = new Map();
  const readCalls = [], exportCalls = [], downloads = [], toasts = [];
  function $(id) {
    if (!elements.has(id)) {
      const classes = new Set(id === '#backupPreview' ? ['hidden'] : []);
      elements.set(id, {
        value: '', textContent: '', disabled: false, listeners: {},
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
        addEventListener(name, listener) { this.listeners[name] = listener; },
        click() {},
      });
    }
    return elements.get(id);
  }
  function delayed(calls, input) {
    return new Promise((resolve, reject) => calls.push({ ...input, resolve, reject }));
  }
  const labState = { pendingBackup: null };
  const context = vm.createContext({
    $, labState, fmtSize: String,
    captureWorkspace: () => ({ fixture: 'current' }),
    downloadLocal: (blob, name) => downloads.push({ blob, name }),
    toast: (message, kind) => toasts.push({ message, kind }),
    Backup: {
      readFile: (file, password, options) => delayed(readCalls, { file, password, options }),
      createBlob: (backup, password, options) => delayed(exportCalls, { backup, password, options }),
    },
  });
  const helpersStart = source.indexOf('let backupBusy =');
  const helpersEnd = source.indexOf('// Only drafts and view preferences', helpersStart);
  const handlersStart = source.indexOf("  $('#backupDownload').addEventListener");
  const handlersEnd = source.indexOf("  $('#backupRestore').addEventListener", handlersStart);
  vm.runInContext(source.slice(helpersStart, helpersEnd) + source.slice(handlersStart, handlersEnd), context);
  function importFile(name) {
    const target = { value: name, files: [{ name }] };
    return { target, promise: $('#backupFile').listeners.change({ target }) };
  }
  const busyControls = ['backupDownload', 'backupImport', 'backupRestore', 'workspaceUndoRestore', 'backupPassword'];
  return {
    $, labState, readCalls, exportCalls, downloads, toasts, importFile,
    download: () => $('#backupDownload').listeners.click(),
    dismiss: () => $('#backupDismiss').listeners.click(),
    controlsDisabled: () => busyControls.every((name) => $('#' + name).disabled),
    controlsEnabled: () => busyControls.every((name) => !$('#' + name).disabled),
  };
}

test('workspace backup I/O serializes imports and downloads while a file is being read', async () => {
  const h = harness();
  h.$('#backupPassword').value = 'local-fixture-password';
  const first = h.importFile('first');
  assert.equal(h.controlsDisabled(), true);
  const second = h.importFile('second');
  await second.promise;
  await h.download();
  assert.equal(h.readCalls.length, 1, 'a second selection cannot race the active import');
  assert.equal(h.exportCalls.length, 0, 'download cannot race the active import');
  assert.equal(second.target.value, '');
  h.readCalls[0].resolve(workspace('first'));
  await first.promise;
  assert.equal(h.labState.pendingBackup.name, 'first');
  assert.equal(h.$('#backupPreview').classList.contains('hidden'), false);
  assert.equal(h.controlsEnabled(), true);
  assert.equal(h.$('#backupPassword').value, '');
});

test('dismissing an ongoing import prevents stale progress, preview, and error publication', async () => {
  for (const result of ['complete', 'error']) {
    const h = harness();
    const first = h.importFile('canceled');
    h.dismiss();
    h.readCalls[0].options.onProgress({ bytes: 100, total: 200 });
    assert.equal(h.$('#backupStatus').textContent, 'Import canceled.');
    if (result === 'complete') h.readCalls[0].resolve(workspace('canceled'));
    else h.readCalls[0].reject(new Error('old import failed'));
    await first.promise;
    assert.equal(h.labState.pendingBackup, null);
    assert.equal(h.$('#backupPreview').classList.contains('hidden'), true);
    assert.equal(h.$('#backupStatus').textContent, 'Import canceled.');
    assert.equal(h.toasts.length, 0, 'canceled file failures do not overwrite the current message');
    assert.equal(h.controlsEnabled(), true);
    const next = h.importFile('next');
    h.readCalls[1].resolve(workspace('next'));
    await next.promise;
    assert.equal(h.labState.pendingBackup.name, 'next', 'subsequent imports remain usable');
  }
});

test('backup download failures release I/O controls, clear passwords, and permit a new import', async () => {
  const h = harness();
  h.$('#backupPassword').value = 'local-fixture-password';
  const download = h.download();
  assert.equal(h.controlsDisabled(), true);
  assert.equal(h.exportCalls[0].password, 'local-fixture-password');
  h.exportCalls[0].reject(new Error('fixture disk failure'));
  await download;
  assert.equal(h.controlsEnabled(), true);
  assert.equal(h.$('#backupPassword').value, '');
  assert.equal(h.downloads.length, 0);
  assert.equal(h.$('#backupStatus').textContent, 'fixture disk failure');
  assert.equal(h.toasts[0].kind, 'error');
  const next = h.importFile('after failure');
  h.readCalls[0].resolve(workspace('after failure'));
  await next.promise;
  assert.equal(h.labState.pendingBackup.name, 'after failure');
});
