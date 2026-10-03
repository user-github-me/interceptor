'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const HTTP = require('../http.js');

// Run the real forwarding functions with a stubbed CDP boundary.
const source = fs.readFileSync(require.resolve('../dashboard.js'), 'utf8');
function forwardingHarness() {
  const commands = [];
  const context = vm.createContext({
    HTTP, MAX_BODY_CHARS: 750_000,
    cdp: async (method, params) => { commands.push({ method, params }); },
    continuePlain: async () => {}, recordAuto: () => {},
  });
  const start = source.indexOf('async function autoForward(');
  const end = source.indexOf('/** Log an auto-rewrite', start);
  const releaseStart = source.indexOf('const isUnchanged =');
  const releaseEnd = source.indexOf('function removeFromQueue', releaseStart);
  vm.runInContext(source.slice(start, end) + source.slice(releaseStart, releaseEnd), context);
  return { context, commands };
}

test('automatic query rewrites preserve oversized upload bytes', async () => {
  const { context, commands } = forwardingHarness();
  const req = { method: 'POST', url: 'https://example.test/?amount=9', headers: {} };
  const body = { text: 'x'.repeat(750_001), known: true, binary: false };
  const mod = HTTP.applyParamRules({ ...req, body: '' }, [{ param: 'amount', value: '1' }]);
  await context.autoForward({ requestId: 'paused' }, req, body, mod);
  assert.match(commands[0].params.url, /amount=1/);
  assert.equal(Object.hasOwn(commands[0].params, 'postData'), false);
});

test('manual query edits preserve omitted uploads and explicit body edits still work', () => {
  const { context } = forwardingHarness();
  const item = {
    id: 'paused', stage: 'request', url: 'https://example.test/?amount=9', originalBody: '',
    originalRaw: 'POST /?amount=9 HTTP/1.1\nHost: example.test\n\n',
    raw: 'POST /?amount=1 HTTP/1.1\nHost: example.test\n\n',
  };
  const queryEdit = context.buildRelease(item);
  assert.equal(Object.hasOwn(queryEdit.params, 'postData'), false);
  item.raw += 'replacement';
  assert.equal(atob(context.buildRelease(item).params.postData), 'replacement');
});
