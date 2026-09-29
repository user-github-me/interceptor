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

importScripts('http.js');
/* global HTTP */

const S = { autoMode: false, autoScope: 'all', autoTabId: null, autoRules: [] };
const attached = new Set(); // tabIds this worker attached for Auto mode
let dashboardTabId = null;  // tab currently owned by the dashboard (excluded)
let autoCount = 0;

// ---- serial op queue (prevents attach/detach/claim races) ----
let opChain = Promise.resolve();
function serial(fn) {
  const run = opChain.then(fn, fn);
  opChain = run.then(() => {}, () => {});
  return run;
}

// ---- state ----
async function loadState() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const s = settings || {};
    S.autoMode = !!s.autoMode;
    S.autoScope = s.autoScope === 'tab' ? 'tab' : 'all';
    S.autoTabId = typeof s.autoTabId === 'number' ? s.autoTabId : null;
    S.autoRules = Array.isArray(s.autoRules)
      ? s.autoRules
      : (s.autoParam ? [{ param: String(s.autoParam), value: s.autoValue ?? '1' }] : []);
  } catch { /* keep current */ }
}

const names = () => S.autoRules.flatMap((r) => HTTP.splitNames(r && r.param));
const isOn = () => S.autoMode && names().length > 0;
const shouldHandle = (tabId) =>
  tabId !== dashboardTabId && (S.autoScope === 'all' || (S.autoScope === 'tab' && tabId === S.autoTabId));

function autoInScope(url) {
  if (!/^https?:/i.test(url)) return false;
  return !HTTP.isStatic('', url);
}

const cmd = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
const saveAttached = () => chrome.storage.session.set({ attachedTabs: [...attached] }).catch(() => {});
const saveCount = () => chrome.storage.session.set({ autoCount }).catch(() => {});

// Rebuild in-memory state after a worker restart (sessions persist; our Set does not).
let ready = serial(init);
async function init() {
  await loadState();
  try {
    const sess = await chrome.storage.session.get(['dashboardTabId', 'attachedTabs', 'autoCount']);
    dashboardTabId = sess.dashboardTabId ?? null;
    if (typeof sess.autoCount === 'number') autoCount = sess.autoCount;
    const targets = await chrome.debugger.getTargets();
    const live = new Set(targets.filter((t) => t.attached && t.tabId != null).map((t) => t.tabId));
    for (const id of (sess.attachedTabs || [])) if (live.has(id)) attached.add(id);
  } catch { /* ignore */ }
  await syncNow();
}

async function attachRaw(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // "already attached" by us after a race is fine; by the dashboard / gone → skip.
    if (!/already attached/i.test(e.message || '')) return;
  }
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
    if (isOn() && shouldHandle(id) && autoInScope(req.url)) {
      const rb = HTTP.requestBodyText(req);
      const textBody = rb.known ? rb.text : '';
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
        if (rb.known && HTTP.norm(mod.body) !== HTTP.norm(rb.text)) cont.postData = HTTP.utf8ToB64(mod.body);
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
  if (area === 'local' && changes.settings) sync();
  if (area === 'session' && changes.dashboardTabId) {
    serial(async () => { dashboardTabId = changes.dashboardTabId.newValue ?? null; await syncNow(); });
  }
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
      chrome.storage.local.set({ settings: { ...(settings || {}), autoMode: false, autoTabId: null } });
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ready;
    if (msg && msg.type === 'claimTab' && typeof msg.tabId === 'number') {
      // Serialize so any in-flight sync finishes first, then we release the tab
      // and mark it owned — a later sync will exclude it.
      await serial(async () => {
        dashboardTabId = msg.tabId;
        await chrome.storage.session.set({ dashboardTabId });
        await detachRaw(msg.tabId);
      });
      reply({ ok: true });
    } else if (msg && msg.type === 'releaseTab') {
      await serial(async () => {
        if (dashboardTabId === msg.tabId) {
          dashboardTabId = null;
          await chrome.storage.session.set({ dashboardTabId: null });
        }
        await syncNow();
      });
      reply({ ok: true });
    } else if (msg && msg.type === 'getAutoStatus') {
      await loadState();
      reply({ on: isOn(), scope: S.autoScope, tabId: S.autoTabId, count: autoCount, attached: [...attached] });
    } else {
      reply({});
    }
  })();
  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => { ready = serial(init); });
chrome.runtime.onStartup.addListener(() => { ready = serial(init); });
