'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const HTTP = require('../http.js');

const origin = 'chrome-extension://fixture/';
const sender = (page = 'dashboard', id = 1) => ({ id: 'fixture', url: origin + page + '.html', frameId: 0, tab: { id } });
const headerRule = (id = 1001, tabId = 1, url = 'https://example.test/api') => ({
  id, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'set', value: 'fixture=local' }] },
  condition: { tabIds: [tabId], resourceTypes: ['xmlhttprequest'], urlFilter: '|' + url + '|', requestMethods: ['get'] },
});

async function worker(options = {}) {
  const listeners = {};
  const rules = new Map();
  const tabs = new Map([[1, { id: 1, url: origin + 'dashboard.html' }], [2, { id: 2, url: origin + 'dashboard.html' }], [3, { id: 3, url: 'https://example.test/' }]]);
  const session = options.session || {};
  const local = { settings: options.settings || {} };
  let accepted = options.accepted !== false;
  let attachCount = 0;
  let updates = 0;
  const commands = [];
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const context = vm.createContext({ HTTP, URL, importScripts: () => {}, Disclosure: { accepted: async () => accepted }, chrome: {
    runtime: {
      id: 'fixture', getURL: (path) => origin + path,
      onConnect: event('connect'), onMessage: event('message'),
      onInstalled: event('installed'), onStartup: event('startup'), sendMessage: async () => {},
    },
    storage: {
      local: { get: async () => local, set: async (data) => Object.assign(local, data) },
      session: { get: async () => session, set: async (data) => Object.assign(session, data) },
      onChanged: event('storage'),
    },
    debugger: {
      getTargets: async () => [], onEvent: event('debuggerEvent'), onDetach: event('detach'),
      attach: async () => { attachCount++; }, detach: async () => {},
      sendCommand: async (source, method, params) => { commands.push({ source, method, params }); },
    },
    tabs: {
      query: async (query) => [...tabs.values()].filter((tab) => Array.isArray(query.url) ? /^https?:/.test(tab.url) : tab.url === query.url),
      get: async (id) => { if (!tabs.has(id)) throw new Error('Tab closed'); return tabs.get(id); },
      onCreated: event('created'), onUpdated: event('updated'), onRemoved: event('removed'),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    declarativeNetRequest: {
      getSessionRules: async () => options.liveRules || [],
      updateSessionRules: async (change) => {
        updates++;
        for (const id of change.removeRuleIds || []) rules.delete(id);
        for (const rule of change.addRules || []) rules.set(rule.id, rule);
      },
    },
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), context);
  await vm.runInContext('ready', context);
  return {
    context, listeners, rules, local, session, tabs, commands,
    get attachCount() { return attachCount; }, get updates() { return updates; },
    setAccepted(value) { accepted = value; },
    message: (msg, source = sender()) => new Promise((resolve) => listeners.message(msg, source, resolve)),
    async settle() { await vm.runInContext('opChain', context); await vm.runInContext('repeaterChain', context); },
    port(source = sender()) {
      let onDisconnect;
      let rejected = false;
      listeners.connect({ name: 'dashboard', sender: source, disconnect() { rejected = true; }, onDisconnect: { addListener(fn) { onDisconnect = fn; } } });
      return { rejected, close() { onDisconnect?.(); } };
    },
  };
}

test('worker rejects foreign senders, unexpected pages, frames, popup mutations and malformed messages', async () => {
  const w = await worker();
  const sources = [
    { ...sender(), id: 'other-extension' }, { ...sender(), url: 'https://example.test/' },
    { ...sender(), url: origin + 'dashboard.html?other' }, { ...sender(), frameId: 1 }, sender('popup'),
  ];
  for (const source of sources) {
    assert.equal((await w.message({ type: 'claimTab', tabId: 3 }, source)).ok, false);
    assert.equal(w.port(source).rejected, true);
  }
  for (const msg of [{ type: 'claimTab', tabId: -1 }, { type: 'claimTab', tabId: 1.5 }, { type: 'claimTab', tabId: 3, extra: true }, { type: 'removeRepeaterRule', ruleId: -1 }, { type: 'unknown' }, null]) {
    assert.equal((await w.message(msg)).ok, false);
  }
  assert.equal(w.session.dashboardTabId, undefined);
  assert.equal(w.updates, 0);
  assert.equal((await w.message({ type: 'getAutoStatus' }, sender('popup'))).on, false);
  assert.equal((await w.message({ type: 'claimTab', tabId: 3 })).ok, true);
  assert.equal(w.session.dashboardTabId, 3);
});

test('header rules reject broad scope, executable URLs, extra DNR actions and invalid values', async () => {
  const w = await worker();
  const invalid = [
    (r) => { r.id = 0; }, (r) => { r.priority = 2; },
    (r) => { r.condition.tabIds = [-1]; }, (r) => { r.condition.tabIds = [1, 3]; },
    (r) => { r.condition.resourceTypes = ['main_frame']; },
    (r) => { r.condition.urlFilter = 'https://example.test/*'; },
    (r) => { delete r.condition.urlFilter; r.condition.regexFilter = '^https://example\\.test/.*$'; },
    (r) => { r.condition.urlFilter = '|javascript:alert(1)|'; },
    (r) => { r.condition.initiatorDomains = ['example.test']; },
    (r) => { r.condition.requestMethods = ['get', 'post']; },
    (r) => { r.action.responseHeaders = [{ header: 'location', operation: 'remove' }]; },
    (r) => { r.action.requestHeaders[0].operation = 'append'; },
    (r) => { r.action.requestHeaders[0].header = 'authorization'; },
    (r) => { r.action.requestHeaders[0].value = 'bad\r\nInjected: value'; },
    (r) => { r.action.requestHeaders.push({ ...r.action.requestHeaders[0] }); },
  ];
  for (const mutate of invalid) {
    const rule = headerRule(); mutate(rule);
    const result = await w.message({ type: 'setRepeaterRule', rule });
    assert.equal(result.ok, false, JSON.stringify(rule));
  }
  assert.equal(w.updates, 0);
  assert.equal((await w.message({ type: 'setRepeaterRule', rule: headerRule() })).ok, true);
  assert.equal(w.rules.size, 1);
  const escaped = headerRule(1002);
  delete escaped.condition.urlFilter;
  escaped.condition.regexFilter = '^https:\\/\\/example\\.test\\/api\\?query=a\\|b\\*c$';
  assert.equal((await w.message({ type: 'setRepeaterRule', rule: escaped })).ok, true);
});

test('each dashboard can only remove its own rules and closing one leaves another rule installed', async () => {
  const w = await worker();
  const first = w.port(); w.port(sender('dashboard', 2));
  assert.equal((await w.message({ type: 'setRepeaterRule', rule: headerRule() })).ok, true);
  assert.equal((await w.message({ type: 'setRepeaterRule', rule: headerRule(1002, 2) }, sender('dashboard', 2))).ok, true);
  assert.equal((await w.message({ type: 'removeRepeaterRule', ruleId: 1001 }, sender('dashboard', 2))).ok, false);
  first.close(); await w.settle();
  assert.deepEqual([...w.rules.keys()], [1002]);
  assert.equal((await w.message({ type: 'removeRepeaterRule', ruleId: 1002 }, sender('dashboard', 2))).ok, true);
  assert.equal(w.rules.size, 0);
});

test('failed async storage operations reply with an error instead of leaving a message pending', async () => {
  const w = await worker();
  vm.runInContext("chrome.storage.session.set = async () => { throw new Error('fixture unavailable'); }", w.context);
  assert.deepEqual(await w.message({ type: 'claimTab', tabId: 3 }).then((value) => JSON.parse(JSON.stringify(value))), { ok: false, error: 'fixture unavailable' });
});

test('missing disclosure disables saved Auto without attaching and acceptance does not silently resume it', async () => {
  const w = await worker({ accepted: false, settings: { autoMode: true, autoScope: 'all', autoRules: [{ param: 'amount', value: '1' }] } });
  assert.equal(w.local.settings.autoMode, false);
  assert.equal(w.attachCount, 0);
  assert.equal((await w.message({ type: 'getAutoStatus' })).on, false);
  assert.equal((await w.message({ type: 'claimTab', tabId: 3 })).ok, false);
  assert.equal((await w.message({ type: 'setRepeaterRule', rule: headerRule() })).ok, false);
  w.setAccepted(true);
  w.listeners.storage({ localDataDisclosure: { newValue: { revision: 1 } } }, 'local');
  await w.settle();
  assert.equal(w.attachCount, 0);
  assert.equal((await w.message({ type: 'getAutoStatus' })).on, false);
});

test('revoked disclosure forwards paused traffic unchanged and detaches Auto', async () => {
  const w = await worker({ settings: { autoMode: true, autoScope: 'all', autoRules: [{ param: 'amount', value: '1' }] } });
  assert.equal(w.attachCount, 1);
  w.setAccepted(false);
  await vm.runInContext("onPaused({tabId:3}, {requestId:'fixture', request:{method:'GET',url:'https://example.test/api?amount=99',headers:{}}})", w.context);
  assert.deepEqual(JSON.parse(JSON.stringify(w.commands.at(-1).params)), { requestId: 'fixture' });
  w.listeners.storage({ localDataDisclosure: { newValue: undefined } }, 'local');
  await w.settle();
  assert.equal(w.local.settings.autoMode, false);
  assert.equal((await w.message({ type: 'getAutoStatus' })).attached.length, 0);
});

test('worker startup removes orphaned header rules while preserving a live dashboard owner', async () => {
  const session = { repeaterRuleIds: [1001, 1002, 1003], repeaterRuleOwners: { 1001: 1, 1002: 99 } };
  const w = await worker({ session });
  assert.deepEqual(Array.from(w.session.repeaterRuleIds), [1001]);
  assert.equal(w.updates, 2, 'closed owner and unowned legacy rule each removed');
  assert.equal((await w.message({ type: 'removeRepeaterRule', ruleId: 1001 }, sender('dashboard', 2))).ok, false);
  assert.equal((await w.message({ type: 'removeRepeaterRule', ruleId: 1001 })).ok, true);
});

test('worker startup discovers and cleans browser rules missing from session metadata', async () => {
  const w = await worker({ liveRules: [headerRule(1001)] });
  assert.deepEqual(Array.from(w.session.repeaterRuleIds), []);
  assert.equal(w.updates, 1);
});
