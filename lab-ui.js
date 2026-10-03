'use strict';
/* global Lab, LocalStore, HTTP, Workflow, state, workflowState, $, $$, toast,
   escapeHtml, fmtSize, saveSettings, saveRepeaters, newRepeater, activeRepeater,
   sendRepeater, repeaterBusy, workspaceVariableText, downloadLocal, switchView,
   renderCollections, renderRepeater, renderHistory, renderHistoryDetail,
   renderComparer, renderRunner, renderAutoLog, pruneHistory, historyRequestRaw,
   historyResponseRaw, openInspector, addCollection, copyText, setRaw, Layout */
const labState = {
  ready: false, storageBlocked: false, environments: [], environmentId: null, environmentSeq: 0,
  findings: [], websocketFrames: [], wsSeq: 0, wsSelected: null, interceptDrafts: [],
  activeTest: false, controller: null, comparison: null, builder: null, pendingBackup: null,
};
const socketUrls = new Map();
let localSaveTimer, localSavePromise = Promise.resolve();
let localSaveStarted = 0;
// Only drafts and view preferences, never file inputs, passwords used for backups,
// live tab IDs, debugger handles, or transient controllers.
const draftFields = [
  'builderMethod', 'builderUrl', 'builderAuth', 'builderAuthName', 'builderAuthValue',
  'builderHeaders', 'builderBodyMode', 'builderBody', 'builderAssertions',
  'runnerTarget', 'runnerRequest', 'runnerPayloads', 'runnerDelay', 'runnerTimeout', 'runnerMatch', 'runnerAssertions',
  'inspectTarget', 'inspectRequest', 'inspectResponse', 'decoderAction', 'decoderInput', 'decoderOutput',
  'historyFilter', 'historyMethod', 'historyStatus', 'historyType', 'siteMapFilter', 'siteMapHideStatic', 'collectionFilter', 'repTimeout', 'wsFilter',
];

function captureWorkspace() {
  const settings = { ...state.settings, repRemember: true, workspaceRemember: true };
  delete settings.autoTabId;
  const fields = {};
  for (const id of draftFields) {
    const input = $('#' + id);
    if (input) fields[id] = input.type === 'checkbox' ? input.checked : input.value;
  }
  return JSON.parse(JSON.stringify({
    format: 'interceptor-backup', version: 1, extensionVersion: chrome.runtime.getManifest().version,
    savedAt: new Date().toISOString(), workspace: {
      settings, fields, history: state.history.map(({ requestId, ...entry }) => entry),
      layout: Layout.capture(),
      selectedHistoryId: state.selectedHistoryId, seq: state.seq,
      repeaters: state.repeaters.map(({ abort, ...request }) => request), activeRepeaterId: state.activeRepeaterId,
      collections: workflowState.collections, selectedCollectionId: workflowState.selectedCollectionId,
      variables: workflowState.variables, environments: labState.environments, environmentId: labState.environmentId,
      autoLog: state.autoLog, autoCount: state.autoCount, compare: state.compare,
      runnerResults: workflowState.runner.results, runnerSelectedId: workflowState.runner.selectedId, runnerPlanned: workflowState.runner.planned,
      findings: labState.findings, websocketFrames: labState.websocketFrames,
      builder: labState.builder ? (({ abort, ...rest }) => rest)(labState.builder) : null,
      comparison: labState.comparison,
      interceptDrafts: [...labState.interceptDrafts, ...state.queue.map((item) => ({ raw: item.raw || '', url: item.url || '', stage: item.stage }))].slice(-100),
    },
  }));
}

function queueLocalSave() {
  if (!labState.ready || labState.storageBlocked) return;
  $('#localSaveStatus').textContent = 'Saving locally…';
  if (localSaveTimer && Date.now() - localSaveStarted > 1500) return;
  if (!localSaveTimer) localSaveStarted = Date.now();
  clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => { localSaveTimer = null; flushLocalSave().catch(() => {}); }, 350);
}

async function flushLocalSave() {
  if (!labState.ready) return;
  if (labState.storageBlocked) throw new Error('Saved workspace could not be read. Import a backup before saving over it.');
  clearTimeout(localSaveTimer);
  localSaveTimer = null;
  const snapshot = captureWorkspace();
  localSavePromise = localSavePromise.catch(() => {}).then(() => LocalStore.write(snapshot));
  try {
    await localSavePromise;
    $('#localSaveStatus').textContent = 'Saved on this PC · ' + new Date(snapshot.savedAt).toLocaleTimeString();
  } catch (error) {
    $('#localSaveStatus').textContent = 'Local save failed · download a backup';
    toast(`Local workspace could not be saved: ${error.message}`, 'error');
    throw error;
  }
  return snapshot;
}

function restoreWorkspace(workspace, imported = false) {
  // Files are validated before this point; no imported identifiers can attach a tab.
  for (const key of imported ? Object.keys(state.settings) : []) {
    if (['autoTabId', 'autoMode'].includes(key) || !Object.hasOwn(workspace.settings || {}, key)) continue;
    const value = workspace.settings[key];
    if (typeof value === typeof state.settings[key]) state.settings[key] = value;
  }
  if (imported) state.settings.autoMode = false;
  state.settings.repRemember = true;
  state.settings.workspaceRemember = true;
  state.history = workspace.history;
  pruneHistory();
  state.selectedHistoryId = state.history.some((item) => item.id === workspace.selectedHistoryId) ? workspace.selectedHistoryId : null;
  state.autoLog = workspace.autoLog;
  state.autoCount = Number(workspace.autoCount) || 0;
  state.seq = Math.max(0, ...state.history.map((e) => e.id), ...state.autoLog.map((e) => e.id));
  state.repeaters = workspace.repeaters.map((r) => ({ ...r, abort: null, assertions: r.assertions || '[]', tests: r.tests || [], snapshots: r.snapshots || [], view: r.view === 'sent' ? 'sent' : 'res' }));
  state.repSeq = Math.max(0, ...state.repeaters.map((r) => r.id));
  state.activeRepeaterId = state.repeaters.some((r) => r.id === workspace.activeRepeaterId) ? workspace.activeRepeaterId : state.repeaters[0]?.id;
  if (!state.repeaters.length) newRepeater();
  workflowState.remember = true;
  workflowState.variables = workspace.variables || '';
  workflowState.collections = Workflow.importCollection({ format: 'interceptor-collection', version: 1, requests: workspace.collections }).map((r, i) => ({ ...r, id: i + 1 }));
  workflowState.collectionSeq = workflowState.collections.length;
  const collectionIndex = workspace.collections.findIndex((item) => item.id === workspace.selectedCollectionId);
  workflowState.selectedCollectionId = collectionIndex < 0 ? workflowState.collections[0]?.id || null : collectionIndex + 1;
  labState.environments = workspace.environments.map((env, i) => ({ ...env, id: i + 1 }));
  labState.environmentSeq = labState.environments.length;
  const activeIndex = workspace.environments.findIndex((env) => env.id === workspace.environmentId);
  labState.environmentId = activeIndex < 0 ? null : activeIndex + 1;
  labState.findings = workspace.findings;
  labState.websocketFrames = workspace.websocketFrames;
  labState.wsSeq = Math.max(0, ...labState.websocketFrames.map((frame) => frame.id));
  labState.wsSelected = labState.websocketFrames.at(-1)?.id;
  workflowState.runner.results = workspace.runnerResults;
  workflowState.runner.selectedId = workspace.runnerResults.some((r) => r.id === workspace.runnerSelectedId) ? workspace.runnerSelectedId : workspace.runnerResults[0]?.id || null;
  workflowState.runner.planned = Math.max(workspace.runnerResults.length, Math.min(50, Number(workspace.runnerPlanned) || 0));
  state.compare = { left: '', right: '', leftLabel: '', rightLabel: '', unified: '', ...(workspace.compare || {}) };
  labState.builder = workspace.builder ? { ...workspace.builder, abort: null } : null;
  labState.comparison = workspace.comparison || null;
  labState.interceptDrafts = workspace.interceptDrafts || [];
  for (const id of draftFields) {
    const input = $('#' + id), value = workspace.fields?.[id];
    if (!input || value == null) continue;
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = String(value);
  }
  $('#workspaceVariables').value = workflowState.variables;
  $('#repRemember').checked = true;
  $('#workspaceRemember').checked = true;
  if (imported) {
    for (const [id, key] of Object.entries({ disableCache: 'disableCache', optRequests: 'requests', optResponses: 'responses', optSkipStatic: 'skipStatic', historyHideStatic: 'historyHideStatic', historySearchContent: 'historySearchContent', prettyJson: 'prettyJson', repPretty: 'repPretty' })) $('#' + id).checked = !!state.settings[key];
    saveSettings(); updateStatus();
  }
  renderRepeater(); renderCollections(); renderHistory(); renderHistoryDetail(); renderComparer(); renderRunner(); renderAutoLog();
  renderWorkspace(); renderSecurity(); renderWebSockets(); renderBuilderResult();
  renderAssertionResults($('#runnerTests'), workflowState.runner.results.find((r) => r.id === workflowState.runner.selectedId)?.tests || []);
}

function renderAssertionResults(element, tests) {
  if (!element) return;
  element.innerHTML = (tests || []).map((test) => `<span class="assertion-result ${test.pass ? 'pass' : 'fail'}" title="${escapeHtml(test.detail + ' · actual: ' + String(test.actual).slice(0, 300))}">${test.pass ? '✓' : '✕'} ${escapeHtml(test.label)}</span>`).join('');
}

function recordWorkbenchResponse(request, parsed, result, started) {
  let response;
  try { response = HTTP.parseResponse(request.response); }
  catch { response = { headers: [], body: request.response || '', statusText: '', httpVersion: 'HTTP/1.1' }; }
  let sent = parsed;
  try { if (request.sent) sent = HTTP.parseRequest(request.sent, parsed.url); } catch { /* use prepared request */ }
  const source = request.id === -2 ? 'API Builder' : request.id === -1 ? 'Runner' : [-3, -4].includes(request.id) ? 'Credential comparison' : 'Repeater';
  state.history.push({
    id: ++state.seq, method: sent.method, url: result.url || parsed.url,
    reqHeaders: HTTP.headersToList(sent.headers), reqBody: limitBody(sent.body, 'request body'),
    resHeaders: HTTP.headersToList(response.headers), resBody: limitBody(response.body, 'response body'),
    type: 'Fetch', wallTime: Date.now() - (performance.now() - started), ts: started / 1000,
    status: result.status, statusText: response.statusText || '', httpVersion: response.httpVersion || 'HTTP/1.1',
    size: result.bytes, duration: result.duration, state: result.error ? 'failed' : 'done', error: result.error || null,
    mime: HTTP.getHeader(response.headers, 'content-type') || '', note: source, source,
    edited: false, reqExtra: false, resExtra: false,
  });
  pruneHistory(); scheduleHistoryRender(); queueLocalSave();
}

function addEnvironment(name = 'New environment', variables = '') {
  if (labState.environments.length >= 50) throw new Error('Keep up to 50 environments.');
  const env = { id: ++labState.environmentSeq, name: name.slice(0, 100), variables: variables.slice(0, 100_000) };
  labState.environments.push(env);
  labState.environmentId = env.id;
  renderWorkspace(); queueLocalSave();
  return env;
}

function renderWorkspace() {
  const counts = { 'History entries': state.history.length, 'Repeater tabs': state.repeaters.length, 'Saved requests': workflowState.collections.length, 'Run results': workflowState.runner.results.length, 'Observations': labState.findings.length, 'Socket frames': labState.websocketFrames.length };
  $('#workspaceCounts').innerHTML = Object.entries(counts).map(([label, value]) => `<span><b>${value}</b>${label}</span>`).join('');
  $('#environmentSelect').innerHTML = '<option value="">Shared variables only</option>' + labState.environments.map((env) => `<option value="${env.id}">${escapeHtml(env.name)}</option>`).join('');
  $('#environmentSelect').value = labState.environmentId || '';
  const env = labState.environments.find((item) => item.id === labState.environmentId);
  for (const [id, key] of [['environmentName', 'name'], ['environmentVariables', 'variables']]) {
    const input = $('#' + id);
    input.disabled = !env;
    if (document.activeElement !== input) input.value = env?.[key] || '';
  }
  $('#environmentDelete').disabled = !env;
  $('#recoveredDrafts').innerHTML = labState.interceptDrafts.map((draft, i) => `<div class="toolbar small"><span>${escapeHtml(draft.stage + ' · ' + draft.url)}</span><button data-draft="${i}">Open saved text</button></div>`).join('') || '<p>No paused edits recovered from an earlier session.</p>';
  try { $('#environmentMeta').textContent = `${Object.keys(Workflow.variablesFromText(workspaceVariableText())).length} effective variables · ${env?.name || 'shared values'} active`; }
  catch (error) { $('#environmentMeta').textContent = error.message; }
}

function buildApiRequest() {
  const variableText = workspaceVariableText();
  const variables = Workflow.variablesFromText(variableText);
  const urlText = $('#builderUrl').value.trim();
  const url = new URL(Workflow.interpolate(urlText, variables));
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.');
  let headers = $('#builderHeaders').value.trim();
  const auth = $('#builderAuth').value;
  const name = ['basic', 'apikey'].includes(auth) ? Workflow.interpolate($('#builderAuthName').value, variables) : '';
  const value = auth === 'none' ? '' : Workflow.interpolate($('#builderAuthValue').value, variables);
  let authHeader = '';
  if (auth === 'bearer') authHeader = 'Authorization: Bearer ' + $('#builderAuthValue').value;
  if (auth === 'basic') authHeader = 'Authorization: Basic ' + HTTP.utf8ToB64(name + ':' + value);
  if (auth === 'apikey') {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) throw new Error('Enter a valid API key header name.');
    authHeader = name + ': ' + $('#builderAuthValue').value;
  }
  if (/[\r\n]/.test(name + value)) throw new Error('Authentication values cannot contain line breaks.');
  if (authHeader) {
    const headerName = authHeader.split(':')[0].toLowerCase();
    headers = headers.split('\n').filter((line) => line.split(':')[0].trim().toLowerCase() !== headerName).filter(Boolean).join('\n');
    headers = [headers, authHeader].filter(Boolean).join('\n');
  }
  const mode = $('#builderBodyMode').value;
  let body = mode === 'none' ? '' : $('#builderBody').value;
  let contentType = '';
  if (mode === 'json') { JSON.parse(Workflow.interpolate(body, variables)); contentType = 'application/json'; }
  if (mode === 'form') {
    const fields = body.split(/\r?\n/).filter((line) => line.trim());
    body = fields.map((line) => {
      const at = line.indexOf('=');
      if (at < 1) throw new Error('Form fields use name=value, one per line.');
      return Workflow.encodeFormTemplate(line.slice(0, at)) + '=' + Workflow.encodeFormTemplate(line.slice(at + 1));
    }).join('&');
    contentType = 'application/x-www-form-urlencoded';
  }
  if (contentType && !/^content-type:/im.test(headers)) headers = [headers, 'Content-Type: ' + contentType].filter(Boolean).join('\n');
  const assertions = $('#builderAssertions').value;
  Lab.parseAssertions(assertions);
  const raw = `${$('#builderMethod').value} ${urlText} HTTP/1.1${headers ? '\n' + headers : ''}\n\n${body}`;
  const prepared = Workflow.prepareRequest(raw, url.origin, variableText);
  if (raw.length > 500_000 || prepared.raw.length > 500_000) throw new Error('Builder requests are limited to 500,000 draft and expanded characters.');
  return { raw, target: prepared.target, follow: false, assertions };
}

function renderBuilderResult() {
  const r = labState.builder;
  $('#builderSend').disabled = !!r?.abort;
  $('#builderCancel').disabled = !r?.abort;
  $('#builderMeta').textContent = r?.abort ? 'Sending…' : r?.meta || 'Ready';
  setRaw($('#builderResponse'), r?.response || 'Build a request, then click Send request.');
  renderAssertionResults($('#builderTests'), r?.tests || []);
}

async function sendBuilder() {
  if (repeaterBusy || workflowState.runner.running || labState.activeTest) return toast('Finish or stop the current request first.', 'error');
  try {
    const r = { id: -2, ...buildApiRequest(), response: '', sent: '', tests: [], meta: '', abort: null };
    labState.builder = r;
    const promise = sendRepeater(r, { quiet: true });
    renderBuilderResult();
    await promise;
    renderBuilderResult(); queueLocalSave();
  } catch (error) { toast(error.message, 'error'); }
}

function renderSecurity() {
  const filter = $('#securityFilter').value;
  const visible = labState.findings.filter((item) => filter === 'all' || (['review', 'info'].includes(filter) ? item.severity === filter : item.status === filter));
  $('#securityFindings').innerHTML = visible.map((item) => `<article class="finding"><div class="finding-title"><span class="finding-tag ${escapeHtml(item.severity)}">${item.severity === 'review' ? 'Needs review' : 'Context'}</span><h2>${escapeHtml(item.title)}</h2><span class="finding-tag">${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.url)}</p><code>${escapeHtml(item.evidence)}</code><p>${escapeHtml(item.advice)}</p><div class="toolbar small"><button data-finding-history="${item.entryId}">Open evidence</button><button data-finding-id="${item.id}" data-status="reviewed">Mark reviewed</button><button data-finding-id="${item.id}" data-status="${item.status === 'ignored' ? 'open' : 'ignored'}">${item.status === 'ignored' ? 'Reopen' : 'Ignore'}</button></div></article>`).join('') || '<div class="empty">Review captured HTTP History to check transport, CORS, security headers, cookies, cache policies, URL credentials, and debug responses. Observations guide manual testing; they do not confirm vulnerabilities.</div>';
  $('#securityMeta').textContent = `${labState.findings.length} observations · ${visible.length} shown · passive review`;
  const currentSource = $('#securitySource').value;
  $('#securitySource').innerHTML = '<option value="repeater">Active Repeater tab</option>' + state.history.slice(-300).reverse().map((e) => `<option value="${e.id}">#${e.id} ${escapeHtml(e.method + ' ' + e.url.slice(0, 160))}</option>`).join('');
  if ([...$('#securitySource').options].some((option) => option.value === currentSource)) $('#securitySource').value = currentSource;
  $('#securityCompare').disabled = labState.activeTest;
  $('#securityStop').disabled = !labState.activeTest;
  $('#securityOpenDiff').disabled = !labState.comparison;
  $('#securityComparison').textContent = labState.comparison?.summary || '';
}

async function compareCredentials() {
  if (labState.activeTest || repeaterBusy || workflowState.runner.running) return toast('Finish or stop the current request first.', 'error');
  let original, stripped;
  try {
    const source = $('#securitySource').value;
    const entry = source === 'repeater' ? activeRepeater() : state.history.find((e) => e.id === Number(source));
    if (!entry) throw new Error('Choose a request first.');
    const raw = source === 'repeater' ? entry.raw : historyRequestRaw(entry, false);
    const target = source === 'repeater' ? entry.target : new URL(entry.url).origin;
    const prepared = Workflow.prepareRequest(raw, target, workspaceVariableText());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(prepared.parsed.method)) throw new Error('Credential comparison uses GET, HEAD or OPTIONS. Test state-changing requests individually in Repeater.');
    if (!prepared.parsed.headers.some((h) => /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i.test(h.name))) throw new Error('This request has no credential headers to compare.');
    original = { id: -3, raw: prepared.raw, target: prepared.target, follow: false, response: '', sent: '', abort: null };
    stripped = { id: -4, ...Lab.withoutCredentials(prepared.raw, prepared.target), follow: false, response: '', sent: '', abort: null };
  } catch (error) { return toast(error.message, 'error'); }
  labState.activeTest = true;
  labState.controller = new AbortController();
  const signal = labState.controller.signal;
  renderSecurity();
  $('#securityComparison').textContent = 'Sending original request…';
  try {
    const a = await sendRepeater(original, { lab: true, quiet: true, signal });
    if (signal.aborted || a.error) throw new Error(a.error || 'Stopped');
    $('#securityComparison').textContent = 'Sending request without credential headers…';
    const b = await sendRepeater(stripped, { lab: true, quiet: true, signal });
    if (signal.aborted || b.error) throw new Error(b.error || 'Stopped');
    const same = HTTP.parseResponse(original.response).body === HTTP.parseResponse(stripped.response).body;
    const summary = `Original: ${a.status} · ${fmtSize(a.bytes)}\nWithout credential headers: ${b.status} · ${fmtSize(b.bytes)}\nBodies: ${same ? 'identical' : 'different'}${a.truncated || b.truncated ? ' (capped previews)' : ''}\n${b.status >= 200 && b.status < 300 ? 'Anonymous response succeeded. Check whether the endpoint/data is intended to be public; success alone does not prove an authorization flaw.' : 'Verify the anonymous response matches the intended access policy.'}`;
    labState.comparison = { left: original.response.slice(0, 1_000_000), right: stripped.response.slice(0, 1_000_000), summary };
  } catch (error) { labState.comparison = { left: '', right: '', summary: error.message }; }
  finally { labState.activeTest = false; labState.controller = null; renderSecurity(); queueLocalSave(); }
}

function captureWebSocket(method, params) {
  if (method === 'Network.webSocketCreated') { socketUrls.set(params.requestId, params.url); return; }
  if (method === 'Network.webSocketClosed') { socketUrls.delete(params.requestId); return; }
  if (!['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(method)) return;
  const frame = params.response;
  labState.websocketFrames.push({ id: ++labState.wsSeq, direction: method.endsWith('Sent') ? 'Sent' : 'Received', url: socketUrls.get(params.requestId) || '(unknown socket)', opcode: frame.opcode, data: String(frame.payloadData).slice(0, 20_000), truncated: String(frame.payloadData).length > 20_000, time: Date.now() });
  if (labState.websocketFrames.length > 1000) labState.websocketFrames.shift();
  if ($('#view-websocket').classList.contains('active')) renderWebSockets();
  queueLocalSave();
}

function renderWebSockets() {
  const filter = $('#wsFilter').value.toLowerCase();
  const visible = labState.websocketFrames.filter((frame) => (frame.url + ' ' + frame.data).toLowerCase().includes(filter));
  $('#wsTable tbody').innerHTML = visible.map((frame) => `<tr data-frame="${frame.id}" class="${frame.id === labState.wsSelected ? 'selected' : ''}"><td>${frame.id}</td><td>${escapeHtml(frame.direction)}</td><td title="${escapeHtml(frame.url)}">${escapeHtml(frame.url)}</td><td>${frame.opcode === 1 ? 'Text' : frame.opcode === 2 ? 'Binary (base64)' : 'Opcode ' + frame.opcode}</td><td>${escapeHtml(frame.data.slice(0, 100))}</td></tr>`).join('');
  $('#wsEmpty').classList.toggle('hidden', visible.length > 0);
  const frame = labState.websocketFrames.find((item) => item.id === labState.wsSelected);
  setRaw($('#wsData'), frame ? frame.data + (frame.truncated ? '\n[Frame preview truncated]' : '') : 'Select a frame to inspect its payload.');
  $('#wsDecode').disabled = !frame;
  $('#wsMeta').textContent = `${labState.websocketFrames.length} saved frames · ${state.attached ? 'attached tab' : 'attach a tab to capture'}`;
}

async function applyBackup(workspace) {
  if (state.attached || workflowState.runner.running || repeaterBusy || labState.activeTest || state.queue.length) throw new Error('Detach the tab and finish or cancel active requests before restoring a backup.');
  clearTimeout(localSaveTimer);
  if (labState.storageBlocked) { const previous = await LocalStore.read(); if (previous) await LocalStore.preserve(previous); }
  else { await flushLocalSave(); await LocalStore.preserve(captureWorkspace()); }
  labState.ready = false;
  try { restoreWorkspace(workspace, true); }
  finally { labState.ready = true; }
  if (workspace.layout) await Layout.restore(workspace.layout);
  labState.storageBlocked = false;
  saveSettings(); saveRepeaters();
  await flushLocalSave();
  toast('Workspace restored locally. Auto mode is off; attach and send requests when ready.');
}

async function bindLab() {
  await Layout.ready;
  state.settings.repRemember = true;
  workflowState.remember = true;
  state.settings.workspaceRemember = true;
  try {
    const saved = await LocalStore.read();
    if (saved) restoreWorkspace(Lab.validateBackup(saved));
  } catch (error) { labState.storageBlocked = true; toast(`Local workspace could not be restored: ${error.message}. The saved copy has been preserved. Import a backup to recover.`, 'error'); }
  labState.ready = true;
  clearTimeout(saveTimer); clearTimeout(workspaceSaveTimer);
  $('#repRemember').checked = true;
  $('#workspaceRemember').checked = true;
  $('#repAssertions').addEventListener('input', (event) => { const r = activeRepeater(); if (r) r.assertions = event.target.value; });
  for (const id of draftFields) { const input = $('#' + id); if (input?.tagName === 'TEXTAREA' || input?.tagName === 'INPUT' && input.type !== 'checkbox') input.maxLength = 1_000_000; }
  $('#inspectResponse').maxLength = 4_100_000;
  for (const id of ['repAssertions', 'runnerAssertions', 'builderAssertions', 'collectionAssertions', 'environmentVariables']) $('#' + id).maxLength = 100_000;
  $('#repEditor').maxLength = 1_000_000;
  $('#collectionAssertions').addEventListener('input', (event) => { const r = workflowState.collections.find((item) => item.id === workflowState.selectedCollectionId); if (r) r.assertions = event.target.value; });
  $('#collectionList').addEventListener('click', () => { $('#collectionAssertions').value = workflowState.collections.find((item) => item.id === workflowState.selectedCollectionId)?.assertions || '[]'; });
  $('#runnerTable').addEventListener('click', () => renderAssertionResults($('#runnerTests'), workflowState.runner.results.find((r) => r.id === workflowState.runner.selectedId)?.tests || []));
  $('#runnerLoadPreset').addEventListener('click', () => {
    if (workflowState.runner.running) return;
    $('#runnerPayloads').value = { numbers: '0\n1\n-1\n2147483647\n2147483648\n9007199254740993\n0.01', types: 'null\ntrue\nfalse\n0\n"0"\n[]\n{}', strings: '""\n" "\n"interceptor-test"\n"00000000"\n"é中"' }[$('#runnerPreset').value];
    queueLocalSave();
  });
  $('#builderSend').addEventListener('click', sendBuilder);
  $('#builderCancel').addEventListener('click', () => labState.builder?.abort?.abort());
  $('#builderReplay').addEventListener('click', () => { try { newRepeater(buildApiRequest()); switchView('repeater'); } catch (error) { toast(error.message, 'error'); } });
  $('#builderSave').addEventListener('click', () => { try { addCollection(buildApiRequest()); } catch (error) { toast(error.message, 'error'); } });
  $('#builderCurl').addEventListener('click', () => { try { const request = buildApiRequest(); const prepared = Workflow.prepareRequest(request.raw, request.target, workspaceVariableText()); copyText(HTTP.toCurl(prepared.parsed), 'cURL copied'); } catch (error) { toast(error.message, 'error'); } });
  $('#builderInspect').addEventListener('click', () => { try { const request = buildApiRequest(); openInspector(request.raw, request.target, labState.builder?.response || '', 'API Builder'); } catch (error) { toast(error.message, 'error'); } });
  const updateAuth = () => { $('#builderAuthFields').classList.toggle('hidden', $('#builderAuth').value === 'none'); $('#builderAuthName').disabled = $('#builderAuth').value === 'bearer'; };
  $('#builderAuth').addEventListener('change', updateAuth); updateAuth();
  $('#securityScan').addEventListener('click', () => {
    const key = (item) => `${item.code}|${item.url}|${item.evidence}`;
    const previous = new Map(labState.findings.map((item) => [key(item), item.status]));
    labState.findings = Lab.passiveReview(state.history).map((item) => ({ ...item, status: previous.get(key(item)) || 'open' }));
    renderSecurity(); queueLocalSave();
  });
  $('#securityFilter').addEventListener('change', renderSecurity);
  $('#securityFindings').addEventListener('click', (event) => {
    const history = event.target.closest('[data-finding-history]');
    if (history) { state.selectedHistoryId = Number(history.dataset.findingHistory); switchView('history'); }
    const action = event.target.closest('[data-finding-id]');
    if (action) { const finding = labState.findings.find((item) => item.id === Number(action.dataset.findingId)); if (finding) finding.status = action.dataset.status; renderSecurity(); queueLocalSave(); }
  });
  $('#securityExport').addEventListener('click', () => downloadLocal(JSON.stringify({ format: 'interceptor-security-review', version: 1, generatedAt: new Date().toISOString(), findings: labState.findings }, null, 2), 'interceptor-security-review.json'));
  $('#securityCompare').addEventListener('click', compareCredentials);
  $('#securityStop').addEventListener('click', () => labState.controller?.abort());
  $('#securityOpenDiff').addEventListener('click', () => { const c = labState.comparison; if (c) { state.compare = { left: c.left, right: c.right, leftLabel: 'Original credentials', rightLabel: 'Without credential headers', unified: '' }; switchView('comparer'); } });
  $('#wsFilter').addEventListener('input', renderWebSockets);
  $('#wsTable').addEventListener('click', (event) => { const row = event.target.closest('[data-frame]'); if (row) { labState.wsSelected = Number(row.dataset.frame); renderWebSockets(); } });
  $('#wsExport').addEventListener('click', () => downloadLocal(JSON.stringify({ format: 'interceptor-websocket-frames', version: 1, frames: labState.websocketFrames }, null, 2), 'interceptor-websocket-frames.json'));
  $('#wsClear').addEventListener('click', () => { labState.websocketFrames = []; labState.wsSelected = null; renderWebSockets(); queueLocalSave(); });
  $('#wsDecode').addEventListener('click', () => { const frame = labState.websocketFrames.find((item) => item.id === labState.wsSelected); if (frame) { $('#decoderInput').value = frame.data; $('#decoderAction').value = frame.opcode === 2 ? 'base64-decode' : 'json-pretty'; switchView('decoder'); } });
  $('#environmentNew').addEventListener('click', () => { try { addEnvironment(); $('#environmentName').focus(); } catch (error) { toast(error.message, 'error'); } });
  $('#environmentSelect').addEventListener('change', (event) => { labState.environmentId = Number(event.target.value) || null; renderWorkspace(); queueLocalSave(); });
  $('#environmentDelete').addEventListener('click', () => { labState.environments = labState.environments.filter((env) => env.id !== labState.environmentId); labState.environmentId = null; renderWorkspace(); queueLocalSave(); });
  for (const [id, key] of [['environmentName', 'name'], ['environmentVariables', 'variables']]) $('#' + id).addEventListener('input', (event) => {
    const env = labState.environments.find((item) => item.id === labState.environmentId);
    if (env) { env[key] = event.target.value.slice(0, key === 'name' ? 100 : 100_000); renderWorkspace(); queueLocalSave(); }
  });
  $('#workspaceSaveNow').addEventListener('click', () => flushLocalSave().catch(() => {}));
  $('#recoveredDrafts').addEventListener('click', (event) => { const action = event.target.closest('[data-draft]'); const draft = labState.interceptDrafts[Number(action?.dataset.draft)]; if (draft) { $('#decoderInput').value = draft.raw; switchView('decoder'); } });
  $('#backupDownload').addEventListener('click', async () => {
    try {
      // Keep export available when disk storage fails: this is the recovery path.
      const backup = captureWorkspace();
      if (!labState.storageBlocked) await flushLocalSave().catch(() => {});
      const password = $('#backupPassword').value;
      const output = password ? await Lab.encryptBackup(backup, password) : backup;
      downloadLocal(JSON.stringify(output), `interceptor-workspace-${new Date().toISOString().slice(0, 10)}${password ? '-encrypted' : ''}.json`);
      $('#backupPassword').value = '';
      toast(password ? 'Encrypted workspace backup downloaded.' : 'Workspace backup downloaded. It includes stored credentials.');
    } catch (error) { toast(error.message, 'error'); }
  });
  $('#backupImport').addEventListener('click', () => $('#backupFile').click());
  $('#backupFile').addEventListener('change', async (event) => {
    labState.pendingBackup = null; $('#backupPreview').classList.add('hidden');
    try {
      const file = event.target.files?.[0]; if (!file) return;
      if (file.size > 200_000_000) throw new Error('Backup files must be smaller than 200 MB.');
      let data = JSON.parse(await file.text());
      if (data.format === 'interceptor-encrypted-backup') data = await Lab.decryptBackup(data, $('#backupPassword').value);
      const workspace = Lab.validateBackup(data);
      labState.pendingBackup = workspace;
      $('#backupSummary').textContent = `Ready to restore ${workspace.history.length} history entries, ${workspace.repeaters.length} Repeater tabs, ${workspace.collections.length} requests, ${workspace.environments.length} environments, ${workspace.runnerResults.length} results, ${workspace.findings.length} observations and ${workspace.websocketFrames.length} frames. This replaces the current workspace; a local undo copy is kept. No requests are sent by importing.`;
      $('#backupPreview').classList.remove('hidden'); $('#backupPassword').value = '';
    } catch (error) { toast(`Backup import failed: ${error.message}`, 'error'); }
    finally { event.target.value = ''; }
  });
  $('#backupDismiss').addEventListener('click', () => { labState.pendingBackup = null; $('#backupPreview').classList.add('hidden'); });
  $('#backupRestore').addEventListener('click', async () => { try { if (labState.pendingBackup) { await applyBackup(labState.pendingBackup); labState.pendingBackup = null; $('#backupPreview').classList.add('hidden'); } } catch (error) { toast(error.message, 'error'); } });
  $('#workspaceUndoRestore').addEventListener('click', async () => { try { const previous = await LocalStore.previous(); if (!previous) throw new Error('No previous restore to undo.'); await applyBackup(Lab.validateBackup(previous)); } catch (error) { toast(error.message, 'error'); } });
  document.addEventListener('input', (event) => { if (event.target.id !== 'backupPassword' && event.target.type !== 'file') queueLocalSave(); });
  document.addEventListener('change', (event) => { if (event.target.type !== 'file' && event.target.id !== 'backupPassword') queueLocalSave(); });
  document.addEventListener('click', (event) => { if (event.target.closest('button') && !event.target.closest('#backupPreview')) queueLocalSave(); });
  window.addEventListener('pagehide', () => { flushLocalSave().catch(() => {}); });
  saveSettings(); saveRepeaters();
  renderWorkspace(); renderSecurity(); renderWebSockets(); renderBuilderResult();
  if (!labState.storageBlocked) {
    await flushLocalSave();
    await chrome.storage.local.remove(['repeaters', 'activeRepeaterId', 'workspace']);
  }
}
