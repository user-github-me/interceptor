'use strict';
/* global HTTP */
const $ = (s) => document.querySelector(s);
const defaultRules = () => [{ param: HTTP.DEFAULT_PARAMS, value: '1' }];
let settings = { autoMode: false, autoScope: 'all', autoTabId: null, autoRules: defaultRules() };
let activeTab = null; // {id, host, ok}

/** Accept old single-parameter settings and coerce to the current shape. */
function normalize(s) {
  s = s || {};
  let autoRules = Array.isArray(s.autoRules) ? s.autoRules : null;
  if (!autoRules) autoRules = s.autoParam ? [{ param: String(s.autoParam), value: s.autoValue ?? '1' }] : defaultRules();
  autoRules = autoRules.map((r) => ({ param: String(r.param ?? ''), value: String(r.value ?? '') }));
  if (!autoRules.length) autoRules = [{ param: '', value: '1' }];
  return {
    autoMode: !!s.autoMode,
    autoScope: s.autoScope === 'tab' ? 'tab' : 'all',
    autoTabId: typeof s.autoTabId === 'number' ? s.autoTabId : null,
    autoRules,
  };
}

const currentScope = () => (settings.autoMode ? settings.autoScope : 'off');

// ---- rules UI ----
function ruleRow(rule, i) {
  const row = document.createElement('div');
  row.className = 'rule';
  row.innerHTML =
    `<div class="field grow"><label>Field names (comma-separated)</label>` +
    `<textarea class="rp" rows="2" spellcheck="false" placeholder="amount, payableAmount, payingAmount"></textarea></div>` +
    `<div class="valcol"><div class="field"><label>Set to</label><input class="rv" spellcheck="false" placeholder="1"></div>` +
    `<button class="rx" title="Remove this rule">×</button></div>`;
  const rp = row.querySelector('.rp');
  const rv = row.querySelector('.rv');
  rp.value = rule.param;
  rv.value = rule.value;
  rp.addEventListener('input', () => { settings.autoRules[i].param = rp.value; save(); renderNote(); });
  rv.addEventListener('input', () => { settings.autoRules[i].value = rv.value; save(); renderNote(); });
  row.querySelector('.rx').addEventListener('click', () => {
    settings.autoRules.splice(i, 1);
    if (!settings.autoRules.length) settings.autoRules.push({ param: '', value: '1' });
    save(); renderRules();
  });
  return row;
}

function renderRules() {
  const box = $('#rules');
  box.innerHTML = '';
  settings.autoRules.forEach((rule, i) => box.append(ruleRow(rule, i)));
  const off = currentScope() === 'off';
  box.classList.toggle('disabled', off);
  $('#addRule').disabled = off;
  $('#resetRules').disabled = off;
  renderScope();
  renderNote();
}

function renderScope() {
  const scope = currentScope();
  for (const b of document.querySelectorAll('#scopeSeg button')) b.classList.toggle('active', b.dataset.scope === scope);
  const tabBtn = document.querySelector('#scopeSeg button[data-scope="tab"]');
  tabBtn.disabled = !(activeTab && activeTab.ok);
  const info = $('#scopeInfo');
  if (scope === 'off') info.textContent = 'Auto mode is off. Pick a scope to start — no attach step needed.';
  else if (scope === 'tab') {
    const host = settings.autoTabId === (activeTab && activeTab.id) && activeTab ? activeTab.host : '(the chosen tab)';
    info.textContent = `Active on this tab: ${host}`;
  } else info.textContent = 'Active on every http/https tab (and new ones as they open).';
  info.className = 'scope-info' + (scope === 'off' ? '' : ' on');
}

function renderNote() {
  const names = settings.autoRules.flatMap((r) => HTTP.splitNames(r.param));
  const note = $('#ruleNote');
  if (currentScope() === 'off') { note.textContent = ''; return; }
  const values = settings.autoRules.map((r) => r.value).filter((v, i, a) => a.indexOf(v) === i).join(' / ');
  note.textContent = names.length
    ? `Forcing ${names.length} field name${names.length > 1 ? 's' : ''} → ${values}`
    : 'No field names set — add at least one above.';
}

// ---- persistence ----
async function save() {
  try {
    const { settings: cur } = await chrome.storage.local.get('settings');
    const merged = { ...(cur || {}), autoMode: settings.autoMode, autoScope: settings.autoScope, autoTabId: settings.autoTabId, autoRules: settings.autoRules };
    delete merged.autoParam;
    delete merged.autoValue;
    await chrome.storage.local.set({ settings: merged });
  } catch { /* ignore */ }
  refreshStatus();
}

function setScope(scope) {
  if (scope === 'off') settings.autoMode = false;
  else if (scope === 'tab') {
    if (!(activeTab && activeTab.ok)) return;
    settings.autoMode = true; settings.autoScope = 'tab'; settings.autoTabId = activeTab.id;
  } else {
    settings.autoMode = true; settings.autoScope = 'all';
  }
  save(); renderRules();
}

// ---- status ----
async function refreshStatus() {
  const pill = $('#attach');
  let status = null;
  try { status = await chrome.runtime.sendMessage({ type: 'getAutoStatus' }); } catch { /* worker asleep */ }
  const open = await isPanelOpen();
  if (status && status.on) {
    pill.className = 'pill on';
    const n = status.attached ? status.attached.length : 0;
    pill.textContent = `auto on · ${n} tab${n === 1 ? '' : 's'}`;
    $('#foot').textContent = status.count ? `${status.count} request${status.count === 1 ? '' : 's'} rewritten so far.` : 'Waiting for a matching request…';
  } else {
    pill.className = 'pill off';
    pill.textContent = 'auto off';
    $('#foot').textContent = open ? '' : 'Turn on a scope above, then use your app.';
  }
}

async function isPanelOpen() {
  try {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('dashboard.html') });
    return tabs.length > 0;
  } catch { return false; }
}

async function openPanel() {
  const url = chrome.runtime.getURL('dashboard.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

async function findActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      let host = '', ok = false;
      try { const u = new URL(tab.url || tab.pendingUrl || ''); host = u.host; ok = /^https?:$/.test(u.protocol); } catch { /* ignore */ }
      activeTab = { id: tab.id, host, ok };
    }
  } catch { activeTab = null; }
}

(async function init() {
  try {
    const { settings: stored } = await chrome.storage.local.get('settings');
    settings = normalize(stored);
  } catch { settings = normalize(null); }
  await findActiveTab();
  renderRules();
  refreshStatus();

  for (const b of document.querySelectorAll('#scopeSeg button')) {
    b.addEventListener('click', () => setScope(b.dataset.scope));
  }
  $('#addRule').addEventListener('click', () => {
    settings.autoRules.push({ param: '', value: settings.autoRules.at(-1)?.value || '1' });
    save(); renderRules();
    const last = document.querySelector('#rules .rule:last-child .rp');
    if (last) last.focus();
  });
  $('#resetRules').addEventListener('click', () => { settings.autoRules = defaultRules(); save(); renderRules(); });
  $('#openPanel').addEventListener('click', openPanel);

  // Reflect edits made elsewhere (e.g. the panel) while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings && document.activeElement === document.body) {
      settings = normalize(changes.settings.newValue);
      renderRules();
    }
    if (area === 'session') refreshStatus();
  });
})();
