'use strict';
/* global HTTP, Workbench, Workflow, Lab, workflowState, bindWorkflow, renderSiteMap, renderCollections, renderInspector, renderRunner, workspaceVariableText, labState, bindLab, queueLocalSave, renderAssertionResults, renderSecurity, renderWorkspace, renderWebSockets, captureWebSocket */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let dashboardPort;
let closingDashboard = false;
function connectDashboard() {
  dashboardPort = chrome.runtime.connect({ name: 'dashboard' });
  dashboardPort.onDisconnect.addListener(() => {
    if (!closingDashboard) setTimeout(connectDashboard, 250);
  });
}
connectDashboard();

const MAX_HISTORY = 2500;
const MAX_BODY_CHARS = 750_000;         // characters kept per captured body
const MAX_HISTORY_CHARS = 64_000_000;   // approximate total text budget
const MAX_REPEATER_BYTES = 4_000_000;
const MAX_DISPLAY_CHARS = 1_000_000;    // bodies rendered in <pre>
const STATIC_TYPES = new Set(['Image', 'Font', 'Stylesheet', 'Media']);
const STATIC_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|css|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|map)$/i;
const STD_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT'];

const state = {
  tabId: null,
  attached: false,
  settings: {
    requests: true, responses: false, skipStatic: true, filter: '',
    disableCache: false, historyHideStatic: false, historySearchContent: true,
    prettyJson: true, repPretty: true, repRemember: true, comparePretty: true,
    autoMode: false, autoRules: [{ param: HTTP.DEFAULT_PARAMS, value: '1' }],
    autoInclude: '', autoExclude: '',
  },
  interceptOn: false,
  queue: [],                 // paused Fetch items
  selectedQueueId: null,
  forceResponse: new Set(),  // Fetch requestIds whose response we want to pause
  history: [],
  selectedHistoryId: null,
  autoLog: [],               // auto-mode rewrites
  autoCount: 0,
  seq: 0,
  repeaters: [],
  activeRepeaterId: null,
  repSeq: 0,
  compare: { left: '', right: '', leftLabel: '', rightLabel: '', unified: '' },
};

// ======================================================================
// Utilities
// ======================================================================
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

let toastTimer;
function toast(msg, kind = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), kind === 'error' ? 5000 : 2200);
}

function fmtSize(n) {
  if (n == null || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

function limitBody(text, label = 'body') {
  text = String(text || '');
  if (text.length <= MAX_BODY_CHARS) return text;
  return text.slice(0, MAX_BODY_CHARS) + `\n[… ${label} truncated; ${fmtSize(text.length)} total]`;
}

function entryChars(entry) {
  const headers = [...(entry.reqHeaders || []), ...(entry.resHeaders || [])]
    .reduce((n, h) => n + String(h.name).length + String(h.value).length, 0);
  return headers + String(entry.url || '').length + String(entry.reqBody || '').length + String(entry.resBody || '').length;
}

function pruneHistory() {
  let total = 0;
  let keepFrom = state.history.length;
  for (let i = state.history.length - 1; i >= 0; i--) {
    total += entryChars(state.history[i]);
    if (total > MAX_HISTORY_CHARS || state.history.length - i > MAX_HISTORY) break;
    keepFrom = i;
  }
  if (keepFrom > 0) {
    const removed = state.history.splice(0, keepFrom);
    for (const entry of removed) {
      if (netMap.get(entry.requestId) === entry) netMap.delete(entry.requestId);
    }
    if (removed.some((e) => e.id === state.selectedHistoryId)) state.selectedHistoryId = null;
  }
}

async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch (e) {
    toast(`Copy failed: ${e.message}`, 'error');
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname + u.search;
  } catch {
    return url;
  }
}

function isStatic(type, url) {
  if (STATIC_TYPES.has(type)) return true;
  try { return STATIC_EXT.test(new URL(url).pathname); } catch { return false; }
}

/** Text filter: plain substring (case-insensitive) or /regex/flags. */
function compileMatcher(str) {
  const s = (str || '').trim();
  if (!s) return { test: () => true, valid: true };
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(s);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2].replace(/[gy]/g, ''));
      return { test: (v) => re.test(v), valid: true };
    } catch { /* fall through to substring */ }
    return { test: (v) => v.toLowerCase().includes(s.toLowerCase()), valid: false };
  }
  return { test: (v) => v.toLowerCase().includes(s.toLowerCase()), valid: true };
}

function highlightHttp(text) {
  let note = '';
  if (text.length > MAX_DISPLAY_CHARS) {
    note = `\n\n[… truncated for display: ${fmtSize(text.length)} total. Use "Copy" to get everything.]`;
    text = text.slice(0, MAX_DISPLAY_CHARS);
  }
  const idx = text.indexOf('\n\n');
  const head = idx < 0 ? text : text.slice(0, idx);
  const lines = head.split('\n');
  let html = `<span class="h-first">${escapeHtml(lines[0])}</span>`;
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    html += '\n' + (i > 0 ? `<span class="h-name">${escapeHtml(l.slice(0, i))}</span>:${escapeHtml(l.slice(i + 1))}` : escapeHtml(l));
  }
  if (idx >= 0) html += '\n\n' + escapeHtml(text.slice(idx + 2));
  if (note) html += `<span class="h-note">${escapeHtml(note)}</span>`;
  return html;
}

function setRaw(pre, text) {
  pre.innerHTML = text ? highlightHttp(text) : '';
}

/** Body of a CDP Network.Request / Fetch request. */
function requestBodyFromCdp(req) {
  if (req.postDataEntries && req.postDataEntries.length) {
    const complete = req.postDataEntries.every((e) => typeof e.bytes === 'string');
    const bytes = HTTP.concatBytes(req.postDataEntries.map((e) => (e.bytes ? HTTP.b64ToBytes(e.bytes) : new Uint8Array())));
    const d = HTTP.decodeBody(bytes);
    if (d.binary) return { text: '', known: false, binary: true, size: d.size };
    return { text: complete ? d.text : '', known: complete, binary: false };
  }
  if (typeof req.postData === 'string') return { text: req.postData, known: true, binary: false };
  return { text: '', known: !req.hasPostData, binary: false };
}

// ======================================================================
// Settings persistence
// ======================================================================
/** Bring an older stored `settings` object up to the current shape. */
function normalizeSettings(s) {
  if (!s) return;
  if (!Array.isArray(s.autoRules)) {
    // Migrate the old single-parameter format.
    s.autoRules = s.autoParam
      ? [{ param: String(s.autoParam), value: s.autoValue ?? '1' }]
      : [{ param: HTTP.DEFAULT_PARAMS, value: '1' }];
  }
  if (s.autoScope !== 'tab' && s.autoScope !== 'all') s.autoScope = 'all';
  s.autoInclude = String(s.autoInclude || '');
  s.autoExclude = String(s.autoExclude || '');
  delete s.autoParam;
  delete s.autoValue;
}

async function loadSettings() {
  try {
    const [{ settings }, session] = await Promise.all([
      chrome.storage.local.get('settings'),
      chrome.storage.session.get('autoTabId'),
    ]);
    normalizeSettings(settings);
    Object.assign(state.settings, settings || {});
    state.settings.autoTabId = typeof session.autoTabId === 'number' ? session.autoTabId : null;
    if (state.settings.autoScope === 'tab' && state.settings.autoTabId == null) state.settings.autoMode = false;
  } catch { /* defaults */ }
}
function saveSettings() {
  queueLocalSave();
  const settings = { ...state.settings };
  delete settings.autoTabId;
  chrome.storage.local.set({ settings }).catch(() => {});
}

// ======================================================================
// Debugger / CDP plumbing
// ======================================================================
function cdp(method, params = {}) {
  if (!state.attached) return Promise.reject(new Error('Not attached'));
  return chrome.debugger.sendCommand({ tabId: state.tabId }, method, params);
}

async function refreshTabs() {
  const sel = $('#tabSelect');
  const prev = sel.value;
  const tabs = await chrome.tabs.query({});
  const usable = tabs.filter((t) => /^(https?|file):/i.test(t.url || t.pendingUrl || ''));
  sel.innerHTML = '';
  if (!usable.length) {
    const o = document.createElement('option');
    o.textContent = 'No web tabs open — open your app in another tab';
    o.value = '';
    sel.append(o);
    return;
  }
  usable.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const t of usable) {
    const o = document.createElement('option');
    o.value = String(t.id);
    const url = t.url || t.pendingUrl;
    o.textContent = `${(t.title || url).slice(0, 60)}  —  ${shortUrl(url).slice(0, 80)}`;
    sel.append(o);
  }
  const want = state.attached ? String(state.tabId) : prev;
  if (want && usable.some((t) => String(t.id) === want)) sel.value = want;
}

/** Ask the background worker to release a tab from Auto mode before we attach. */
async function claimTab(tabId) {
  try { await chrome.storage.session.set({ dashboardTabId: tabId }); } catch { /* ignore */ }
  try { await chrome.runtime.sendMessage({ type: 'claimTab', tabId }); } catch { /* worker asleep; storage change covers it */ }
}
async function releaseTab(tabId) {
  try { await chrome.storage.session.set({ dashboardTabId: null }); } catch { /* ignore */ }
  try { await chrome.runtime.sendMessage({ type: 'releaseTab', tabId }); } catch { /* ignore */ }
}

/** Turn Chrome's terse debugger errors into something actionable. */
function attachErrorMessage(msg, host) {
  if (/already attached|Another debugger/i.test(msg)) {
    return 'Another debugger is already on this tab. Close its DevTools (F12) or any other debugging extension, then try again.';
  }
  if (/different extension|chrome-extension|Cannot access|Cannot attach/i.test(msg)) {
    return `Chrome won't let Interceptor attach to this tab: another extension has put its own page here — a redirect, or an injected iframe/overlay (common on payment pages). Disable other extensions for ${host || 'this site'}, or use a clean browser profile with only Interceptor, then Attach again.`;
  }
  return `Could not attach: ${msg}`;
}

async function attach() {
  const tabId = Number($('#tabSelect').value);
  if (!tabId) return toast('Pick a tab to attach to first.', 'error');
  // Re-read the tab's CURRENT url — it may have navigated/redirected since the list was built.
  let liveTab;
  try { liveTab = await chrome.tabs.get(tabId); }
  catch { await refreshTabs(); return toast('That tab is gone — I refreshed the list. Pick your site tab again.', 'error'); }
  const liveUrl = liveTab.url || liveTab.pendingUrl || '';
  let liveHost = '';
  try { liveHost = new URL(liveUrl).host; } catch { /* ignore */ }
  if (!/^https?:|^file:/i.test(liveUrl)) {
    await refreshTabs();
    return toast(
      'That tab is not a normal web page right now (it may have been redirected by another extension to a chrome-extension/chrome page). Reload your site in the tab, then pick it again.',
      'error',
    );
  }
  await claimTab(tabId); // hand the tab off from Auto mode so there's no debugger conflict
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    await releaseTab(tabId);
    return toast(attachErrorMessage(e.message, liveHost), 'error');
  }
  state.tabId = tabId;
  state.attached = true;
  try {
    const tab = await chrome.tabs.get(tabId);
    state.attachedHost = new URL(tab.url || tab.pendingUrl).host;
  } catch { state.attachedHost = ''; }
  try {
    await cdp('Network.enable', { maxPostDataSize: 20 * 1024 * 1024 });
    await cdp('Network.setCacheDisabled', { cacheDisabled: state.settings.disableCache });
    await applyFetch();
    toast('Attached. Traffic from this tab is now recorded.');
  } catch (e) {
    toast(`Attached, but setup failed: ${e.message}`, 'error');
  }
  updateStatus();
}

async function detach() {
  if (!state.attached) return;
  const tabId = state.tabId;
  await releaseAll(false);
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
  onDetached();
}

function onDetached(reason) {
  const tabId = state.tabId;
  state.attached = false;
  state.queue = [];
  state.selectedQueueId = null;
  state.forceResponse.clear();
  netMap.clear();
  if (tabId != null) releaseTab(tabId); // let Auto mode reclaim the tab
  renderQueue();
  loadEditor();
  updateStatus();
  if (reason === 'canceled_by_user') toast('Debugging was cancelled from the browser bar — detached.', 'error');
  else if (reason === 'target_closed') toast('Target tab was closed — detached.', 'error');
  else if (reason) toast(`Detached (${reason}).`);
}

function updateStatus() {
  const pill = $('#status');
  const btn = $('#attachBtn');
  $('#tabSelect').disabled = state.attached;
  $('#reloadTabBtn').disabled = !state.attached;
  btn.textContent = state.attached ? 'Detach' : 'Attach';
  btn.classList.toggle('primary', !state.attached);
  if (!state.attached) {
    pill.className = 'pill off';
    pill.textContent = 'Not attached';
  } else if (state.interceptOn) {
    pill.className = 'pill hot';
    pill.textContent = 'Attached · intercepting';
  } else {
    pill.className = 'pill on';
    pill.textContent = 'Attached · recording';
  }
  const t = $('#interceptToggle');
  t.textContent = state.interceptOn ? 'Intercept is ON' : 'Intercept is OFF';
  t.classList.toggle('on', state.interceptOn);

  const bar = $('#autoBar');
  if (autoModeOn()) {
    bar.classList.remove('hidden');
    const scope = state.settings.autoScope === 'tab' ? 'this-tab-only' : 'all tabs';
    const here = state.attached && !autoActive() ? ' · not this tab (handled per-tab scope)' : '';
    $('#autoBarText').textContent = `Auto mode ON (${scope}) — ${autoRuleSummary()} · ${state.autoCount} rewritten${here}`;
  } else {
    bar.classList.add('hidden');
  }

  // Publish attach state so the popup can show it.
  chrome.storage.session.set({ attachedTabId: state.attached, attachedHost: state.attachedHost || '' }).catch(() => {});
}

/** Enable/disable Fetch interception according to the current settings.
 * Calls are serialized so a stale Fetch.disable can't land after a newer Fetch.enable. */
let fetchChain = Promise.resolve();
function applyFetch() {
  const run = fetchChain.then(applyFetchNow);
  fetchChain = run.catch(() => {});
  return run;
}
async function applyFetchNow() {
  if (!state.attached) return;
  const patterns = [];
  // Enable the request stage for manual capture OR for Auto mode (independently),
  // so Auto mode keeps working even when "Capture requests" is off.
  if ((state.interceptOn && state.settings.requests) || autoActive()) {
    patterns.push({ urlPattern: '*', requestStage: 'Request' });
  }
  if (state.interceptOn && state.settings.responses) {
    patterns.push({ urlPattern: '*', requestStage: 'Response' });
  }
  if (patterns.length) {
    await cdp('Fetch.enable', { patterns });
  } else {
    await releaseAll(true);
    await cdp('Fetch.disable').catch(() => {});
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!state.attached || source.tabId !== state.tabId || source.sessionId) return;
  switch (method) {
    case 'Network.webSocketCreated':
    case 'Network.webSocketClosed':
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': captureWebSocket(method, params); break;
    case 'Fetch.requestPaused': onRequestPaused(params); break;
    case 'Network.requestWillBeSent': onRequestWillBeSent(params); break;
    case 'Network.requestWillBeSentExtraInfo': onRequestExtra(params); break;
    case 'Network.responseReceived': onResponseReceived(params); break;
    case 'Network.responseReceivedExtraInfo': onResponseExtra(params); break;
    case 'Network.loadingFinished': onLoadingFinished(params); break;
    case 'Network.loadingFailed': onLoadingFailed(params); break;
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (state.attached && source.tabId === state.tabId) onDetached(reason);
});

// ======================================================================
// Intercept (Fetch domain)
// ======================================================================
function inScope(url, type) {
  if (/^(data|blob|chrome-extension|about):/i.test(url)) return false;
  if (state.settings.skipStatic && isStatic(type, url)) return false;
  return compileMatcher(state.settings.filter).test(url);
}

function continuePlain(requestId) {
  return cdp('Fetch.continueRequest', { requestId }).catch(() => {});
}

const autoNames = () => (state.settings.autoRules || []).flatMap((r) => HTTP.splitNames(r.param));
const autoModeOn = () => !!(
  state.settings.autoMode && autoNames().length &&
  !HTTP.urlInScope('https://interceptor.invalid/', state.settings.autoInclude, state.settings.autoExclude).errors.length
);
// Whether Auto mode applies to the tab THIS dashboard is attached to.
function autoActive() {
  if (!autoModeOn()) return false;
  if ((state.settings.autoScope === 'tab' ? 'tab' : 'all') === 'all') return true;
  return state.settings.autoTabId === state.tabId;
}
function autoInScope(url, type) {
  if (/^(data|blob|chrome-extension|about):/i.test(url)) return false;
  return !isStatic(type, url) && HTTP.urlInScope(url, state.settings.autoInclude, state.settings.autoExclude).allowed;
}
function autoRuleSummary() {
  const parts = (state.settings.autoRules || []).map((r) => {
    const names = HTTP.splitNames(r.param);
    if (!names.length) return '';
    const shown = names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
    return `${shown} → ${r.value}`;
  }).filter(Boolean);
  const includeCount = HTTP.splitPatterns(state.settings.autoInclude).length;
  const excludeCount = HTTP.splitPatterns(state.settings.autoExclude).length;
  const scope = includeCount || excludeCount
    ? ` · URL scope ${includeCount || 'all'} include / ${excludeCount} exclude`
    : '';
  return `forcing ${parts.join('  ;  ') || '(nothing)'}${scope}`;
}

async function onRequestPaused(p) {
  const isResponse = 'responseStatusCode' in p || 'responseErrorReason' in p;
  const forced = isResponse && state.forceResponse.delete(p.requestId);
  const req = p.request;

  let manualWant;
  if (!state.interceptOn) manualWant = false;
  else if (isResponse) {
    const ct = HTTP.getHeader(HTTP.headersToList(p.responseHeaders), 'content-type') || '';
    const streaming = /text\/event-stream/i.test(ct) || p.resourceType === 'EventSource' || p.resourceType === 'WebSocket';
    manualWant = !p.responseErrorReason && !streaming && (forced || (state.settings.responses && inScope(req.url, p.resourceType)));
  } else {
    manualWant = state.settings.requests && inScope(req.url, p.resourceType);
  }

  // Auto mode: rewrite the configured parameter on requests.
  let mod = null;
  const reqBody = requestBodyFromCdp(req);
  const reqBodyTooLarge = reqBody.text.length > MAX_BODY_CHARS;
  if (!isResponse && autoActive() && autoInScope(req.url, p.resourceType)) {
    try {
      const textBody = reqBody.binary || !reqBody.known || reqBodyTooLarge ? '' : reqBody.text;
      const m = HTTP.applyParamRules(
        { method: req.method, url: req.url, headers: req.headers, body: textBody },
        state.settings.autoRules,
      );
      if (m.changes.length) mod = m;
    } catch (e) {
      console.warn('auto rule failed, passing request through:', e);
    }
  }

  // Not wanted by manual intercept: auto-forward (with rewrite if any) or pass through.
  if (!manualWant) {
    if (mod) return autoForward(p, req, reqBody, mod);
    return continuePlain(p.requestId);
  }

  const item = {
    id: p.requestId,
    networkId: p.networkId,
    stage: isResponse ? 'response' : 'request',
    method: req.method,
    url: req.url,
    resourceType: p.resourceType,
    warn: '',
    autoNote: '',
  };
  const historyRequest = isResponse ? netMap.get(p.networkId) : null;
  const editableBody = reqBody.known && !reqBody.binary && !reqBodyTooLarge && reqBody.text
    ? reqBody.text
    : isResponse && historyRequest && !/^\[binary request body/.test(historyRequest.reqBody || '') && !/\[… request body truncated/.test(historyRequest.reqBody || '')
      ? historyRequest.reqBody : '';
  item.requestRaw = HTTP.serializeRequest({
    method: req.method,
    url: req.url,
    headers: historyRequest ? historyRequest.reqHeaders : req.headers,
    body: editableBody || '',
  });

  if (!isResponse) {
    item.originalBody = editableBody;
    if (reqBody.binary) item.warn = `Request body is binary (${fmtSize(reqBody.size)}) and is not shown. Leave the body empty to send the original bytes unchanged.`;
    else if (reqBodyTooLarge) item.warn = `Request body exceeds ${fmtSize(MAX_BODY_CHARS)} and is not shown. Leave the body empty to send the original bytes unchanged.`;
    else if (!reqBody.known) item.warn = 'Request body is not fully available (large upload / file). Leave the body empty to send the original body unchanged.';
    item.originalRaw = item.requestRaw;
    // Pre-fill the auto-rewrite so the paused request already shows the tampered value.
    if (mod) {
      item.autoRaw = HTTP.serializeRequest({ method: req.method, url: mod.url, headers: req.headers, body: reqBody.binary || !reqBody.known || reqBodyTooLarge ? '' : mod.body });
      item.autoNote = `Auto mode pre-applied: ${describeChanges(mod.changes)}`;
    }
  } else {
    item.status = p.responseStatusCode;
    let bodyText = '';
    item.originalBodyB64 = null;
    try {
      const r = await cdp('Fetch.getResponseBody', { requestId: p.requestId });
      if (r.body.length > MAX_BODY_CHARS * (r.base64Encoded ? 4 / 3 : 1)) {
        toast('Oversized response passed through unchanged.');
        return continuePlain(p.requestId);
      }
      if (r.base64Encoded) {
        item.originalBodyB64 = r.body;
        const d = HTTP.decodeBody(HTTP.b64ToBytes(r.body));
        if (d.binary) {
          item.warn = `Response body is binary (${fmtSize(d.size)}) and is not shown. Leave the body empty to keep the original bytes.`;
        } else bodyText = d.text;
      } else {
        bodyText = r.body;
      }
    } catch {
      // e.g. redirects have no body
    }
    item.originalBody = bodyText;
    item.originalRaw = HTTP.serializeResponse({
      status: p.responseStatusCode, statusText: p.responseStatusText,
      headers: await withSetCookies(p.networkId, HTTP.headersToList(p.responseHeaders)), body: bodyText,
    });
  }
  if (!state.attached) return; // detached while awaiting
  item.raw = item.autoRaw || item.originalRaw;
  state.queue.push(item);
  if (!state.selectedQueueId) {
    state.selectedQueueId = item.id;
    loadEditor();
  }
  renderQueue();
}

function describeChanges(changes) {
  return changes.map((c) => `${c.key}: ${c.from} → ${c.to} (${c.where})`).join(', ');
}

/** Forward a request with the auto-rewrite applied, without pausing it. */
async function autoForward(p, req, reqBody, mod) {
  const headers = HTTP.headersToList(req.headers).filter((h) => h.name.toLowerCase() !== 'content-length');
  const params = { requestId: p.requestId, url: mod.url, method: req.method, headers };
  const canBody = reqBody && !reqBody.binary && reqBody.known && reqBody.text.length <= MAX_BODY_CHARS;
  const bodyChanged = canBody && HTTP.norm(mod.body) !== HTTP.norm(reqBody.text);
  if (bodyChanged) params.postData = HTTP.utf8ToB64(mod.body);
  try {
    await cdp('Fetch.continueRequest', params);
  } catch (e) {
    await continuePlain(p.requestId);
    return;
  }
  recordAuto(p, req, mod, bodyChanged);
}

/** Log an auto-rewrite and mark the matching history row edited. */
function recordAuto(p, req, mod, bodyChanged) {
  queueLocalSave();
  state.autoCount++;
  chrome.runtime.sendMessage({ type: 'incrementAutoCount' }).then((result) => {
    if (typeof result?.count === 'number') { state.autoCount = result.count; updateStatus(); renderAutoLog(); }
  }).catch(() => {});
  const entry = {
    id: ++state.seq,
    method: req.method,
    url: mod.url,
    changes: mod.changes,
    seqNo: state.autoCount,
  };
  state.autoLog.unshift(entry);
  if (state.autoLog.length > 500) state.autoLog.length = 500;

  const e = netMap.get(p.networkId) || state.history.find((h) => h.requestId === p.networkId);
  if (e) {
    e.edited = true;
    e.url = mod.url;
    if (bodyChanged) e.reqBody = mod.body;
    e.note = `auto: ${mod.changes.map((c) => `${c.key} ${c.from}→${c.to}`).join(', ')}`;
    touchHistory(e);
  }
  renderAutoLog();
  updateStatus();
}

/** Record an auto-rewrite that the background worker made on another tab. */
function recordAutoExternal(entry) {
  queueLocalSave();
  state.autoCount = typeof entry.count === 'number' ? entry.count : state.autoCount + 1;
  state.autoLog.unshift({
    id: ++state.seq,
    method: entry.method,
    url: entry.url,
    changes: entry.changes || [],
    seqNo: state.autoCount,
    external: true,
  });
  if (state.autoLog.length > 500) state.autoLog.length = 500;
  renderAutoLog();
  updateStatus();
}

/** Chrome hides Set-Cookie from Fetch.requestPaused; recover it from the Network
 * domain's raw headers so an edited (fulfilled) response doesn't lose cookies. */
async function withSetCookies(networkId, headers) {
  if (headers.some((h) => h.name.toLowerCase() === 'set-cookie')) return headers;
  const find = () => {
    const e = netMap.get(networkId);
    if (e && e.resExtra) return e.resHeaders;
    const x = extraRes.get(networkId);
    return x ? HTTP.headersToList(x.headers) : null;
  };
  let raw = find();
  for (let i = 0; !raw && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
    raw = find();
  }
  const cookies = (raw || []).filter((h) => h.name.toLowerCase() === 'set-cookie');
  return cookies.length ? [...headers, ...cookies] : headers;
}

const currentItem = () => state.queue.find((i) => i.id === state.selectedQueueId) || null;

function renderQueue() {
  const ul = $('#queueList');
  ul.innerHTML = '';
  for (const item of state.queue) {
    const li = document.createElement('li');
    li.className = 'qitem' + (item.id === state.selectedQueueId ? ' selected' : '');
    li.innerHTML =
      `<span class="stage ${item.stage}">${item.stage === 'request' ? 'REQ' : 'RES'}</span>` +
      `<span class="m m-${escapeHtml(item.method)}">${escapeHtml(item.method)}</span>` +
      (item.stage === 'response' ? `<span class="s${String(item.status)[0]}">${escapeHtml(item.status)}</span>` : '') +
      `<span class="url" title="${escapeHtml(item.url)}">${escapeHtml(shortUrl(item.url))}</span>`;
    li.addEventListener('click', () => {
      state.selectedQueueId = item.id;
      loadEditor();
      renderQueue();
    });
    ul.append(li);
  }
  const n = state.queue.length;
  $('#queueEmpty').classList.toggle('hidden', n > 0);
  $('#queueCount').textContent = String(n);
  const badge = $('#queueBadge');
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0);
  document.title = n ? `(${n}) Interceptor` : 'Interceptor';
  // The toolbar badge is owned by the background worker (Auto-mode "ON").

  const cur = currentItem();
  $('#fwdBtn').disabled = !cur || !!cur.busy;
  $('#dropBtn').disabled = !cur || !!cur.busy;
  $('#fwdRespBtn').disabled = !cur || !!cur.busy || cur.stage !== 'request';
  $('#toRepeaterFromIntercept').disabled = !cur;
  $('#fwdAllBtn').disabled = n === 0;
}

function renderAutoLog() {
  const ul = $('#autoLogList');
  ul.innerHTML = '';
  for (const e of state.autoLog) {
    const li = document.createElement('li');
    li.className = 'alog';
    li.innerHTML =
      `<div class="top"><span class="n">#${e.seqNo}</span>` +
      `<span class="m m-${escapeHtml(e.method)}">${escapeHtml(e.method)}</span>` +
      `<span class="url" title="${escapeHtml(e.url)}">${escapeHtml(shortUrl(e.url))}</span></div>` +
      `<div class="chg">${escapeHtml(describeChanges(e.changes))}</div>`;
    ul.append(li);
  }
  $('#autoLogCount').textContent = String(state.autoCount);
  $('#autoLogEmpty').classList.toggle('hidden', state.autoLog.length > 0);
}

function loadEditor() {
  const ed = $('#interceptEditor');
  const cur = currentItem();
  const warn = $('#editorWarn');
  if (!cur) {
    ed.value = '';
    ed.disabled = true;
    $('#editorTitle').textContent = 'No intercepted item selected';
    $('#editorHint').textContent = '';
    warn.classList.add('hidden');
    return;
  }
  ed.disabled = false;
  ed.value = cur.raw;
  $('#editorTitle').textContent = cur.stage === 'request' ? 'Intercepted request' : `Intercepted response (${cur.status})`;
  $('#editorHint').textContent = `${cur.resourceType || ''} · ${shortUrl(cur.url)}`;
  const msg = [cur.autoNote, cur.warn].filter(Boolean).join('  •  ');
  warn.textContent = msg;
  warn.classList.toggle('hidden', !msg);
  warn.classList.toggle('auto', !!cur.autoNote && !cur.warn);
}

$('#interceptEditor').addEventListener('input', (e) => {
  const cur = currentItem();
  if (cur) cur.raw = e.target.value;
});

const isUnchanged = (item) => HTTP.norm(item.raw) === HTTP.norm(item.originalRaw);

/** Build the CDP command that releases a paused item, applying the user's edits. */
function buildRelease(item, catchResponse = false) {
  if (item.stage === 'request') {
    const params = { requestId: item.id };
    if (catchResponse) params.interceptResponse = true;
    if (isUnchanged(item)) return { method: 'Fetch.continueRequest', params, edited: false };
    const p = HTTP.parseRequest(item.raw, item.url);
    params.method = p.method;
    params.url = p.url;
    params.headers = p.headers.filter((h) => h.name.toLowerCase() !== 'content-length');
    const bodyChanged = HTTP.norm(p.body) !== HTTP.norm(item.originalBody);
    if (bodyChanged) params.postData = HTTP.utf8ToB64(p.body);
    return { method: 'Fetch.continueRequest', params, edited: true, parsed: p, bodyChanged };
  }
  if (isUnchanged(item)) return { method: 'Fetch.continueRequest', params: { requestId: item.id }, edited: false };
  const r = HTTP.parseResponse(item.raw);
  const bodyChanged = HTTP.norm(r.body) !== HTTP.norm(item.originalBody);
  const body = !bodyChanged && item.originalBodyB64 != null ? item.originalBodyB64 : HTTP.utf8ToB64(r.body);
  const params = {
    requestId: item.id,
    responseCode: r.status,
    // The body we hold is already decoded, so drop encoding/length headers.
    responseHeaders: r.headers.filter((h) => !/^(content-length|content-encoding|transfer-encoding)$/i.test(h.name)),
    body,
  };
  if (r.statusText) params.responsePhrase = r.statusText;
  return { method: 'Fetch.fulfillRequest', params, edited: true };
}

function removeFromQueue(id) {
  const idx = state.queue.findIndex((i) => i.id === id);
  if (idx === -1) return;
  state.queue.splice(idx, 1);
  if (state.selectedQueueId === id) {
    const next = state.queue[idx] || state.queue[idx - 1] || null;
    state.selectedQueueId = next ? next.id : null;
    loadEditor();
  }
  renderQueue();
}

async function forwardItem(item, catchResponse = false) {
  if (item.busy) return false;
  let rel;
  try {
    rel = buildRelease(item, catchResponse);
  } catch (e) {
    toast(`Can't forward: ${e.message}`, 'error');
    return false;
  }
  if (catchResponse) state.forceResponse.add(item.id);
  item.busy = true;
  renderQueue();
  try {
    await cdp(rel.method, rel.params);
    removeFromQueue(item.id);
    if (rel.edited) markHistoryEdited(item, rel);
  } catch (e) {
    state.forceResponse.delete(item.id);
    if (/Invalid InterceptionId/i.test(e.message)) {
      removeFromQueue(item.id);
      toast('That request is no longer pending (page navigated or request was cancelled).', 'error');
    } else {
      toast(`Forward failed: ${e.message}. Fix the edit and try again.`, 'error');
    }
    return false;
  } finally {
    item.busy = false;
    renderQueue();
  }
  return true;
}

async function dropItem(item) {
  if (item.busy) return;
  removeFromQueue(item.id);
  try {
    await cdp('Fetch.failRequest', { requestId: item.id, errorReason: 'BlockedByClient' });
  } catch { /* already gone */ }
  const e = netMap.get(item.networkId);
  if (e) { e.note = 'dropped'; scheduleHistoryRender(); }
}

/** Release everything in the queue (used by Forward all / intercept off / detach). */
async function releaseAll(applyEdits) {
  const items = state.queue.filter((item) => !item.busy);
  state.queue = state.queue.filter((item) => item.busy);
  state.selectedQueueId = null;
  loadEditor();
  renderQueue();
  await Promise.all(items.map(async (item) => {
    if (applyEdits) {
      try {
        const rel = buildRelease(item);
        await cdp(rel.method, rel.params);
        if (rel.edited) markHistoryEdited(item, rel);
        return;
      } catch { /* fall back to unchanged */ }
    }
    await continuePlain(item.id);
  }));
}

function toggleIntercept() {
  state.interceptOn = !state.interceptOn;
  if (state.interceptOn && !state.attached) toast('Intercept is ON — now attach to a tab to start catching requests.');
  // Turning intercept off must release any queued items, even when Auto mode
  // keeps the Fetch domain enabled (so they don't hang waiting for Forward).
  if (!state.interceptOn && state.queue.length) {
    releaseAll(true).then(() => applyFetch()).catch((e) => toast(e.message, 'error'));
  } else {
    applyFetch().catch((e) => toast(e.message, 'error'));
  }
  updateStatus();
}

// ======================================================================
// HTTP History (Network domain)
// ======================================================================
const netMap = new Map();    // Network requestId -> live history entry
const extraReq = new Map();  // requestWillBeSentExtraInfo that arrived early
const extraRes = new Map();  // responseReceivedExtraInfo that arrived early

function applyResponse(e, r) {
  e.status = r.status;
  e.statusText = r.statusText || '';
  e.mime = r.mimeType || '';
  e.httpVersion = /^h2|http\/2/i.test(r.protocol || '') ? 'HTTP/2' : /^h3/i.test(r.protocol || '') ? 'HTTP/3' : 'HTTP/1.1';
  if (!e.resExtra) e.resHeaders = HTTP.headersToList(r.headers);
}

function onRequestWillBeSent(p) {
  if (/^(data|blob):/i.test(p.request.url)) return;
  const prev = netMap.get(p.requestId);
  if (prev && p.redirectResponse) {
    applyResponse(prev, p.redirectResponse);
    prev.state = 'done';
    prev.duration = (p.timestamp - prev.ts) * 1000;
    prev.resBody = '';
    netMap.delete(p.requestId);
    touchHistory(prev);
  }
  const body = requestBodyFromCdp(p.request);
  const e = {
    id: ++state.seq,
    requestId: p.requestId,
    method: p.request.method,
    url: p.request.url,
    reqHeaders: HTTP.headersToList(p.request.headers),
    reqBody: body.binary ? `[binary request body, ${fmtSize(body.size)}]` : limitBody(body.text, 'request body'),
    type: p.type || 'Other',
    wallTime: p.wallTime ? p.wallTime * 1000 : Date.now(),
    ts: p.timestamp,
    status: null, statusText: '', resHeaders: [], resBody: null, httpVersion: 'HTTP/1.1',
    size: null, duration: null, state: 'pending', error: null, mime: '', note: '',
    reqExtra: false, resExtra: false, edited: false,
  };
  const x = extraReq.get(p.requestId);
  if (x) { e.reqHeaders = HTTP.headersToList(x.headers); e.reqExtra = true; extraReq.delete(p.requestId); }
  if (!body.known && !body.binary) {
    cdp('Network.getRequestPostData', { requestId: p.requestId }).then((r) => {
      e.reqBody = limitBody(r.base64Encoded ? HTTP.decodeBody(HTTP.b64ToBytes(r.postData)).text : r.postData, 'request body');
      pruneHistory();
      touchHistory(e);
    }).catch(() => {});
  }
  netMap.set(p.requestId, e);
  state.history.push(e);
  pruneHistory();
  scheduleHistoryRender();
}

function onRequestExtra(p) {
  const e = netMap.get(p.requestId);
  if (e && !e.reqExtra) {
    if (!e.edited) e.reqHeaders = HTTP.headersToList(p.headers);
    e.reqExtra = true;
    touchHistory(e);
  } else {
    extraReq.set(p.requestId, p);
    if (extraReq.size > 500) extraReq.delete(extraReq.keys().next().value);
  }
}

function onResponseReceived(p) {
  const e = netMap.get(p.requestId);
  if (!e) return;
  const x = extraRes.get(p.requestId);
  if (x) { e.resHeaders = HTTP.headersToList(x.headers); e.resExtra = true; extraRes.delete(p.requestId); }
  applyResponse(e, p.response);
  e.type = p.type || e.type;
  touchHistory(e);
}

function onResponseExtra(p) {
  const e = netMap.get(p.requestId);
  if (e) {
    e.resHeaders = HTTP.headersToList(p.headers);
    e.resExtra = true;
    if (p.statusCode && e.status == null) e.status = p.statusCode;
    touchHistory(e);
  } else {
    extraRes.set(p.requestId, p);
    if (extraRes.size > 500) extraRes.delete(extraRes.keys().next().value);
  }
}

async function onLoadingFinished(p) {
  const e = netMap.get(p.requestId);
  if (!e) return;
  e.size = p.encodedDataLength;
  e.duration = (p.timestamp - e.ts) * 1000;
  e.state = 'done';
  touchHistory(e);
  try {
    if (p.encodedDataLength > MAX_BODY_CHARS * 2) {
      e.resBody = `[body not captured: encoded response is ${fmtSize(p.encodedDataLength)}]`;
    } else {
      const r = await cdp('Network.getResponseBody', { requestId: p.requestId });
      if (r.base64Encoded) {
        const bytes = HTTP.b64ToBytes(r.body);
        const d = HTTP.decodeBody(bytes);
        e.resBody = d.binary ? `[binary ${e.mime || 'data'}, ${fmtSize(d.size)} — not shown]` : d.text;
      } else {
        e.resBody = r.body;
      }
      e.resBody = limitBody(e.resBody, 'response body');
    }
  } catch (err) {
    e.resBody = `[body unavailable: ${err.message}]`;
  } finally {
    netMap.delete(p.requestId);
  }
  pruneHistory();
  touchHistory(e);
}

function onLoadingFailed(p) {
  const e = netMap.get(p.requestId);
  if (!e) return;
  e.state = 'failed';
  e.error = p.canceled ? 'canceled' : p.blockedReason ? `blocked (${p.blockedReason})` : p.errorText;
  e.duration = (p.timestamp - e.ts) * 1000;
  netMap.delete(p.requestId);
  touchHistory(e);
}

function markHistoryEdited(item, rel) {
  const e = netMap.get(item.networkId) || state.history.find((h) => h.requestId === item.networkId);
  if (!e) return;
  e.edited = true;
  if (item.stage === 'request' && rel.parsed) {
    e.method = rel.parsed.method;
    e.url = rel.parsed.url;
    e.reqHeaders = [{ name: 'Host', value: new URL(rel.parsed.url).host }, ...rel.parsed.headers];
    if (rel.bodyChanged) e.reqBody = rel.parsed.body;
  } else {
    e.note = 'response edited';
  }
  touchHistory(e);
}

function touchHistory(e) {
  queueLocalSave();
  scheduleHistoryRender();
  if (e.id === state.selectedHistoryId) scheduleDetailRender();
}

let historyRenderPending = false;
function scheduleHistoryRender() {
  queueLocalSave();
  $('#historyCount').textContent = String(state.history.length);
  if (historyRenderPending) return;
  historyRenderPending = true;
  setTimeout(() => {
    historyRenderPending = false;
    if ($('#view-history').classList.contains('active')) renderHistory();
  }, 150);
}
let detailPending = false;
function scheduleDetailRender() {
  if (detailPending) return;
  detailPending = true;
  requestAnimationFrame(() => { detailPending = false; renderHistoryDetail(); });
}

function historyMatches(e, matcher, type, hideStatic, method, status, searchContent) {
  if (type === 'api' ? !['Fetch', 'XHR'].includes(e.type) : type && e.type !== type) return false;
  if (hideStatic && isStatic(e.type, e.url)) return false;
  if (method && e.method !== method) return false;
  if (status === 'pending') {
    if (e.status != null && !e.error) return false;
  } else if (status && String(e.status || '')[0] !== status) return false;
  if (matcher.test(`${e.method} ${e.url} ${e.status ?? ''} ${e.error ?? ''} ${e.note || ''}`)) return true;
  if (!searchContent) return false;
  const headers = [...(e.reqHeaders || []), ...(e.resHeaders || [])].map((h) => `${h.name}: ${h.value}`).join('\n');
  return matcher.test(headers) || matcher.test(e.reqBody || '') || matcher.test(e.resBody || '');
}

function filteredHistory() {
  const matcher = compileMatcher($('#historyFilter').value);
  return state.history.filter((entry) => historyMatches(
    entry,
    matcher,
    $('#historyType').value,
    state.settings.historyHideStatic,
    $('#historyMethod').value,
    $('#historyStatus').value,
    state.settings.historySearchContent,
  ));
}

function statusCell(e) {
  if (e.state === 'failed') return `<span class="sx">${escapeHtml(e.error || 'failed')}</span>`;
  if (e.status == null) return '<span class="sx">…</span>';
  const c = String(e.status)[0];
  return `<span class="s${'2345'.includes(c) ? c : 'x'}">${e.status}</span>`;
}

function renderHistory() {
  const wrap = $('#historyWrap');
  const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 30;
  const matcher = compileMatcher($('#historyFilter').value);
  $('#historyFilter').classList.toggle('invalid', !matcher.valid);
  const type = $('#historyType').value;
  const hideStatic = state.settings.historyHideStatic;
  const method = $('#historyMethod').value;
  const status = $('#historyStatus').value;
  const searchContent = state.settings.historySearchContent;
  const rows = [];
  for (const e of state.history) {
    if (!historyMatches(e, matcher, type, hideStatic, method, status, searchContent)) continue;
    let host = '', path = e.url;
    try { const u = new URL(e.url); host = u.host; path = u.pathname + u.search; } catch { /* keep raw */ }
    rows.push(
      `<tr data-id="${e.id}"${e.id === state.selectedHistoryId ? ' class="selected"' : ''}>` +
      `<td>${e.id}</td><td class="m m-${escapeHtml(e.method)}">${escapeHtml(e.method)}</td>` +
      `<td title="${escapeHtml(host)}">${escapeHtml(host)}</td>` +
      `<td class="path" title="${escapeHtml(e.url)}">${escapeHtml(path)}${e.edited ? '<span class="edited" title="Edited in Intercept">✎</span>' : ''}${e.note ? ` <span class="sx">(${escapeHtml(e.note)})</span>` : ''}</td>` +
      `<td>${statusCell(e)}</td><td>${escapeHtml(e.type)}</td><td>${fmtSize(e.size)}</td><td>${fmtMs(e.duration)}</td></tr>`,
    );
  }
  $('#historyTable tbody').innerHTML = rows.join('');
  $('#historyCount').textContent = rows.length === state.history.length ? String(state.history.length) : `${rows.length}/${state.history.length}`;
  $('#historyEmpty').classList.toggle('hidden', rows.length > 0);
  $('#historyEmpty').textContent = state.history.length
    ? 'No requests match the current filters.'
    : state.attached ? 'Waiting for traffic… use your app (or click "Reload tab").' : 'Attach to a tab or import a HAR file.';
  if (atBottom && $('#historyAutoScroll').checked) wrap.scrollTop = wrap.scrollHeight;
}

const selectedHistory = () => state.history.find((h) => h.id === state.selectedHistoryId) || null;

function historyRequestRaw(e, pretty) {
  return HTTP.serializeRequest({ method: e.method, url: e.url, headers: e.reqHeaders, body: pretty ? HTTP.prettyBody(e.reqBody) : e.reqBody });
}
function historyResponseRaw(e, pretty) {
  if (e.status == null) return e.state === 'failed' ? `Request failed: ${e.error}` : 'Waiting for response…';
  const body = e.resBody == null ? (e.state === 'done' ? '' : '[loading body…]') : e.resBody;
  return HTTP.serializeResponse({
    status: e.status, statusText: e.statusText, headers: e.resHeaders,
    body: pretty ? HTTP.prettyBody(body) : body, httpVersion: e.httpVersion,
  });
}

function renderHistoryDetail() {
  const e = selectedHistory();
  for (const id of ['#histToRepeater', '#histCurl', '#histCopyReq', '#histCopyResp', '#histCompare']) $(id).disabled = !e;
  $('#histInspect').disabled = !e;
  $('#histSave').disabled = !e;
  if (!e) { setRaw($('#histReq'), ''); setRaw($('#histRes'), ''); return; }
  const pretty = state.settings.prettyJson;
  setRaw($('#histReq'), historyRequestRaw(e, pretty));
  setRaw($('#histRes'), historyResponseRaw(e, pretty));
}

function exportHar() {
  const visible = filteredHistory();
  if (!visible.length) return toast('There are no visible history rows to export.', 'error');
  const entries = visible.map((e) => {
    let qs = [];
    try { qs = [...new URL(e.url).searchParams].map(([name, value]) => ({ name, value })); } catch { /* ignore */ }
    const ct = HTTP.getHeader(e.reqHeaders, 'content-type') || '';
    return {
      startedDateTime: new Date(e.wallTime).toISOString(),
      time: e.duration || 0,
      request: {
        method: e.method, url: e.url, httpVersion: e.httpVersion, headers: e.reqHeaders, queryString: qs,
        cookies: [], headersSize: -1, bodySize: e.reqBody ? e.reqBody.length : 0,
        ...(e.reqBody ? { postData: { mimeType: ct, text: e.reqBody } } : {}),
      },
      response: {
        status: e.status || 0, statusText: e.statusText || '', httpVersion: e.httpVersion, headers: e.resHeaders,
        cookies: [], content: { size: e.resBody ? e.resBody.length : 0, mimeType: e.mime || '', text: e.resBody || '' },
        redirectURL: HTTP.getHeader(e.resHeaders, 'location') || '', headersSize: -1, bodySize: e.size ?? -1,
        ...(e.error ? { _error: e.error } : {}),
      },
      cache: {},
      timings: { send: 0, wait: e.duration || 0, receive: 0 },
    };
  });
  const har = { log: { version: '1.2', creator: { name: 'Interceptor', version: chrome.runtime.getManifest().version }, entries } };
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `interceptor-${new Date().toISOString().replace(/[:.]/g, '-')}.har`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Exported ${visible.length} request${visible.length === 1 ? '' : 's'} to HAR.`);
}

async function importHarFile(file) {
  if (!file) return;
  if (file.size > 30_000_000) return toast('HAR import is limited to 30 MB.', 'error');
  try {
    const imported = Workbench.importHar(JSON.parse(await file.text()), MAX_HISTORY);
    if (!imported.length) throw new Error('The HAR contains no HTTP(S) requests.');
    for (const entry of imported) {
      entry.id = ++state.seq;
      entry.requestId = `har:${entry.id}`;
      entry.reqBody = limitBody(entry.reqBody, 'request body');
      entry.resBody = limitBody(entry.resBody, 'response body');
      state.history.push(entry);
    }
    pruneHistory();
    state.selectedHistoryId = state.history.at(-1)?.id ?? null;
    renderHistory();
    renderHistoryDetail();
    toast(`Imported ${imported.length} request${imported.length === 1 ? '' : 's'} from ${file.name}.`);
  } catch (error) {
    toast(`HAR import failed: ${error.message}`, 'error');
  } finally {
    $('#importHarFile').value = '';
  }
}

// ======================================================================
// Comparer
// ======================================================================
function sendToComparer(raw, label) {
  if (!state.compare.left) {
    state.compare.left = raw;
    state.compare.leftLabel = label;
  } else {
    state.compare.right = raw;
    state.compare.rightLabel = label;
  }
  switchView('comparer');
  renderComparer();
}

function renderComparer() {
  $('#compareA').value = state.compare.left;
  $('#compareB').value = state.compare.right;
  $('#compareLabelA').textContent = state.compare.leftLabel || 'paste or send a history response';
  $('#compareLabelB').textContent = state.compare.rightLabel || 'paste or send a history response';
  $('#comparePretty').checked = state.settings.comparePretty !== false;
  $('#compareBadge').textContent = state.compare.left && state.compare.right ? 'ready' : state.compare.left ? '1/2' : '';
  runCompare();
}

function runCompare() {
  const tbody = $('#compareTable tbody');
  tbody.innerHTML = '';
  if (!state.compare.left || !state.compare.right) {
    $('#compareEmpty').classList.remove('hidden');
    $('#compareMeta').textContent = 'Add two responses from HTTP History, or paste any text.';
    state.compare.unified = '';
    return;
  }
  const pretty = $('#comparePretty').checked;
  const left = Workbench.normalizeForCompare(state.compare.left, pretty);
  const right = Workbench.normalizeForCompare(state.compare.right, pretty);
  const diff = Workbench.diffLines(left, right);
  let leftNo = 0;
  let rightNo = 0;
  let changed = 0;
  const html = [];
  const unified = [];
  for (const row of diff.rows) {
    const hasLeft = row.type !== 'add' && row.type !== 'notice';
    const hasRight = row.type !== 'remove' && row.type !== 'notice';
    if (hasLeft) leftNo++;
    if (hasRight) rightNo++;
    if (row.type !== 'same') changed++;
    const marker = row.type === 'same' ? ' ' : row.type === 'add' ? '+' : row.type === 'remove' ? '-' : row.type === 'change' ? '±' : '!';
    html.push(`<tr class="diff-${row.type}"><td class="diff-mark">${marker}</td><td class="diff-no">${hasLeft ? leftNo : ''}</td><td>${escapeHtml(row.left)}</td><td class="diff-no">${hasRight ? rightNo : ''}</td><td>${escapeHtml(row.right)}</td></tr>`);
    if (row.type === 'same') unified.push(`  ${row.left}`);
    else if (row.type === 'remove') unified.push(`- ${row.left}`);
    else if (row.type === 'add') unified.push(`+ ${row.right}`);
    else if (row.type === 'change') unified.push(`- ${row.left}`, `+ ${row.right}`);
    else unified.push(`! ${row.left}`);
  }
  tbody.innerHTML = html.join('');
  state.compare.unified = unified.join('\n');
  $('#compareEmpty').classList.add('hidden');
  $('#compareMeta').textContent = changed
    ? `${changed} changed row${changed === 1 ? '' : 's'} · ${diff.leftLines} vs ${diff.rightLines} lines${diff.truncated ? ' · preview capped' : ''}`
    : `Identical · ${diff.leftLines} lines`;
}

function clearComparer() {
  state.compare = { left: '', right: '', leftLabel: '', rightLabel: '', unified: '' };
  renderComparer();
}

// ======================================================================
// Decoder
// ======================================================================
let decoderGeneration = 0;
async function runDecoder() {
  const generation = ++decoderGeneration;
  try {
    const action = $('#decoderAction').value;
    const input = $('#decoderInput').value;
    const result = /^sha(256|512)$/.test(action)
      ? await Workbench.hash(action === 'sha256' ? 'SHA-256' : 'SHA-512', input)
      : Workbench.transform(action, input);
    if (generation !== decoderGeneration) return;
    $('#decoderOutput').value = result;
    $('#decoderMeta').textContent = `${result.length.toLocaleString()} output characters · local only`;
  } catch (error) {
    if (generation !== decoderGeneration) return;
    $('#decoderOutput').value = '';
    $('#decoderMeta').textContent = error.message;
    toast(`Transform failed: ${error.message}`, 'error');
  }
}

// ======================================================================
// Repeater
// ======================================================================
// Headers fetch() won't let a page set; applied with a temporary
// declarativeNetRequest session rule instead.
const VIA_DNR = new Set(['cookie', 'origin', 'referer', 'user-agent', 'accept-encoding', 'dnt', 'date', 'via', 'accept-charset', 'access-control-request-headers', 'access-control-request-method']);
// Left to the browser.
const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect']);
// Headers the browser adds on its own; removed when absent from the raw request
// so the server sees exactly what you wrote.
const AUTO_ADDED = ['cookie', 'origin', 'referer', 'user-agent', 'accept-language', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];

const pendingCaptures = new Set();
const EXT_ORIGIN = location.origin;
// Requests made from this page carry the dashboard tab's id (or -1 in a popup window).
let selfTabId = chrome.tabs.TAB_ID_NONE;
chrome.tabs.getCurrent().then((t) => { if (t) selfTabId = t.id; }).catch(() => {});

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId !== selfTabId || d.initiator !== EXT_ORIGIN) return;
  for (const c of pendingCaptures) {
    if (!c.requestId && c.url === d.url && c.method === d.method) { c.requestId = d.requestId; break; }
  }
}, { urls: ['<all_urls>'] });

const captureById = (id) => [...pendingCaptures].find((c) => c.requestId === id);

chrome.webRequest.onSendHeaders.addListener((d) => {
  const c = captureById(d.requestId);
  if (c) { c.sentHeaders = d.requestHeaders; c.sentUrl = d.url; c.sentMethod = d.method; }
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener((d) => {
  const c = captureById(d.requestId);
  if (c) { c.statusLine = d.statusLine; c.statusCode = d.statusCode; c.responseHeaders = d.responseHeaders; }
}, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders']);

let dnrSeq = 0;
async function installHeaderRule(url, method, sets, removes) {
  if (!sets.length && !removes.length) return { id: null, warn: '' };
  const id = 1000 + (++dnrSeq % 100000);
  const condition = { tabIds: [selfTabId], resourceTypes: ['xmlhttprequest'] };
  if (/[*^|]/.test(url)) condition.regexFilter = '^' + escapeRe(url) + '$';
  else condition.urlFilter = '|' + url + '|';
  if (STD_METHODS.includes(method)) condition.requestMethods = [method.toLowerCase()];

  // Merge duplicate names (e.g. several Cookie lines).
  const merged = new Map();
  for (const h of sets) {
    const n = h.name.toLowerCase();
    merged.set(n, merged.has(n) ? `${merged.get(n)}${n === 'cookie' ? '; ' : ', '}${h.value}` : h.value);
  }
  const all = [
    ...[...merged].map(([header, value]) => ({ header, operation: 'set', value })),
    ...removes.map((header) => ({ header, operation: 'remove' })),
  ];
  const tryRule = async (requestHeaders) => {
    const result = await chrome.runtime.sendMessage({
      type: 'setRepeaterRule',
      rule: { id, priority: 1, action: { type: 'modifyHeaders', requestHeaders }, condition },
    });
    if (!result?.ok) throw new Error(result?.error || 'Header rule could not be installed.');
  };
  try {
    await tryRule(all);
    return { id, warn: '' };
  } catch (e) {
    const minimal = all.filter((h) => ['cookie', 'origin', 'referer', 'user-agent'].includes(h.header));
    try {
      if (!minimal.length) throw e;
      await tryRule(minimal);
      return { id, warn: `Some header overrides were rejected by the browser: ${e.message}` };
    } catch (e2) {
      await removeHeaderRule(id);
      return { id: null, warn: `Header overrides unavailable (Cookie/Origin/etc. not applied): ${e2.message}` };
    }
  }
}
async function removeHeaderRule(id) {
  if (id == null) return;
  try { await chrome.runtime.sendMessage({ type: 'removeRepeaterRule', ruleId: id }); }
  catch {
    try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }); } catch { /* already gone */ }
  }
}

const DEFAULT_RAW = 'GET / HTTP/1.1\nHost: localhost:3000\nAccept: */*\n\n';

function repeaterName(raw) {
  const m = /^\s*(\S+)\s+(\S+)/.exec(raw || '');
  return m ? `${m[1]} ${m[2].split('?')[0]}`.slice(0, 40) : 'request';
}

function newRepeater({ raw = DEFAULT_RAW, target = 'http://localhost:3000', follow = false, assertions = '[]' } = {}) {
  if (state.repeaters.length >= 100) { toast('Keep up to 100 Repeater tabs; save or close older tabs first.', 'error'); return activeRepeater(); }
  const r = { id: ++state.repSeq, raw, target, follow: !!follow, assertions, tests: [], response: '', sent: '', meta: '', view: 'res', abort: null, snapshots: [], snapshotId: null };
  state.repeaters.push(r);
  state.activeRepeaterId = r.id;
  renderRepeater();
  saveRepeaters();
  return r;
}

function sendToRepeater(raw, url) {
  const parsed = HTTP.parseRequest(raw, url);
  if (/^\[binary request body/.test(parsed.body) || /\[… request body truncated/.test(parsed.body)) {
    return toast('This request body was not captured completely. Create a Repeater request with the original payload to replay it.', 'error');
  }
  let target = 'http://localhost:3000';
  try { target = new URL(url).origin; } catch { /* keep default */ }
  newRepeater({ raw, target });
  switchView('repeater');
  toast('Sent to Repeater');
}

const activeRepeater = () => state.repeaters.find((r) => r.id === state.activeRepeaterId) || null;

let saveTimer;
function saveRepeaters() {
  queueLocalSave();
  if (labState.ready) return;
  clearTimeout(saveTimer);
  if (!state.settings.repRemember) {
    chrome.storage.local.remove(['repeaters', 'activeRepeaterId']).catch(() => {});
    return;
  }
  saveTimer = setTimeout(() => {
    const data = state.repeaters.map(({ id, raw, target, follow }) => ({ id, raw, target, follow }));
    chrome.storage.local.set({ repeaters: data, activeRepeaterId: state.activeRepeaterId }).catch(() => {});
  }, 400);
}

async function loadRepeaters() {
  // Earlier versions saved tabs automatically. Preserve those tabs on upgrade.
  const stored = await chrome.storage.local.get(['settings', 'repeaters', 'activeRepeaterId']);
  if (stored.settings?.repRemember == null && Array.isArray(stored.repeaters) && stored.repeaters.length) {
    state.settings.repRemember = true;
    $('#repRemember').checked = true;
    saveSettings();
  }
  if (!state.settings.repRemember) {
    chrome.storage.local.remove(['repeaters', 'activeRepeaterId']).catch(() => {});
    newRepeater();
    return;
  }
  try {
    const { repeaters, activeRepeaterId } = stored;
    if (Array.isArray(repeaters) && repeaters.length) {
      state.repeaters = repeaters.map((r) => ({ ...r, response: '', sent: '', meta: '', view: 'res', abort: null }));
      state.repSeq = Math.max(...repeaters.map((r) => r.id));
      state.activeRepeaterId = repeaters.some((r) => r.id === activeRepeaterId) ? activeRepeaterId : repeaters[0].id;
    }
  } catch { /* ignore */ }
  if (!state.repeaters.length) newRepeater();
}

function renderRepeater() {
  const list = $('#repTabList');
  list.innerHTML = '';
  for (const r of state.repeaters) {
    const b = document.createElement('button');
    b.className = 'rtab' + (r.id === state.activeRepeaterId ? ' active' : '');
    b.innerHTML = `<span>${escapeHtml(`${r.id} · ${repeaterName(r.raw)}`)}</span><span class="x" title="Close">×</span>`;
    b.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('x')) return closeRepeater(r.id);
      state.activeRepeaterId = r.id;
      renderRepeater();
      saveRepeaters();
    });
    list.append(b);
  }
  const r = activeRepeater();
  if (!r) return;
  $('#repEditor').value = r.raw;
  $('#repTarget').value = r.target;
  $('#repFollow').checked = !!r.follow;
  $('#repAssertions').value = r.assertions || '[]';
  renderRepeaterResponse();
}

function renderRepeaterResponse() {
  const r = activeRepeater();
  if (!r) return;
  $('#repSend').disabled = !!r.abort || repeaterBusy;
  $('#repCancel').disabled = !r.abort;
  $('#repCompare').disabled = !r.response;
  const snapshots = r.snapshots || [];
  $('#repSnapshot').innerHTML = '<option value="">Latest response</option>' + snapshots.slice().reverse().map((snapshot) => `<option value="${snapshot.id}">${escapeHtml(snapshot.label)}</option>`).join('');
  $('#repSnapshot').value = r.snapshotId || '';
  $('#repComparePrevious').disabled = snapshots.length < 2;
  $('#repMeta').textContent = r.abort ? 'sending…' : r.meta;
  $('#repViewRes').classList.toggle('active', r.view === 'res');
  $('#repViewSent').classList.toggle('active', r.view === 'sent');
  const pre = $('#repResponse');
  const snapshot = snapshots.find((item) => String(item.id) === String(r.snapshotId));
  renderAssertionResults($('#repTests'), snapshot?.tests || r.tests || []);
  const text = r.view === 'sent' ? (snapshot?.sent ?? r.sent) : (snapshot?.response ?? r.response);
  if (r.view === 'res' && state.settings.repPretty && text) {
    const i = text.indexOf('\n\n');
    setRaw(pre, i < 0 ? text : text.slice(0, i + 2) + HTTP.prettyBody(text.slice(i + 2)));
  } else {
    setRaw(pre, text);
  }
  if (!text) pre.innerHTML = `<span class="h-note">${r.view === 'sent' ? 'Send a request to see exactly what went over the wire.' : 'Response will appear here.'}</span>`;
}

function closeRepeater(id) {
  const r = state.repeaters.find((x) => x.id === id);
  if (r && r.abort) r.abort.abort();
  state.repeaters = state.repeaters.filter((x) => x.id !== id);
  if (!state.repeaters.length) { newRepeater(); return; }
  if (state.activeRepeaterId === id) state.activeRepeaterId = state.repeaters[state.repeaters.length - 1].id;
  renderRepeater();
  saveRepeaters();
}

let repeaterBusy = false;
async function readResponseLimited(res, limit) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes: bytes.slice(0, limit), truncated: bytes.length > limit, received: bytes.length };
  }
  const reader = res.body.getReader();
  const parts = [];
  let kept = 0;
  let received = 0;
  let truncated = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.length;
    if (kept < limit) {
      const take = value.subarray(0, Math.min(value.length, limit - kept));
      parts.push(take);
      kept += take.length;
    }
    if (received > limit) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return { bytes: HTTP.concatBytes(parts), truncated, received };
}

async function sendRepeater(r, options = {}) {
  if (labState.activeTest && !options.lab) return toast('Finish or stop the credential comparison first.', 'error');
  if (typeof workflowState !== 'undefined' && workflowState.runner.running && !options.runner) return toast('Stop the Runner before sending another request.', 'error');
  if (r.abort || repeaterBusy) return toast('Wait for the current Repeater request to finish or cancel it.', 'error');
  let p, target, assertions;
  try {
    assertions = Lab.parseAssertions(r.assertions || '[]');
    const prepared = options.prepared || Workflow.prepareRequest(r.raw, r.target.trim() || 'http://localhost', workspaceVariableText(), options.extra || {});
    target = new URL(prepared.target);
    p = prepared.parsed;
  } catch (e) {
    r.response = '';
    r.meta = '';
    if (!options.quiet) {
      renderRepeaterResponse();
      $('#repResponse').innerHTML = `<span class="s5">${escapeHtml(e.message)}</span>`;
    }
    return { error: e.message, status: 0, duration: 0, bytes: 0 };
  }
  const url = new URL(p.url);
  url.hash = '';
  // The Host header decides where the request goes; keep the Target field in sync.
  if (!/\{\{/.test(r.target + r.raw)) {
    r.target = url.origin;
    if (r.id === state.activeRepeaterId) $('#repTarget').value = r.target;
  }
  if (!options.quiet) saveRepeaters();

  const warnings = [];
  const fetchHeaders = new Headers();
  const dnrSet = [];
  const present = new Set();
  for (const h of p.headers) {
    const n = h.name.toLowerCase();
    present.add(n);
    if (SKIP_HEADERS.has(n)) continue;
    if (VIA_DNR.has(n) || n.startsWith('sec-') || n.startsWith('proxy-')) { dnrSet.push(h); continue; }
    try { fetchHeaders.append(h.name, h.value); } catch { warnings.push(`invalid header "${h.name}" skipped`); }
  }
  const removes = AUTO_ADDED.filter((n) => !present.has(n));
  const noBody = p.method === 'GET' || p.method === 'HEAD';
  if (noBody && p.body.trim()) warnings.push(`body ignored (browsers can't send a body with ${p.method})`);

  repeaterBusy = true;
  let rule = { id: null, warn: '' };
  const capture = { url: url.href, method: p.method, requestId: null };
  pendingCaptures.add(capture);
  const ctrl = new AbortController();
  const abortExternal = () => ctrl.abort();
  if (options.signal?.aborted) ctrl.abort();
  options.signal?.addEventListener('abort', abortExternal, { once: true });
  const timeoutMs = options.timeoutMs || Math.max(1, Math.min(300, Number($('#repTimeout').value) || 30)) * 1000;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  let result = { status: 0, duration: 0, bytes: 0, error: '' };
  r.abort = ctrl;
  r.response = '';
  r.sent = '';
  if (!options.quiet) renderRepeaterResponse();
  const t0 = performance.now();
  try {
    rule = await installHeaderRule(url.href, p.method, dnrSet, removes);
    if (rule.warn) warnings.push(rule.warn);
    const res = await fetch(url.href, {
      method: p.method,
      headers: fetchHeaders,
      body: noBody ? undefined : p.body,
      credentials: 'omit',          // cookies come only from your raw Cookie header
      redirect: r.follow ? 'follow' : 'manual',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const read = await readResponseLimited(res, MAX_REPEATER_BYTES);
    const buf = read.bytes;
    const ms = performance.now() - t0;
    const d = HTTP.decodeBody(buf);
    let bodyText = d.binary ? `[binary body, ${fmtSize(d.size)} — not shown]` : d.text;
    if (read.truncated) bodyText += `\n[… response truncated after ${fmtSize(MAX_REPEATER_BYTES)}]`;
    let statusLine, headers, status;
    if (capture.statusLine) {
      statusLine = capture.statusLine;
      headers = capture.responseHeaders || [];
      status = capture.statusCode;
    } else {
      status = res.status;
      statusLine = `HTTP/1.1 ${res.status} ${HTTP.statusText(res.status, res.statusText)}`;
      headers = [...res.headers].map(([name, value]) => ({ name, value }));
    }
    if (res.type === 'opaqueredirect' && !capture.statusLine) statusLine = 'HTTP/1.1 3xx (redirect — enable "Follow redirects" to follow it)';
    r.response = statusLine + '\n' + HTTP.headersToList(headers).map((h) => `${h.name}: ${h.value}`).join('\n') + '\n\n' + bodyText;
    r.meta = `${status} · ${fmtMs(ms)} · ${read.truncated ? '>' : ''}${fmtSize(read.received)}${warnings.length ? ' · ⚠ ' + warnings.join('; ') : ''}`;
    result = { status, duration: ms, bytes: read.received, truncated: read.truncated, error: '', url: url.href };
  } catch (e) {
    r.response = '';
    r.meta = warnings.length ? '⚠ ' + warnings.join('; ') : '';
    r.response = e.name === 'AbortError'
      ? `HTTP/0 ${timedOut ? 'Timed out' : 'Cancelled'}\n\n[request ${timedOut ? 'timed out' : 'cancelled'}]`
      : `HTTP/0 Network error\n\n${e.message}\n\nCommon causes: server not running, wrong port/scheme, invalid TLS certificate (open the URL in a tab and accept it first), or a forbidden method (CONNECT/TRACE).`;
    result = { status: 0, duration: performance.now() - t0, bytes: 0, error: timedOut ? 'Timed out' : e.name === 'AbortError' ? 'Cancelled' : e.message, url: url.href };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortExternal);
    if (capture.sentHeaders) {
      const sent = new URL(capture.sentUrl);
      r.sent = `${capture.sentMethod} ${sent.pathname}${sent.search} HTTP/1.1\nHost: ${sent.host}\n` +
        capture.sentHeaders.filter((h) => h.name.toLowerCase() !== 'host').map((h) => `${h.name}: ${h.value ?? ''}`).join('\n') +
        '\n\n' + (noBody ? '' : p.body);
    }
    pendingCaptures.delete(capture);
    await removeHeaderRule(rule.id);
    repeaterBusy = false;
    r.abort = null;
    r.snapshotId = null;
    r.tests = Lab.runAssertions(assertions, r.response, result);
    result.tests = r.tests;
    recordWorkbenchResponse(r, p, result, t0);
    if (!options.quiet && r.response) {
      r.snapshots ||= [];
      const id = (r.snapshotSeq || 0) + 1;
      r.snapshotSeq = id;
      const cap = (text) => text.length <= 200_000 ? text : text.slice(0, 200_000) + '\n[Snapshot preview truncated]';
      r.snapshots.push({ id, label: `${id} · ${result.status || result.error} · ${fmtMs(result.duration)}`, response: cap(r.response), sent: cap(r.sent), tests: r.tests });
      if (r.snapshots.length > 5) r.snapshots.shift();
    }
    if (r.id === state.activeRepeaterId) { renderRepeaterResponse(); renderRepeater(); }
    queueLocalSave();
  }
  return result;
}

// ======================================================================
// Views & wiring
// ======================================================================
function switchView(name) {
  for (const b of $$('.tabs button')) {
    b.classList.toggle('active', b.dataset.view === name);
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const v of $$('.view')) v.classList.toggle('active', v.id === `view-${name}`);
  if (name === 'history') { renderHistory(); renderHistoryDetail(); }
  if (name === 'repeater') renderRepeater();
  if (name === 'comparer') renderComparer();
  if (name === 'sitemap') renderSiteMap();
  if (name === 'collections') renderCollections();
  if (name === 'inspector') renderInspector();
  if (name === 'runner') renderRunner();
  if (name === 'security') renderSecurity();
  if (name === 'workspace') renderWorkspace();
  if (name === 'websocket') renderWebSockets();
}

function bindUi() {
  for (const b of $$('.tabs button')) b.addEventListener('click', () => switchView(b.dataset.view));

  // Target tab
  $('#refreshTabs').addEventListener('click', refreshTabs);
  $('#attachBtn').addEventListener('click', () => (state.attached ? detach() : attach()));
  $('#reloadTabBtn').addEventListener('click', () => state.attached && chrome.tabs.reload(state.tabId, { bypassCache: true }));
  $('#disableCache').checked = state.settings.disableCache;
  $('#disableCache').addEventListener('change', (e) => {
    state.settings.disableCache = e.target.checked;
    saveSettings();
    if (state.attached) cdp('Network.setCacheDisabled', { cacheDisabled: e.target.checked }).catch(() => {});
  });
  let tabsTimer;
  const refreshSoon = () => { clearTimeout(tabsTimer); tabsTimer = setTimeout(refreshTabs, 300); };
  chrome.tabs.onCreated.addListener(refreshSoon);
  chrome.tabs.onRemoved.addListener(refreshSoon);
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.url || info.title) refreshSoon(); });

  // Intercept
  $('#interceptToggle').addEventListener('click', toggleIntercept);
  $('#fwdBtn').addEventListener('click', () => { const c = currentItem(); if (c) forwardItem(c); });
  $('#fwdRespBtn').addEventListener('click', () => { const c = currentItem(); if (c) forwardItem(c, true); });
  $('#dropBtn').addEventListener('click', () => { const c = currentItem(); if (c) dropItem(c); });
  $('#fwdAllBtn').addEventListener('click', () => releaseAll(true));
  $('#toRepeaterFromIntercept').addEventListener('click', () => {
    const c = currentItem();
    if (c) sendToRepeater(c.stage === 'request' ? c.raw : c.requestRaw, c.url);
  });
  $('#interceptEditor').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); const c = currentItem(); if (c) forwardItem(c); }
  });
  const bindCheck = (sel, key, after) => {
    $(sel).checked = state.settings[key];
    $(sel).addEventListener('change', (e) => { state.settings[key] = e.target.checked; saveSettings(); if (after) after(); });
  };
  const refetch = () => applyFetch().catch((e) => toast(e.message, 'error'));
  bindCheck('#optRequests', 'requests', refetch);
  bindCheck('#optResponses', 'responses', refetch);
  bindCheck('#optSkipStatic', 'skipStatic');
  $('#optFilter').value = state.settings.filter;
  $('#optFilter').addEventListener('input', (e) => {
    state.settings.filter = e.target.value;
    e.target.classList.toggle('invalid', !compileMatcher(e.target.value).valid);
    saveSettings();
  });
  $('#autoClearLog').addEventListener('click', async () => {
    state.autoLog = [];
    state.autoCount = 0;
    try { await chrome.runtime.sendMessage({ type: 'resetAutoCount' }); } catch { /* ignore */ }
    renderAutoLog();
    updateStatus();
  });

  // Auto mode is configured from the popup; react to storage changes live.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.autoTabId) {
      state.settings.autoTabId = changes.autoTabId.newValue ?? null;
      if (state.attached) applyFetch().catch(() => {});
      updateStatus();
      return;
    }
    if (area !== 'local' || !changes.settings) return;
    const s = changes.settings.newValue || {};
    const wasActive = autoActive();
    if ('autoMode' in s) state.settings.autoMode = s.autoMode;
    if (Array.isArray(s.autoRules)) state.settings.autoRules = s.autoRules;
    if (s.autoScope === 'tab' || s.autoScope === 'all') state.settings.autoScope = s.autoScope;
    if ('autoInclude' in s) state.settings.autoInclude = String(s.autoInclude || '');
    if ('autoExclude' in s) state.settings.autoExclude = String(s.autoExclude || '');
    if (autoActive() !== wasActive && state.attached) applyFetch().catch(() => {});
    updateStatus();
  });

  // The background worker rewrites requests on tabs it handles; show them in the Auto log too.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'autoRewrite' && msg.entry) recordAutoExternal(msg.entry);
  });

  // History
  $('#historyFilter').addEventListener('input', scheduleHistoryRender);
  $('#historyType').addEventListener('change', renderHistory);
  $('#historyMethod').addEventListener('change', renderHistory);
  $('#historyStatus').addEventListener('change', renderHistory);
  bindCheck('#historyHideStatic', 'historyHideStatic', renderHistory);
  bindCheck('#historySearchContent', 'historySearchContent', renderHistory);
  bindCheck('#prettyJson', 'prettyJson', renderHistoryDetail);
  $('#historyTable tbody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr');
    if (!tr) return;
    state.selectedHistoryId = Number(tr.dataset.id);
    for (const row of $$('#historyTable tbody tr.selected')) row.classList.remove('selected');
    tr.classList.add('selected');
    renderHistoryDetail();
  });
  $('#historyTable tbody').addEventListener('dblclick', () => $('#histToRepeater').click());
  $('#histToRepeater').addEventListener('click', () => { const e = selectedHistory(); if (e) sendToRepeater(historyRequestRaw(e, false), e.url); });
  $('#histCurl').addEventListener('click', () => { const e = selectedHistory(); if (e) copyText(HTTP.toCurl({ method: e.method, url: e.url, headers: e.reqHeaders, body: e.reqBody }), 'cURL command copied'); });
  $('#histCopyReq').addEventListener('click', () => { const e = selectedHistory(); if (e) copyText(historyRequestRaw(e, false), 'Request copied'); });
  $('#histCopyResp').addEventListener('click', () => { const e = selectedHistory(); if (e) copyText(historyResponseRaw(e, false), 'Response copied'); });
  $('#histCompare').addEventListener('click', () => {
    const e = selectedHistory();
    if (e) sendToComparer(historyResponseRaw(e, false), `#${e.id} ${e.status || ''} ${shortUrl(e.url)}`);
  });
  $('#importHar').addEventListener('click', () => $('#importHarFile').click());
  $('#importHarFile').addEventListener('change', (e) => importHarFile(e.target.files && e.target.files[0]));
  $('#exportHar').addEventListener('click', exportHar);
  $('#clearHistory').addEventListener('click', () => {
    state.history = [];
    state.selectedHistoryId = null;
    $('#historyCount').textContent = '0';
    renderHistory();
    renderHistoryDetail();
  });

  // Repeater
  $('#repNew').addEventListener('click', () => newRepeater());
  $('#repEditor').addEventListener('input', (e) => {
    const r = activeRepeater();
    if (!r) return;
    r.raw = e.target.value;
    saveRepeaters();
  });
  $('#repEditor').addEventListener('change', renderRepeater); // refresh tab name
  $('#repEditor').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); const r = activeRepeater(); if (r) sendRepeater(r); }
  });
  $('#repTarget').addEventListener('input', (e) => { const r = activeRepeater(); if (r) { r.target = e.target.value; saveRepeaters(); } });
  $('#repFollow').addEventListener('change', (e) => { const r = activeRepeater(); if (r) { r.follow = e.target.checked; saveRepeaters(); } });
  $('#repPretty').checked = state.settings.repPretty;
  $('#repPretty').addEventListener('change', (e) => { state.settings.repPretty = e.target.checked; saveSettings(); renderRepeaterResponse(); });
  $('#repRemember').checked = state.settings.repRemember;
  $('#repRemember').addEventListener('change', (e) => {
    state.settings.repRemember = e.target.checked;
    saveSettings();
    saveRepeaters();
    toast(e.target.checked ? 'Repeater tabs will be saved locally.' : 'Saved Repeater data cleared.');
  });
  $('#repSend').addEventListener('click', () => { const r = activeRepeater(); if (r) sendRepeater(r); });
  $('#repCancel').addEventListener('click', () => { const r = activeRepeater(); if (r && r.abort) r.abort.abort(); });
  $('#repCompare').addEventListener('click', () => {
    const r = activeRepeater();
    const snapshot = r?.snapshots?.find((item) => String(item.id) === String(r.snapshotId));
    if (r && r.response) sendToComparer(snapshot?.response || r.response, `Repeater ${r.id} · ${repeaterName(r.raw)}`);
  });
  $('#repViewRes').addEventListener('click', () => { const r = activeRepeater(); if (r) { r.view = 'res'; renderRepeaterResponse(); } });
  $('#repViewSent').addEventListener('click', () => { const r = activeRepeater(); if (r) { r.view = 'sent'; renderRepeaterResponse(); } });

  // Comparer
  let compareTimer;
  for (const [selector, key, label] of [['#compareA', 'left', 'edited text'], ['#compareB', 'right', 'edited text']]) {
    $(selector).addEventListener('input', (e) => {
      state.compare[key] = e.target.value;
      state.compare[`${key}Label`] = label;
      clearTimeout(compareTimer);
      compareTimer = setTimeout(runCompare, 120);
    });
  }
  $('#compareRun').addEventListener('click', runCompare);
  $('#compareSwap').addEventListener('click', () => {
    [state.compare.left, state.compare.right] = [state.compare.right, state.compare.left];
    [state.compare.leftLabel, state.compare.rightLabel] = [state.compare.rightLabel, state.compare.leftLabel];
    renderComparer();
  });
  $('#compareClear').addEventListener('click', clearComparer);
  $('#compareCopy').addEventListener('click', () => copyText(state.compare.unified || '', 'Unified diff copied'));
  $('#comparePretty').addEventListener('change', (e) => {
    state.settings.comparePretty = e.target.checked;
    saveSettings();
    runCompare();
  });

  // Decoder
  $('#decoderRun').addEventListener('click', runDecoder);
  $('#decoderInput').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runDecoder(); }
  });
  $('#decoderSwap').addEventListener('click', () => {
    $('#decoderInput').value = $('#decoderOutput').value;
    $('#decoderOutput').value = '';
    $('#decoderInput').focus();
  });
  $('#decoderClear').addEventListener('click', () => {
    decoderGeneration++;
    $('#decoderInput').value = '';
    $('#decoderOutput').value = '';
    $('#decoderMeta').textContent = 'Everything runs locally.';
  });
  $('#decoderCopy').addEventListener('click', () => copyText($('#decoderOutput').value, 'Output copied'));

  // Detaching releases every paused request, so the target tab never hangs.
  window.addEventListener('pagehide', () => {
    closingDashboard = true;
    if (state.attached) chrome.debugger.detach({ tabId: state.tabId }).catch(() => {});
    chrome.storage.session.set({ attachedTabId: false, attachedHost: '' }).catch(() => {});
    // Hand the tab back to Auto mode (best-effort during unload).
    chrome.storage.session.set({ dashboardTabId: null }).catch(() => {});
  });
}

async function cleanupStale() {
  // Clear this dashboard's leftover Repeater header rules from a previous run.
  // (Do NOT detach debugger targets here — the background worker's Auto-mode
  //  sessions are legitimate attachments we must not kill.)
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules.filter((r) => r.id >= 1000 && r.id < 101000).map((r) => r.id);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    await chrome.storage.session.set({ repeaterRuleIds: [] });
  } catch { /* ignore */ }
  // A fresh dashboard hasn't claimed any tab yet; drop a stale claim from a prior crash.
  try { await chrome.storage.session.set({ dashboardTabId: null }); } catch { /* ignore */ }
}

(async function init() {
  await cleanupStale();
  await loadSettings();
  try {
    const status = await chrome.runtime.sendMessage({ type: 'getAutoStatus' });
    if (typeof status?.count === 'number') state.autoCount = status.count;
  } catch { /* worker unavailable */ }
  bindUi();
  await refreshTabs();
  await loadRepeaters();
  await bindWorkflow();
  await bindLab();
  updateStatus();
  renderQueue();
  renderAutoLog();
  renderHistory();
  renderComparer();
})();
