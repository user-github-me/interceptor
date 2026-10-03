'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const HTTP = require('../http.js');

test('closing a dashboard while a header rule installs cleans it after installation', async () => {
  const listeners = {};
  const rules = new Map();
  const session = {};
  let releaseInstall;
  let installationStarted;
  const started = new Promise((resolve) => { installationStarted = resolve; });
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const origin = 'chrome-extension://fixture/';
  let tabOpen = true;
  const context = vm.createContext({ HTTP, importScripts: () => {}, chrome: {
    runtime: {
      getURL: (path) => origin + path,
      onConnect: event('connect'), onMessage: event('message'),
      onInstalled: event('installed'), onStartup: event('startup'),
      sendMessage: async () => {},
    },
    storage: {
      local: { get: async () => ({ settings: {} }) },
      session: { get: async () => session, set: async (data) => Object.assign(session, data) },
      onChanged: event('storage'),
    },
    debugger: {
      getTargets: async () => [], onEvent: event('debuggerEvent'), onDetach: event('detach'),
    },
    tabs: {
      query: async () => tabOpen ? [{ id: 1, url: origin + 'dashboard.html' }] : [],
      get: async () => { if (!tabOpen) throw new Error('Tab closed'); return { id: 1, url: origin + 'dashboard.html' }; },
      onCreated: event('created'), onUpdated: event('updated'), onRemoved: event('removed'),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    declarativeNetRequest: {
      updateSessionRules: async ({ removeRuleIds, addRules }) => {
        if (addRules?.length) {
          installationStarted();
          await new Promise((resolve) => { releaseInstall = resolve; });
        }
        for (const id of removeRuleIds || []) rules.delete(id);
        for (const rule of addRules || []) rules.set(rule.id, rule);
      },
    },
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../background.js'), 'utf8'), context);
  await vm.runInContext('ready', context);
  let disconnect;
  listeners.connect({ name: 'dashboard', onDisconnect: { addListener: (fn) => { disconnect = fn; } } });
  const response = new Promise((resolve) => listeners.message(
    { type: 'setRepeaterRule', rule: { id: 1001 } }, { tab: { id: 1 } }, resolve,
  ));
  await started;
  tabOpen = false;
  disconnect();
  releaseInstall();
  assert.equal((await response).ok, false);
  await vm.runInContext('repeaterChain', context);
  assert.equal(rules.size, 0);
  assert.deepEqual(Array.from(session.repeaterRuleIds), []);
});
