'use strict';
/* Background service worker: owns Auto mode.
 * It attaches the debugger to the target tab(s) automatically (no manual step),
 * rewrites the configured parameters on outgoing requests, and keeps working
 * across service-worker restarts (verified: debugger sessions survive idle).
 *
 * The dashboard page owns its own debugger session for manual intercept /
 * history / repeater. To avoid two clients on one tab, the dashboard "claims"
 * a tab before attaching; the worker leaves that tab to the dashboard. All
 * attach/detach/claim/release operations run through one serial queue so a
 * settings-triggered sync can't re-attach a tab the dashboard just claimed. */

importScripts('http.js', 'consent.js');
/* global HTTP, Disclosure */

const S = {
  autoMode: false,
  autoScope: 'all',
  autoTabId: null,
  autoRules: [],
  autoInclude: '',
  autoExclude: '',
};
const attached = new Set(); // tabIds this worker attached for Auto mode
const repeaterRuleIds = new Set(); // temporary DNR rules owned by an open dashboard
const repeaterRuleOwners = new Map(); // rule id -> dashboard tab id
let dashboardTabId = null;  // tab currently owned by the dashboard (excluded)
let autoCount = 0;
const dashboardPorts = new Map(); // open ports per dashboard tab
let disclosureAccepted = false;
let repeaterChain = Promise.resolve();
function serializeRepeater(fn) {
  const run = repeaterChain.then(fn, fn);
  repeaterChain = run.catch(() => {});
  return run;
}

// ---- serial op queue (prevents attach/detach/claim races) ----
let opChain = Promise.resolve();
function serial(fn) {
  const run = opChain.then(fn, fn);
  opChain = run.then(() => {}, () => {});
  return run;
}

// ---- state ----
async function loadState() {
  disclosureAccepted = await Disclosure.accepted();
  try {
    const [{ settings }, session] = await Promise.all([
      chrome.storage.local.get('settings'),
      chrome.storage.session.get('autoTabId'),
    ]);
    const s = settings || {};
    // An update or revoked disclosure must not restart a saved Auto session.
    S.autoMode = disclosureAccepted && !!s.autoMode;
    if (!disclosureAccepted && s.autoMode) {
      await chrome.storage.local.set({ settings: { ...s, autoMode: false } });
    }
    S.autoScope = s.autoScope === 'tab' ? 'tab' : 'all';
    S.autoTabId = typeof session.autoTabId === 'number' ? session.autoTabId : null;
    S.autoRules = Array.isArray(s.autoRules)
      ? s.autoRules
      : (s.autoParam ? [{ param: String(s.autoParam), value: s.autoValue ?? '1' }] : []);
    S.autoInclude = String(s.autoInclude || '');
    S.autoExclude = String(s.autoExclude || '');
  } catch { /* keep current */ }
}

const names = () => S.autoRules.flatMap((r) => HTTP.splitNames(r && r.param));
const scopeErrors = () => HTTP.urlInScope('https://interceptor.invalid/', S.autoInclude, S.autoExclude).errors;
const isOn = () => disclosureAccepted && S.autoMode && names().length > 0 && !scopeErrors().length && (S.autoScope === 'all' || S.autoTabId != null);
const shouldHandle = (tabId) =>
  tabId !== dashboardTabId && (S.autoScope === 'all' || (S.autoScope === 'tab' && tabId === S.autoTabId));

function autoInScope(url) {
  return !HTTP.isStatic('', url) && HTTP.urlInScope(url, S.autoInclude, S.autoExclude).allowed;
}

const cmd = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
const saveAttached = () => chrome.storage.session.set({ attachedTabs: [...attached] }).catch(() => {});
const saveCount = () => chrome.storage.session.set({ autoCount }).catch(() => {});

// Rebuild in-memory state after a worker restart (sessions persist; our Set does not).
let ready = serial(init);
async function init() {
  await loadState();
  try {
    const sess = await chrome.storage.session.get(['dashboardTabId', 'attachedTabs', 'autoCount', 'repeaterRuleIds', 'repeaterRuleOwners']);
    dashboardTabId = sess.dashboardTabId ?? null;
    if (typeof sess.autoCount === 'number') autoCount = sess.autoCount;
    const targets = await chrome.debugger.getTargets();
    const live = new Set(targets.filter((t) => t.attached && t.tabId != null).map((t) => t.tabId));
    for (const id of (sess.attachedTabs || [])) if (live.has(id)) attached.add(id);
    for (const id of (sess.repeaterRuleIds || [])) {
      if (!validRuleId(id)) continue;
      repeaterRuleIds.add(id);
      const owner = sess.repeaterRuleOwners?.[id];
      if (validTabId(owner)) repeaterRuleOwners.set(id, owner);
    }
  } catch { /* ignore */ }
  // Recover browser-installed rules even if the worker stopped before saving
  // their ownership metadata, or an older dashboard cleared that metadata.
  try {
    const liveRules = await chrome.declarativeNetRequest.getSessionRules();
    for (const rule of liveRules) if (validRuleId(rule.id)) repeaterRuleIds.add(rule.id);
  } catch { /* tracked rules can still be cleaned with existing metadata */ }
  // A dashboard may have closed while this worker was asleep.
  const dashboards = await chrome.tabs.query({ url: chrome.runtime.getURL('dashboard.html') });
  if (!dashboards.length) {
    dashboardTabId = null;
    await chrome.storage.session.set({ dashboardTabId: null });
    await clearRepeaterRules();
  } else {
    const liveDashboards = new Set(dashboards.map((tab) => tab.id));
    await serializeRepeater(async () => {
      for (const id of [...repeaterRuleIds]) {
        if (!disclosureAccepted || !liveDashboards.has(repeaterRuleOwners.get(id))) await removeRepeaterRuleNow(id);
      }
    });
  }
  await syncNow();
}

async function attachRaw(tabId) {
  if (attached.has(tabId) || !await Disclosure.accepted()) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch { return; }
  attached.add(tabId);
  saveAttached();
  try {
    await cmd(tabId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  } catch { /* tab may have closed */ }
}

async function detachRaw(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  saveAttached();
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

/** Attach/detach so the live set matches what Auto mode wants right now. */
async function syncNow() {
  await loadState();
  let want = new Set();
  if (isOn()) {
    if (S.autoScope === 'all') {
      try {
        const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
        want = new Set(tabs.map((t) => t.id));
      } catch { /* ignore */ }
    } else if (S.autoTabId != null) {
      want = new Set([S.autoTabId]);
    }
    want.delete(dashboardTabId);
  }
  for (const id of [...attached]) if (!want.has(id)) await detachRaw(id);
  for (const id of want) if (!attached.has(id)) await attachRaw(id);
  updateBadge();
}
const sync = () => serial(syncNow);

function updateBadge() {
  const on = isOn() && attached.size > 0;
  chrome.action.setBadgeText({ text: on ? 'ON' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#ff7a1a' }).catch(() => {});
}

// ---- request rewriting ----
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.sessionId) return; // only top-level sessions
  if (method === 'Fetch.requestPaused') onPaused(source, params);
});

async function onPaused(source, params) {
  await ready;
  const id = source.tabId;
  if (id == null || id === dashboardTabId) return; // dashboard handles its own tab
  const req = params.request;
  try {
    // Recheck the persisted choice before handling traffic, including revocation
    // while a storage-change sync is queued behind another debugger operation.
    if (isOn() && await Disclosure.accepted() && shouldHandle(id) && autoInScope(req.url)) {
      const rb = HTTP.requestBodyText(req);
      const canRewriteBody = rb.known && rb.text.length <= 750_000;
      const textBody = canRewriteBody ? rb.text : '';
      const mod = HTTP.applyParamRules(
        { method: req.method, url: req.url, headers: req.headers, body: textBody },
        S.autoRules,
      );
      if (mod.changes.length) {
        const cont = {
          requestId: params.requestId,
          url: mod.url,
          method: req.method,
          headers: HTTP.headersToList(req.headers).filter((h) => h.name.toLowerCase() !== 'content-length'),
        };
        if (canRewriteBody && HTTP.norm(mod.body) !== HTTP.norm(rb.text)) cont.postData = HTTP.utf8ToB64(mod.body);
        await cmd(id, 'Fetch.continueRequest', cont);
        autoCount++;
        saveCount();
        broadcast(req.method, mod, id);
        updateBadge();
        return;
      }
    }
  } catch (e) {
    // fall through to a plain continue so the request never hangs
  }
  try { await cmd(id, 'Fetch.continueRequest', { requestId: params.requestId }); } catch { /* gone */ }
}

function broadcast(method, mod, tabId) {
  chrome.runtime.sendMessage({
    type: 'autoRewrite',
    entry: { method, url: mod.url, changes: mod.changes, tabId, count: autoCount },
  }).catch(() => {});
}

function saveRepeaterRules() {
  return chrome.storage.session.set({
    repeaterRuleIds: [...repeaterRuleIds], repeaterRuleOwners: Object.fromEntries(repeaterRuleOwners),
  }).catch(() => {});
}

async function removeRepeaterRuleNow(id) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  repeaterRuleIds.delete(id);
  repeaterRuleOwners.delete(id);
  await saveRepeaterRules();
}

function clearRepeaterRules() {
  return serializeRepeater(clearRepeaterRulesNow);
}
async function clearRepeaterRulesNow() {
  const ids = [...repeaterRuleIds];
  if (ids.length) {
    try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }); }
    catch { return; } // keep ownership so a later cleanup/restart can retry
  }
  repeaterRuleIds.clear();
  repeaterRuleOwners.clear();
  await saveRepeaterRules();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dashboard' || senderPage(port.sender) !== 'dashboard' || !validTabId(port.sender.tab?.id)) {
    port.disconnect();
    return;
  }
  const tabId = port.sender.tab.id;
  dashboardPorts.set(tabId, (dashboardPorts.get(tabId) || 0) + 1);
  port.onDisconnect.addListener(() => {
    const remaining = (dashboardPorts.get(tabId) || 1) - 1;
    if (remaining) dashboardPorts.set(tabId, remaining);
    else {
      dashboardPorts.delete(tabId);
      serializeRepeater(async () => {
        for (const [id, owner] of repeaterRuleOwners) if (owner === tabId) await removeRepeaterRuleNow(id);
      }).catch(() => {}); // retained ownership allows startup cleanup to retry
    }
  });
});

// ---- lifecycle & coordination ----
chrome.debugger.onDetach.addListener((source, reason) => {
  const id = source.tabId;
  if (id == null || !attached.has(id)) return;
  attached.delete(id);
  saveAttached();
  updateBadge();
  // If the user hit "Cancel" on the debugging banner, respect it: turn Auto mode off.
  if (reason === 'canceled_by_user') {
    serial(async () => {
      S.autoMode = false;
      try {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...(settings || {}), autoMode: false } });
      } catch { /* ignore */ }
      await syncNow();
    });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.settings || changes.localDataDisclosure)) {
    serial(async () => {
      await syncNow();
      if (!disclosureAccepted) await clearRepeaterRules();
    });
  }
  if (area === 'session' && changes.dashboardTabId) {
    serial(async () => { dashboardTabId = changes.dashboardTabId.newValue ?? null; await syncNow(); });
  }
  if (area === 'session' && changes.autoTabId) sync();
});

const maybeAttach = (tabId) => serial(async () => {
  if (isOn() && shouldHandle(tabId) && !attached.has(tabId)) await attachRaw(tabId);
});
chrome.tabs.onCreated.addListener((tab) => { if (tab.id != null) maybeAttach(tab.id); });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') maybeAttach(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => {
  if (attached.delete(tabId)) saveAttached();
  if (S.autoScope === 'tab' && S.autoTabId === tabId) {
    chrome.storage.local.get('settings').then(({ settings }) => {
      chrome.storage.session.set({ autoTabId: null }).catch(() => {});
      chrome.storage.local.set({ settings: { ...(settings || {}), autoMode: false } });
    }).catch(() => {});
  }
});

const validTabId = (id) => Number.isSafeInteger(id) && id > 0;
const validRuleId = (id) => Number.isSafeInteger(id) && id >= 1000 && id <= 100999;
function senderPage(sender) {
  if (sender?.id !== chrome.runtime.id || (sender.frameId != null && sender.frameId !== 0)) return null;
  for (const page of ['dashboard', 'popup']) {
    if (sender.url === chrome.runtime.getURL(`${page}.html`)) return page;
  }
  return null;
}
function exactKeys(value, required, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
const REQUEST_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'connect']);
const SET_HEADERS = new Set(['cookie', 'origin', 'referer', 'user-agent', 'accept-encoding', 'dnt', 'date', 'via', 'accept-charset', 'access-control-request-headers', 'access-control-request-method']);
const REMOVE_HEADERS = new Set(['cookie', 'origin', 'referer', 'user-agent', 'accept-language', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
const escapeRuleUrl = (url) => url.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

/** Accept only the per-request header rule the dashboard generates. */
function validateRepeaterRule(rule, tabId) {
  if (!exactKeys(rule, ['id', 'priority', 'action', 'condition']) || !validRuleId(rule.id) || rule.priority !== 1) {
    throw new Error('Invalid temporary header rule.');
  }
  const { action, condition } = rule;
  if (!exactKeys(action, ['type', 'requestHeaders']) || action.type !== 'modifyHeaders'
      || !Array.isArray(action.requestHeaders) || !action.requestHeaders.length || action.requestHeaders.length > 256) {
    throw new Error('Only request header changes are allowed.');
  }
  const usedHeaders = new Set();
  for (const header of action.requestHeaders) {
    if (!exactKeys(header, ['header', 'operation'], ['value']) || typeof header.header !== 'string'
        || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(header.header) || usedHeaders.has(header.header)) {
      throw new Error('Invalid or duplicate request header.');
    }
    usedHeaders.add(header.header);
    if (header.operation === 'set') {
      if (!(SET_HEADERS.has(header.header) || header.header.startsWith('sec-') || header.header.startsWith('proxy-'))
          || typeof header.value !== 'string' || header.value.length > 500_000 || /[\r\n\0]/.test(header.value)) {
        throw new Error('Invalid request header override.');
      }
    } else if (header.operation !== 'remove' || !REMOVE_HEADERS.has(header.header) || 'value' in header) {
      throw new Error('Invalid request header removal.');
    }
  }
  if (!exactKeys(condition, ['tabIds', 'resourceTypes'], ['requestMethods', 'urlFilter', 'regexFilter'])
      || !Array.isArray(condition.tabIds) || condition.tabIds.length !== 1 || condition.tabIds[0] !== tabId
      || !Array.isArray(condition.resourceTypes) || condition.resourceTypes.length !== 1 || condition.resourceTypes[0] !== 'xmlhttprequest'
      || ('urlFilter' in condition) === ('regexFilter' in condition)) {
    throw new Error('Header rules must target this dashboard request only.');
  }
  if ('requestMethods' in condition && (!Array.isArray(condition.requestMethods) || condition.requestMethods.length !== 1
      || !REQUEST_METHODS.has(condition.requestMethods[0]))) throw new Error('Invalid request method scope.');
  let url;
  if ('urlFilter' in condition) {
    if (typeof condition.urlFilter !== 'string' || !condition.urlFilter.startsWith('|') || !condition.urlFilter.endsWith('|')) {
      throw new Error('Header rules require an exact request URL.');
    }
    url = condition.urlFilter.slice(1, -1);
    if (/[*^|]/.test(url)) throw new Error('Header rules cannot match URL patterns.');
  } else {
    if (typeof condition.regexFilter !== 'string' || !condition.regexFilter.startsWith('^') || !condition.regexFilter.endsWith('$')) {
      throw new Error('Header rules require an exact request URL.');
    }
    url = condition.regexFilter.slice(1, -1).replace(/\\(.)/g, '$1');
    if (condition.regexFilter !== '^' + escapeRuleUrl(url) + '$') throw new Error('Header rules cannot match URL patterns.');
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid header rule URL.'); }
  if (url.length > 200_000 || !/^https?:$/.test(parsed.protocol) || parsed.href !== url) {
    throw new Error('Header rules require an HTTP(S) request URL.');
  }
}

const MESSAGE_KEYS = {
  claimTab: ['type', 'tabId'], releaseTab: ['type', 'tabId'], getAutoStatus: ['type'],
  setRepeaterRule: ['type', 'rule'], removeRepeaterRule: ['type', 'ruleId'],
  incrementAutoCount: ['type'], resetAutoCount: ['type'],
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const page = senderPage(sender);
    const keys = MESSAGE_KEYS[msg?.type];
    if (!page || !keys || !exactKeys(msg, keys) || (msg.type !== 'getAutoStatus' && (page !== 'dashboard' || !validTabId(sender.tab?.id)))) {
      throw new Error('This action is restricted to Interceptor pages.');
    }
    if (['claimTab', 'releaseTab'].includes(msg.type) && !validTabId(msg.tabId)) throw new Error('Invalid target tab.');
    if (msg.type === 'removeRepeaterRule' && !validRuleId(msg.ruleId)) throw new Error('Invalid temporary header rule.');
    await ready;
    if (['claimTab', 'setRepeaterRule', 'incrementAutoCount'].includes(msg.type) && !await Disclosure.accepted()) {
      throw new Error('Review and accept local data handling before starting a test.');
    }
    if (msg.type === 'claimTab') {
      // Serialize so any in-flight sync finishes first, then we release the tab
      // and mark it owned — a later sync will exclude it.
      await serial(async () => {
        dashboardTabId = msg.tabId;
        await chrome.storage.session.set({ dashboardTabId });
        await detachRaw(msg.tabId);
      });
      reply({ ok: true });
    } else if (msg.type === 'releaseTab') {
      await serial(async () => {
        if (dashboardTabId === msg.tabId) {
          dashboardTabId = null;
          await chrome.storage.session.set({ dashboardTabId: null });
        }
        await syncNow();
      });
      reply({ ok: true });
    } else if (msg.type === 'getAutoStatus') {
      await loadState();
      reply({
        on: isOn(), scope: S.autoScope, tabId: S.autoTabId, count: autoCount,
        attached: [...attached], include: S.autoInclude, exclude: S.autoExclude, scopeErrors: scopeErrors(),
      });
    } else if (msg.type === 'setRepeaterRule') {
      try {
        await serializeRepeater(async () => {
          const tabId = sender.tab.id;
          validateRepeaterRule(msg.rule, tabId);
          const previousOwner = repeaterRuleOwners.get(msg.rule.id);
          if (previousOwner != null && previousOwner !== tabId) throw new Error('Header rule belongs to another dashboard.');
          const tab = await chrome.tabs.get(tabId);
          if (tab?.url !== chrome.runtime.getURL('dashboard.html')) throw new Error('Repeater dashboard is closed.');
          repeaterRuleIds.add(msg.rule.id);
          repeaterRuleOwners.set(msg.rule.id, tabId);
          await saveRepeaterRules();
          await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [msg.rule.id], addRules: [msg.rule] });
          // A close event can arrive while the browser installs the rule.
          try {
            const live = await chrome.tabs.get(tabId);
            if (live.url !== chrome.runtime.getURL('dashboard.html') || !await Disclosure.accepted()) throw new Error('Dashboard unavailable.');
          }
          catch {
            await removeRepeaterRuleNow(msg.rule.id);
            throw new Error('Repeater dashboard is closed.');
          }
        });
        reply({ ok: true });
      } catch (error) { reply({ ok: false, error: error.message }); }
    } else if (msg.type === 'removeRepeaterRule') {
      await serializeRepeater(async () => {
        const owner = repeaterRuleOwners.get(msg.ruleId);
        if (owner != null && owner !== sender.tab.id) throw new Error('Header rule belongs to another dashboard.');
        // Removing a missing own rule is safe and supports failure cleanup.
        if (owner != null) await removeRepeaterRuleNow(msg.ruleId);
      });
      reply({ ok: true });
    } else if (msg.type === 'incrementAutoCount') {
      autoCount++;
      await saveCount();
      reply({ ok: true, count: autoCount });
    } else if (msg.type === 'resetAutoCount') {
      autoCount = 0;
      await saveCount();
      reply({ ok: true, count: autoCount });
    } else {
      reply({});
    }
  })().catch((error) => reply({ ok: false, error: error.message }));
  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => { ready = serial(init); });
chrome.runtime.onStartup.addListener(() => { ready = serial(init); });
