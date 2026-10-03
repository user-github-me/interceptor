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

test('header-only response edits preserve original CRLF body bytes', () => {
  const { context } = forwardingHarness();
  const item = {
    id: 'response', stage: 'response', originalBodyB64: null, originalBody: 'first\r\nsecond\r\n',
    originalRaw: 'HTTP/1.1 200 OK\nX-Test: old\n\nfirst\nsecond\n',
    raw: 'HTTP/1.1 200 OK\nX-Test: new\n\nfirst\nsecond\n',
  };
  const release = context.buildRelease(item);
  assert.equal(atob(release.params.body), item.originalBody);
  item.raw = item.raw.replace('second', 'changed');
  assert.equal(atob(context.buildRelease(item).params.body), 'first\nchanged\n');
});

test('canceling dashboard debugging disables Auto before releasing the tab', async () => {
  const events = [];
  let persist;
  const state = { attached: true, tabId: 17, settings: { autoMode: true, autoTabId: 17 }, queue: [], forceResponse: new Set() };
  const context = vm.createContext({
    state, netMap: new Map(), queueLocalSave: () => {},
    chrome: { storage: { local: { set: (data) => { events.push(data); return new Promise((resolve) => { persist = resolve; }); } } } },
    releaseTab: async (tabId) => { events.push({ released: tabId }); },
    renderQueue: () => {}, loadEditor: () => {}, updateStatus: () => {}, toast: () => {},
  });
  vm.runInContext(source.slice(source.indexOf('function onDetached('), source.indexOf('function updateStatus()')), context);
  context.onDetached('canceled_by_user');
  assert.equal(state.attached, false);
  assert.equal(state.settings.autoMode, false);
  assert.equal(events.length, 1, 'ownership remains claimed until Auto is disabled in storage');
  assert.equal(events[0].settings.autoMode, false);
  assert.equal(Object.hasOwn(events[0].settings, 'autoTabId'), false);
  persist();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events[1], { released: 17 });
  context.onDetached('canceled_by_user');
  assert.equal(events.length, 2, 'duplicate detach notifications do not release a newer session');
});

test('history marks unavailable upload bytes and never treats multipart fallback as complete', async () => {
  const state = { history: [], seq: 0 };
  const context = vm.createContext({
    HTTP, state, netMap: new Map(), extraReq: new Map(), MAX_BODY_CHARS: 750_000,
    requestBodyFromCdp: HTTP.requestBodyText, limitBody: (text) => String(text || ''), fmtSize: (size) => String(size),
    cdp: async () => ({ postData: 'partial multipart text without file bytes' }),
    pruneHistory: () => {}, scheduleHistoryRender: () => {}, touchHistory: () => {},
  });
  vm.runInContext(source.slice(source.indexOf('function onRequestWillBeSent('), source.indexOf('function onRequestExtra(')), context);
  context.onRequestWillBeSent({ requestId: 'upload', timestamp: 1, request: {
    method: 'POST', url: 'https://example.test/upload', hasPostData: true,
    headers: { 'Content-Type': 'multipart/form-data; boundary=fixture' }, postDataEntries: [{ bytes: btoa('field') }, {}],
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.history[0].reqBodyComplete, false);
  assert.equal(HTTP.isUnavailableRequestBody(state.history[0].reqBody), true);
  context.onRequestWillBeSent({ requestId: 'text', timestamp: 2, request: {
    method: 'POST', url: 'https://example.test/text', hasPostData: true, headers: { 'Content-Type': 'text/plain' },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.history[1].reqBodyComplete, true);
  assert.equal(state.history[1].reqBody, 'partial multipart text without file bytes');
});
