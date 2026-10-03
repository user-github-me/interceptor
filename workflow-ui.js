'use strict';
/* global HTTP, Workbench, Workflow, state, $, $$, toast, escapeHtml, fmtMs, fmtSize,
   isStatic, selectedHistory, historyRequestRaw, historyResponseRaw, activeRepeater,
   newRepeater, sendRepeater, sendToRepeater, sendToComparer, renderRepeaterResponse,
   switchView, renderHistory, renderHistoryDetail, saveSettings, DEFAULT_RAW,
   repeaterName, repeaterBusy, copyText, setRaw */

const workflowState = {
  variables: '', remember: false, collections: [], collectionSeq: 0, selectedCollectionId: null,
  endpoints: [], inspector: null,
  runner: { running: false, controller: null, results: [], selectedId: null, planned: 0 },
};
const workspaceVariableText = () => workflowState.variables;

function downloadLocal(text, name, type = 'application/json') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

let workspaceSaveTimer;
function saveWorkspace() {
  clearTimeout(workspaceSaveTimer);
  state.settings.workspaceRemember = workflowState.remember;
  saveSettings();
  if (!workflowState.remember) {
    chrome.storage.local.remove('workspace').catch(() => {});
    return;
  }
  workspaceSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ workspace: {
      format: 'interceptor-collection', version: 1,
      requests: workflowState.collections.map(({ name, folder, raw, target, follow, notes }) => ({ name, folder, raw, target, follow, notes })),
      variables: workflowState.variables,
    } }).catch((error) => toast(`Workspace could not be saved: ${error.message}`, 'error'));
  }, 250);
}

function addCollection(request) {
  if (workflowState.collections.length >= 100) return toast('Collections are limited to 100 requests. Export or remove older requests first.', 'error');
  if (request.raw.length > 500_000) return toast('This request is too large for Collections (500,000 characters maximum).', 'error');
  if (workflowState.collections.reduce((n, item) => n + item.raw.length, 0) + request.raw.length > 5_000_000) return toast('Collection request text is limited to 5 million characters.', 'error');
  const item = {
    id: ++workflowState.collectionSeq, name: request.name || repeaterName(request.raw),
    folder: request.folder || 'General', notes: request.notes || '',
    raw: request.raw, target: request.target, follow: !!request.follow,
  };
  workflowState.collections.push(item);
  workflowState.selectedCollectionId = item.id;
  saveWorkspace();
  switchView('collections');
  renderCollections();
  toast(workflowState.remember ? 'Request saved locally.' : 'Request added to this workspace.');
  return item;
}

const selectedCollection = () => workflowState.collections.find((item) => item.id === workflowState.selectedCollectionId);

function renderCollections() {
  const filter = $('#collectionFilter').value.toLowerCase();
  const visible = workflowState.collections.filter((item) => `${item.name} ${item.folder} ${item.target}`.toLowerCase().includes(filter));
  const folders = [...new Set(visible.map((item) => item.folder || 'General'))].sort();
  const html = [];
  for (const folder of folders) {
    html.push(`<div class="collection-group">${escapeHtml(folder)}</div>`);
    for (const item of visible.filter((request) => (request.folder || 'General') === folder)) {
      const method = item.raw.match(/^\s*(\S+)/)?.[1] || '';
      html.push(`<button class="collection-item${item.id === workflowState.selectedCollectionId ? ' active' : ''}" data-id="${item.id}" title="${escapeHtml(item.name)}"><span class="m">${escapeHtml(method)}</span>${escapeHtml(item.name)}</button>`);
    }
  }
  $('#collectionList').innerHTML = html.join('');
  $('#collectionCount').textContent = String(workflowState.collections.length);
  $('#collectionEmpty').classList.toggle('hidden', visible.length > 0);
  $('#collectionMeta').textContent = workflowState.remember ? 'Saved locally · requests and variables' : 'In memory · export to keep a copy';
  $('#workspaceRemember').checked = workflowState.remember;
  const item = selectedCollection();
  const fields = { collectionName: 'name', collectionFolder: 'folder', collectionTarget: 'target', collectionRaw: 'raw', collectionNotes: 'notes' };
  for (const [id, key] of Object.entries(fields)) {
    const input = $('#' + id);
    if (document.activeElement !== input) input.value = item?.[key] || '';
    input.disabled = !item;
  }
  $('#collectionFollow').checked = !!item?.follow;
  $('#collectionFollow').disabled = !item;
  $('#collectionOpen').disabled = !item;
  $('#collectionDelete').disabled = !item;
}

function renderSiteMap() {
  const filter = $('#siteMapFilter').value.toLowerCase();
  const entries = state.history.filter((entry) => !$('#siteMapHideStatic').checked || !isStatic(entry.type, entry.url));
  workflowState.endpoints = Workflow.siteMap(entries);
  const visible = workflowState.endpoints.filter((endpoint) => `${endpoint.method} ${endpoint.origin}${endpoint.path} ${endpoint.params.join(' ')}`.toLowerCase().includes(filter));
  $('#siteMapCount').textContent = String(workflowState.endpoints.length);
  $('#siteMapMeta').textContent = `${visible.length} endpoints · ${new Set(visible.map((item) => item.origin)).size} origins`;
  $('#siteMapTable tbody').innerHTML = visible.map((endpoint) => `<tr><td class="m">${escapeHtml(endpoint.method)}</td><td>${escapeHtml(endpoint.origin)}</td><td class="path" title="${escapeHtml(endpoint.path)}">${escapeHtml(endpoint.path)}</td><td>${endpoint.count}</td><td class="${endpoint.errors ? 's4' : 's2'}">${escapeHtml(endpoint.statuses.join(', '))}</td><td>${fmtMs(endpoint.averageMs)}</td><td title="${escapeHtml(endpoint.params.join(', '))}">${escapeHtml(endpoint.params.join(', '))}</td><td><button data-history="${endpoint.entryId}">History</button> <button data-replay="${endpoint.entryId}">Replay</button></td></tr>`).join('');
  $('#siteMapEmpty').classList.toggle('hidden', visible.length > 0);
}

function openInspector(raw, target, response = '', label = '') {
  $('#inspectRequest').value = raw;
  $('#inspectTarget').value = target;
  $('#inspectResponse').value = response;
  $('#inspectLabel').textContent = label;
  switchView('inspector');
  runInspector();
}

function runInspector() {
  try {
    const request = Workflow.prepareRequest($('#inspectRequest').value, $('#inspectTarget').value, workspaceVariableText());
    workflowState.inspector = Workflow.inspectRequest(request.raw, request.target, $('#inspectResponse').value);
    renderInspector();
  } catch (error) {
    workflowState.inspector = null;
    renderInspector();
    $('#inspectMeta').textContent = error.message;
    toast(`Inspect failed: ${error.message}`, 'error');
  }
}

function renderInspector() {
  const inspected = workflowState.inspector;
  const filter = $('#inspectFilter').value.toLowerCase();
  const fields = inspected?.fields || [];
  $('#inspectTable tbody').innerHTML = fields.map((field, i) => ({ ...field, i })).filter((field) => `${field.location} ${field.name} ${field.value}`.toLowerCase().includes(filter))
    .map((field) => `<tr><td>${escapeHtml(field.location)}</td><td>${escapeHtml(field.name)}</td><td>${escapeHtml(field.value)}</td><td><button class="mini" data-decode="${field.i}">Decode</button></td></tr>`).join('');
  $('#inspectEmpty').classList.toggle('hidden', fields.length > 0);
  $('#inspectMeta').textContent = inspected ? `${inspected.method} · ${fields.length} fields` : 'Ready';
  $('#inspectCopy').disabled = !inspected;
  $('#inspectCookies').className = inspected?.cookies.length ? '' : 'empty small';
  $('#inspectCookies').innerHTML = inspected?.cookies.length ? inspected.cookies.map((cookie) => `<div class="cookie-card"><strong>${escapeHtml(cookie.name)}</strong> = ${escapeHtml(cookie.value)}<div class="cookie-attributes"><span>${cookie.secure ? 'Secure' : 'No Secure attribute'}</span><span>${cookie.httpOnly ? 'HttpOnly' : 'No HttpOnly attribute'}</span><span>SameSite: ${escapeHtml(cookie.sameSite)}</span>${cookie.path ? `<span>Path: ${escapeHtml(cookie.path)}</span>` : ''}${cookie.domain ? `<span>Domain: ${escapeHtml(cookie.domain)}</span>` : ''}</div></div>`).join('') : 'No Set-Cookie headers in this response.';
  $('#inspectResponseHeaders').textContent = (inspected?.responseHeaders || []).map((header) => `${header.name}: ${header.value}`).join('\n');
  const notes = inspected?.notes || [];
  $('#inspectNotes').innerHTML = notes.length ? notes.map((note) => `<p>${escapeHtml(note)}</p>`).join('') : 'No additional observations. Header absence alone does not establish a vulnerability.';
}

function sendToRunner(raw, target) {
  if (workflowState.runner.running) return toast('Stop the current run before replacing its template.', 'error');
  $('#runnerRequest').value = raw;
  $('#runnerTarget').value = target;
  switchView('runner');
  $('#runnerRequest').focus();
  toast('Replace a value with {{payload}}, then add the values to test.');
}

function renderRunner() {
  const runner = workflowState.runner;
  $('#runnerStart').disabled = runner.running;
  $('#runnerStop').disabled = !runner.running;
  for (const id of ['runnerTarget', 'runnerRequest', 'runnerPayloads', 'runnerDelay', 'runnerTimeout', 'runnerMatch', 'runnerClear']) $('#' + id).disabled = runner.running;
  $('#runnerProgress').max = runner.planned || 1;
  $('#runnerProgress').value = runner.results.length;
  $('#runnerProgressText').textContent = `${runner.results.length} / ${runner.planned || 0} completed${runner.running ? ' · running' : ''}`;
  $('#runnerTable tbody').innerHTML = runner.results.map((row) => `<tr data-id="${row.id}" class="${row.id === runner.selectedId ? 'selected' : ''}"><td>${row.id}</td><td title="${escapeHtml(row.payload)}">${escapeHtml(row.payload)}</td><td class="${row.error ? 'sx' : 's' + String(row.status)[0]}">${escapeHtml(row.error || row.status)}</td><td>${fmtMs(row.duration)}</td><td>${fmtSize(row.bytes)}</td><td class="${row.check === true ? 'check-pass' : row.check === false ? 'check-fail' : ''}">${row.check == null ? '—' : row.check ? 'Match' : 'No match'}</td><td>${row.truncated ? 'preview capped' : ''}</td></tr>`).join('');
  $('#runnerEmpty').classList.toggle('hidden', runner.results.length > 0);
  const row = runner.results.find((result) => result.id === runner.selectedId);
  setRaw($('#runnerResponse'), row?.response || '');
  $('#runnerCompare').disabled = !row || runner.results.length < 2;
  $('#runnerToRepeater').disabled = !row;
  $('#runnerExport').disabled = !runner.results.length;
}

async function startRunner() {
  const runner = workflowState.runner;
  if (runner.running || repeaterBusy) return toast('Finish or cancel the current request first.', 'error');
  let requests;
  let payloads;
  const template = $('#runnerRequest').value;
  const target = $('#runnerTarget').value;
  const delayMs = Math.max(100, Math.min(10_000, Number($('#runnerDelay').value) || 250));
  const timeoutMs = Math.max(1, Math.min(120, Number($('#runnerTimeout').value) || 15)) * 1000;
  const match = $('#runnerMatch').value;
  try {
    if (template.length > 100_000) throw new Error('Runner templates are limited to 100,000 characters.');
    if (!/\{\{\s*payload\s*\}\}/.test(template)) throw new Error('Add {{payload}} to the request template.');
    if (/\{\{\s*payload\s*\}\}/.test(target)) throw new Error('Use {{payload}} in the request, keeping one target for the run.');
    payloads = Workflow.payloadsFromText($('#runnerPayloads').value);
    const variables = workspaceVariableText();
    requests = payloads.map((payload) => Workflow.prepareRequest(template, target, variables, { payload }));
    const origins = new Set(requests.map((request) => new URL(request.parsed.url).origin));
    if (origins.size !== 1) throw new Error('All payloads must use the same origin. Put the marker in a path, field, or header.');
  } catch (error) { return toast(error.message, 'error'); }
  runner.running = true;
  runner.results = [];
  runner.selectedId = null;
  runner.planned = requests.length;
  runner.controller = new AbortController();
  const signal = runner.controller.signal;
  $('#runnerMeta').textContent = 'Running…';
  renderRunner();
  try {
    for (let i = 0; i < requests.length && !signal.aborted; i++) {
      const request = requests[i];
      const replay = { id: -1, raw: request.raw, target: request.target, follow: false, response: '', sent: '', abort: null };
      const result = await sendRepeater(replay, { runner: true, quiet: true, signal, timeoutMs, prepared: request });
      const response = replay.response || result?.error || '';
      const row = { id: i + 1, payload: payloads[i], ...result, response: response.slice(0, 100_000) + (response.length > 100_000 ? '\n[Runner preview truncated]' : ''), raw: request.raw, target: request.target, check: match ? response.includes(match) : null };
      runner.results.push(row);
      runner.selectedId = row.id;
      renderRunner();
      if (signal.aborted || i === requests.length - 1) break;
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delayMs);
        signal.addEventListener('abort', finish, { once: true });
      });
    }
  } catch (error) { toast(`Run stopped: ${error.message}`, 'error'); }
  finally {
    runner.running = false;
    runner.controller = null;
    $('#runnerMeta').textContent = `${signal.aborted ? 'Stopped' : 'Finished'} · ${runner.results.length} requests · ${runner.results.filter((row) => row.error).length} errors`;
    renderRunner();
    renderRepeaterResponse();
  }
}

function renderToolList() {
  const filter = $('#toolSearch').value.toLowerCase();
  $('#toolList').innerHTML = $$('.tabs > button').filter((button) => button.textContent.toLowerCase().includes(filter)).map((button) => `<button data-tool="${button.dataset.view}">${escapeHtml(button.textContent.trim())}</button>`).join('');
}

async function bindWorkflow() {
  workflowState.remember = !!state.settings.workspaceRemember;
  if (workflowState.remember) {
    try {
      const { workspace } = await chrome.storage.local.get('workspace');
      if (workspace) {
        const requests = Workflow.importCollection(workspace);
        workflowState.collections = requests.map((request) => ({ ...request, id: ++workflowState.collectionSeq }));
        workflowState.variables = typeof workspace.variables === 'string' ? workspace.variables.slice(0, 100_000) : '';
        workflowState.selectedCollectionId = workflowState.collections[0]?.id || null;
      }
    } catch (error) { toast(`Saved workspace could not be loaded: ${error.message}`, 'error'); }
  }
  $('#workspaceVariables').value = workflowState.variables;

  $('#repImportCurl').addEventListener('click', () => { $('#curlError').textContent = ''; $('#curlDialog').showModal(); $('#curlInput').focus(); });
  $('#curlImportRun').addEventListener('click', () => {
    try {
      const request = Workflow.importCurl($('#curlInput').value);
      const replay = newRepeater(request);
      replay.follow = request.follow;
      $('#curlDialog').close();
      switchView('repeater');
      toast('cURL imported. Review it and click Send when ready.');
    } catch (error) { $('#curlError').textContent = error.message; }
  });
  $('#repDuplicate').addEventListener('click', () => { const request = activeRepeater(); if (request) { const copy = newRepeater(request); copy.follow = request.follow; } });
  $('#repSave').addEventListener('click', () => { const request = activeRepeater(); if (request) addCollection(request); });
  $('#repInspect').addEventListener('click', () => { const request = activeRepeater(); if (request) openInspector(request.raw, request.target, request.response, `Repeater ${request.id}`); });
  $('#repToRunner').addEventListener('click', () => { const request = activeRepeater(); if (request) sendToRunner(request.raw, request.target); });
  $('#repSnapshot').addEventListener('change', (event) => { const request = activeRepeater(); if (request) { request.snapshotId = event.target.value || null; renderRepeaterResponse(); } });
  $('#repComparePrevious').addEventListener('click', () => {
    const snapshots = activeRepeater()?.snapshots || [];
    if (snapshots.length < 2) return;
    const [left, right] = snapshots.slice(-2);
    state.compare = { left: left.response, right: right.response, leftLabel: left.label, rightLabel: right.label, unified: '' };
    switchView('comparer');
  });
  $('#histInspect').addEventListener('click', () => { const entry = selectedHistory(); if (entry) openInspector(historyRequestRaw(entry, false), entry.url, historyResponseRaw(entry, false), `History #${entry.id}`); });
  $('#histSave').addEventListener('click', () => {
    const entry = selectedHistory();
    if (entry) addCollection({ raw: historyRequestRaw(entry, false), target: new URL(entry.url).origin });
  });

  $('#siteMapFilter').addEventListener('input', renderSiteMap);
  $('#siteMapHideStatic').addEventListener('change', renderSiteMap);
  $('#siteMapRefresh').addEventListener('click', renderSiteMap);
  $('#siteMapTable').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const id = Number(button.dataset.history || button.dataset.replay);
    const entry = state.history.find((request) => request.id === id);
    if (!entry) return toast('This history entry was removed. Refresh the Site Map.', 'error');
    if (button.dataset.replay) sendToRepeater(historyRequestRaw(entry, false), entry.url);
    else { state.selectedHistoryId = id; switchView('history'); renderHistoryDetail(); }
  });
  $('#siteMapExport').addEventListener('click', () => {
    renderSiteMap();
    const filter = $('#siteMapFilter').value.toLowerCase();
    const endpoints = workflowState.endpoints.filter((endpoint) => `${endpoint.method} ${endpoint.origin}${endpoint.path} ${endpoint.params.join(' ')}`.toLowerCase().includes(filter));
    downloadLocal(JSON.stringify({ generatedAt: new Date().toISOString(), endpoints }, null, 2), 'interceptor-endpoints.json');
  });
  const updateMap = () => { if ($('#view-sitemap').classList.contains('active')) renderSiteMap(); };
  new MutationObserver(updateMap).observe($('#historyCount'), { childList: true });

  $('#inspectRun').addEventListener('click', runInspector);
  $('#inspectFilter').addEventListener('input', renderInspector);
  $('#inspectToRepeater').addEventListener('click', () => {
    try { const request = Workflow.prepareRequest($('#inspectRequest').value, $('#inspectTarget').value, workspaceVariableText()); sendToRepeater(request.raw, request.target); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#inspectCopy').addEventListener('click', () => copyText(JSON.stringify(workflowState.inspector?.fields || [], null, 2), 'Fields copied'));
  $('#inspectTable').addEventListener('click', (event) => {
    const button = event.target.closest('[data-decode]');
    const field = button && workflowState.inspector?.fields[Number(button.dataset.decode)];
    if (!field) return;
    $('#decoderInput').value = field.value;
    $('#decoderOutput').value = '';
    $('#decoderMeta').textContent = `${field.location} · ${field.name}`;
    switchView('decoder');
  });

  $('#runnerStart').addEventListener('click', startRunner);
  $('#runnerStop').addEventListener('click', () => workflowState.runner.controller?.abort());
  $('#runnerClear').addEventListener('click', () => {
    if (workflowState.runner.running) return;
    workflowState.runner.results = []; workflowState.runner.selectedId = null; workflowState.runner.planned = 0; renderRunner();
  });
  $('#runnerTable').addEventListener('click', (event) => { const row = event.target.closest('tr[data-id]'); if (row) { workflowState.runner.selectedId = Number(row.dataset.id); renderRunner(); } });
  $('#runnerCompare').addEventListener('click', () => {
    const first = workflowState.runner.results[0];
    const selected = workflowState.runner.results.find((row) => row.id === workflowState.runner.selectedId);
    if (!first || !selected) return;
    state.compare = { left: first.response, right: selected.response, leftLabel: `Payload ${first.payload}`, rightLabel: `Payload ${selected.payload}`, unified: '' };
    switchView('comparer');
  });
  $('#runnerToRepeater').addEventListener('click', () => { const row = workflowState.runner.results.find((result) => result.id === workflowState.runner.selectedId); if (row) sendToRepeater(row.raw, row.target); });
  $('#runnerExport').addEventListener('click', () => {
    const header = ['#', 'payload', 'status', 'duration_ms', 'bytes', 'check', 'error'];
    const lines = workflowState.runner.results.map((row) => [row.id, row.payload, row.status, Math.round(row.duration || 0), row.bytes, row.check == null ? '' : row.check ? 'match' : 'no match', row.error]);
    downloadLocal(Workflow.csvRows([header, ...lines]), 'interceptor-run.csv', 'text/csv');
  });

  $('#collectionNew').addEventListener('click', () => addCollection({ raw: DEFAULT_RAW, target: 'http://localhost:3000', name: 'New request' }));
  $('#collectionFilter').addEventListener('input', renderCollections);
  $('#collectionList').addEventListener('click', (event) => { const item = event.target.closest('[data-id]'); if (item) { workflowState.selectedCollectionId = Number(item.dataset.id); renderCollections(); } });
  const fields = { collectionName: 'name', collectionFolder: 'folder', collectionTarget: 'target', collectionRaw: 'raw', collectionNotes: 'notes' };
  for (const [id, key] of Object.entries(fields)) {
    $('#' + id).addEventListener('input', (event) => {
      const item = selectedCollection();
      if (!item) return;
      const max = key === 'raw' ? 500_000 : key === 'notes' ? 2000 : key === 'target' ? 10_000 : 100;
      if (key === 'raw' && workflowState.collections.reduce((n, request) => n + (request.id === item.id ? Math.min(event.target.value.length, max) : request.raw.length), 0) > 5_000_000) return toast('Collection request text limit reached.', 'error');
      item[key] = event.target.value.slice(0, max);
      saveWorkspace();
      if (key === 'name' || key === 'folder') renderCollections();
    });
  }
  $('#collectionFollow').addEventListener('change', (event) => { const item = selectedCollection(); if (item) { item.follow = event.target.checked; saveWorkspace(); } });
  $('#collectionOpen').addEventListener('click', () => { const item = selectedCollection(); if (item) { const request = newRepeater(item); request.follow = item.follow; switchView('repeater'); } });
  $('#collectionDelete').addEventListener('click', () => {
    workflowState.collections = workflowState.collections.filter((item) => item.id !== workflowState.selectedCollectionId);
    workflowState.selectedCollectionId = workflowState.collections[0]?.id || null; saveWorkspace(); renderCollections();
  });
  $('#workspaceVariables').addEventListener('input', (event) => { workflowState.variables = event.target.value.slice(0, 100_000); saveWorkspace(); });
  $('#workspaceRemember').addEventListener('change', (event) => {
    workflowState.remember = event.target.checked; saveWorkspace(); renderCollections();
    toast(workflowState.remember ? 'Requests and variables will be saved locally.' : 'Saved workspace removed; current requests remain in memory.');
  });
  $('#collectionExport').addEventListener('click', () => {
    const requests = workflowState.collections.map(({ name, folder, raw, target, follow, notes }) => ({ name, folder, raw, target, follow, notes }));
    // Environment tokens are deliberately omitted from portable collections.
    downloadLocal(JSON.stringify({ format: 'interceptor-collection', version: 1, requests }, null, 2), 'interceptor-collection.json');
    toast('Collection exported. Variables stay in this workspace.');
  });
  $('#collectionImport').addEventListener('click', () => $('#collectionImportFile').click());
  $('#collectionImportFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error('Collection files must be smaller than 5 MB.');
      const requests = Workflow.importCollection(JSON.parse(await file.text()));
      if (requests.length + workflowState.collections.length > 100) throw new Error('Import would exceed 100 saved requests.');
      if ([...requests, ...workflowState.collections].reduce((n, request) => n + request.raw.length, 0) > 5_000_000) throw new Error('Import would exceed the collection text limit.');
      for (const request of requests) workflowState.collections.push({ ...request, id: ++workflowState.collectionSeq });
      workflowState.selectedCollectionId = workflowState.collections.at(-1)?.id || null;
      saveWorkspace(); renderCollections(); toast(`Imported ${requests.length} requests.`);
    } catch (error) { toast(`Collection import failed: ${error.message}`, 'error'); }
    finally { event.target.value = ''; }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if ($('#toolDialog').open) $('#toolDialog').close();
      else { $('#toolSearch').value = ''; renderToolList(); $('#toolDialog').showModal(); $('#toolSearch').focus(); }
    }
  });
  $('#toolSearch').addEventListener('input', renderToolList);
  $('#toolSearch').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#toolList button')?.click(); });
  $('#toolList').addEventListener('click', (event) => { const button = event.target.closest('[data-tool]'); if (button) { switchView(button.dataset.tool); $('#toolDialog').close(); } });
  $('#workspaceRemember').checked = workflowState.remember;
  renderCollections(); renderInspector(); renderRunner(); renderSiteMap();
}
