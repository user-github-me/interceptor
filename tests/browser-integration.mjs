import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Run against an isolated Chromium profile with this extension loaded.
const debuggingOrigin = process.argv[2] || 'http://127.0.0.1:9226';
const targets = await (await fetch(`${debuggingOrigin}/json/list`)).json();
const worker = targets.find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js'));
const openDashboard = targets.find((target) => target.url.startsWith('chrome-extension://') && target.url.endsWith('/dashboard.html'));
if (!worker && !openDashboard) throw new Error('Load Interceptor in the test browser first.');
const extensionUrl = worker?.url || openDashboard.url;
const extensionOrigin = extensionUrl.slice(0, extensionUrl.lastIndexOf('/'));
const dashboard = openDashboard || await (await fetch(`${debuggingOrigin}/json/new?${extensionOrigin}/dashboard.html`, { method: 'PUT' })).json();
const socket = new WebSocket(dashboard.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const exceptions = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  if (!pending.has(message.id)) return;
  const { resolve, reject, timer } = pending.get(message.id);
  clearTimeout(timer);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});
function call(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    const result = await evaluate(expression);
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Condition not reached: ${expression}`);
}

let fixtureRequestCount = 0;
const server = http.createServer((req, res) => {
  fixtureRequestCount++;
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Interceptor local fixture</title><h1>Local test app</h1>');
    } else if (req.url === '/large') {
      res.setHeader('Content-Type', 'text/plain');
      res.end('x'.repeat(4_100_000));
    } else if (req.url.startsWith('/slow')) {
      setTimeout(() => { if (!res.destroyed) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true })); } }, 1500);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ url: req.url, body, headers: req.headers }));
    }
  });
});
const socketConnections = new Set();
server.on('upgrade', (req, connection) => {
  socketConnections.add(connection);
  connection.on('close', () => socketConnections.delete(connection));
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  connection.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  setTimeout(() => { if (!connection.destroyed) { const payload = Buffer.from('{"event":"fixture-live-message"}'); connection.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload])); } }, 100);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixture = `http://127.0.0.1:${server.address().port}`;
let fixtureTab;
try {
  await call('Runtime.enable');
  await call('Page.enable');
  await until('typeof state !== "undefined" && document.readyState === "complete" && state.repeaters.length');
  const platform = await evaluate('chrome.runtime.getPlatformInfo().then(info=>info.os)');
  const initialShortcut = await evaluate('(async()=>{await shortcutHintsReady;return document.querySelector("[data-shortcut]").textContent})()');
  assert.equal(initialShortcut, platform === 'mac' ? '⌘ + Enter' : 'Ctrl + Enter');
  for (const [os, modifier, ariaModifier] of [['mac', '⌘', 'Meta'], ['win', 'Ctrl', 'Control'], ['linux', 'Ctrl', 'Control'], ['MacIntel', '⌘', 'Meta'], ['macOS', '⌘', 'Meta']]) {
    const rendered = await evaluate(`(()=>{applyShortcutHints(${JSON.stringify(os)});return {
      hints:[...document.querySelectorAll('[data-shortcut]')].map(e=>({key:e.dataset.shortcut,text:e.textContent})),
      buttons:[...document.querySelectorAll('[data-shortcut-title]')].map(e=>({key:e.dataset.shortcutTitle,title:e.title,aria:e.getAttribute('aria-keyshortcuts')})),
      decoderIcon:document.querySelector('[data-view="decoder"] .nav-icon').textContent
    }})()`);
    assert.ok(rendered.hints.every(hint=>hint.text === `${modifier} + ${hint.key}`));
    assert.ok(rendered.buttons.every(button=>button.title === `${modifier} + ${button.key}` && button.aria === `${ariaModifier}+${button.key}`));
    assert.notEqual(rendered.decoderIcon, '⌘');
  }
  await evaluate(`applyShortcutHints(${JSON.stringify(platform)})`);
  for (const key of ['ctrlKey', 'metaKey']) {
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',${key}:true,bubbles:true}))`);
    assert.equal(await evaluate('document.querySelector("#toolDialog").open'), true);
    await evaluate('document.querySelector("#toolDialog").close()');
  }
  await evaluate(`chrome.storage.local.set({settings:{...state.settings,autoMode:false,autoInclude:'',autoExclude:''}})`);
  fixtureTab = await evaluate(`(async()=>{
    const tab = await chrome.tabs.create({url:${JSON.stringify(fixture)}});
    return tab.id;
  })()`);
  await delay(400);
  const attached = await evaluate(`(async()=>{
    await refreshTabs();
    document.querySelector('#tabSelect').value = '${fixtureTab}';
    await attach();
    return state.attached;
  })()`);
  assert.equal(attached, true, 'dashboard attaches to the app');

  async function appFetch(path, options) {
    const expression = `fetch(${JSON.stringify(fixture + path)},${JSON.stringify(options || {})}).then(r=>r.json())`;
    return evaluate(`(async()=>{
      const result = await cdp('Runtime.evaluate',{expression:${JSON.stringify(expression)},awaitPromise:true,returnByValue:true});
      if(result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    })()`);
  }
  await evaluate(`(async()=>{
    state.settings.autoMode=true; state.settings.autoScope='all';
    state.settings.autoRules=[{param:'amount',value:'1'}];
    state.settings.autoInclude='127.0.0.1:*/*'; state.settings.autoExclude='skip';
    await applyFetch();
  })()`);
  const originalBody = '{"orderId":9007199254740993,"amount":99}';
  const rewritten = await appFetch('/pay?amount=9&note=hello%20world', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: originalBody });
  assert.equal(rewritten.url, '/pay?amount=1&note=hello%20world');
  assert.equal(rewritten.body, '{"orderId":9007199254740993,"amount":1}');
  const excluded = await appFetch('/skip?amount=9', { method: 'POST', body: 'amount=9' });
  assert.equal(excluded.url, '/skip?amount=9');
  assert.equal(excluded.body, 'amount=9');
  const oversizedBody = 'x'.repeat(750_001);
  const oversized = await appFetch('/oversized?amount=9', { method: 'POST', body: oversizedBody });
  assert.equal(oversized.url, '/oversized?amount=1');
  assert.equal(oversized.body, oversizedBody);

  await evaluate('(async()=>{state.settings.autoMode=false;state.interceptOn=true;await applyFetch()})()');
  const manualExpression = `window.manualResult=null;fetch('${fixture}/manual',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"amount":9}'}).then(r=>r.json()).then(v=>window.manualResult=v);'started'`;
  await evaluate(`cdp('Runtime.evaluate',{expression:${JSON.stringify(manualExpression)}})`);
  await until('state.queue.length > 0');
  assert.equal(await evaluate(`(async()=>{
    const item=currentItem(); item.raw=item.raw.replace('"amount":9','"amount":7');
    return forwardItem(item,true);
  })()`), true);
  await until('state.queue.some(item=>item.stage === "response")');
  assert.match(await evaluate('currentItem().requestRaw'), /"amount":7/);
  await evaluate('(async()=>{const item=currentItem();item.raw=item.raw.replace("HTTP/1.1 200", "HTTP/1.1 201");return forwardItem(item)})()');
  const manualResult = await evaluate(`(async()=>{const r=await cdp('Runtime.evaluate',{expression:'window.manualResult',returnByValue:true});return r.result.value})()`);
  assert.equal(manualResult.body, '{"amount":7}');
  await evaluate('(async()=>{state.interceptOn=false;await applyFetch();await detach()})()');

  // Exercise the worker-owned Auto session, including handoff back to dashboard.
  await evaluate(`(async()=>{
    await chrome.storage.session.set({autoTabId:${fixtureTab}});
    await chrome.storage.local.set({settings:{...state.settings,autoMode:true,autoScope:'tab',autoRules:[{param:'amount',value:'1'}],autoInclude:'127.0.0.1:*/*',autoExclude:''}});
  })()`);
  await until(`chrome.runtime.sendMessage({type:'getAutoStatus'}).then(s=>s.attached.includes(${fixtureTab}))`);
  const workerExpression = `fetch('${fixture}/worker?amount=9').then(r=>r.json())`;
  const workerResult = await evaluate(`(async()=>{
    const r=await chrome.debugger.sendCommand({tabId:${fixtureTab}},'Runtime.evaluate',{expression:${JSON.stringify(workerExpression)},awaitPromise:true,returnByValue:true});
    return r.result.value;
  })()`);
  assert.equal(workerResult.url, '/worker?amount=1');
  await evaluate(`(async()=>{document.querySelector('#tabSelect').value='${fixtureTab}';await attach();})()`);
  assert.equal(await evaluate('state.attached'), true);
  assert.equal(await evaluate(`chrome.runtime.sendMessage({type:'getAutoStatus'}).then(s=>s.attached.includes(${fixtureTab}))`), false);
  await evaluate('(async()=>{await chrome.storage.local.set({settings:{...state.settings,autoMode:false}});await detach()})()');

  const repeaterRaw = `POST /replay HTTP/1.1\nHost: 127.0.0.1:${server.address().port}\nContent-Type: application/json\nCookie: fixture=hello\nOrigin: https://app.example.test\n\n${originalBody}`;
  const replay = await evaluate(`(async()=>{
    const r=newRepeater({raw:${JSON.stringify(repeaterRaw)},target:${JSON.stringify(fixture)}});
    await sendRepeater(r);
    return {response:r.response,sent:r.sent,rules:await chrome.declarativeNetRequest.getSessionRules()};
  })()`);
  assert.match(replay.response, /HTTP\/1\.1 200/);
  const echoed = JSON.parse(replay.response.split('\n\n').slice(1).join('\n\n'));
  assert.equal(echoed.headers.cookie, 'fixture=hello');
  assert.equal(echoed.headers.origin, 'https://app.example.test');
  assert.equal(echoed.body, originalBody);
  assert.match(replay.sent, /Cookie: fixture=hello/i);
  assert.deepEqual(replay.rules, []);
  const largeRaw = `GET /large HTTP/1.1\nHost: 127.0.0.1:${server.address().port}\n\n`;
  const truncated = await evaluate(`(async()=>{const r=newRepeater({raw:${JSON.stringify(largeRaw)},target:'${fixture}'});await sendRepeater(r);return r.response.slice(-100)})()`);
  assert.match(truncated, /response truncated/);

  const har = { log: { entries: [{ request: { method: 'GET', url: `${fixture}/imported`, headers: [] }, response: { status: 200, headers: [], content: { text: '{"amount":2}', mimeType: 'application/json' } } }] } };
  const imported = await evaluate(`(async()=>{await importHarFile(new File([${JSON.stringify(JSON.stringify(har))}],'fixture.har'));return state.history.at(-1).source})()`);
  assert.equal(imported, 'har');

  const endpoints = await evaluate('(()=>{renderSiteMap();return workflowState.endpoints})()');
  assert.ok(endpoints.some((endpoint) => endpoint.path === '/pay' && endpoint.method === 'POST'));
  const inspection = await evaluate(`(()=>{openInspector(${JSON.stringify(repeaterRaw)},${JSON.stringify(fixture)},'HTTP/1.1 200 OK\\nSet-Cookie: session=hello; HttpOnly; Secure; SameSite=Lax\\n\\n','Fixture request');return workflowState.inspector})()`);
  assert.ok(inspection.fields.some((field) => field.location === 'JSON' && field.name === 'orderId' && field.value === '9007199254740993'));
  assert.equal(inspection.cookies[0].httpOnly, true);
  const template = `POST /run HTTP/1.1\nHost: {{host}}\nContent-Type: application/json\nCookie: fixture=runner\n\n{"amount":{{payload}}}`;
  const runResults = await evaluate(`(async()=>{
    workflowState.variables='host=127.0.0.1:${server.address().port}';
    document.querySelector('#workspaceVariables').value=workflowState.variables;
    sendToRunner(${JSON.stringify(template)},${JSON.stringify(fixture)});
    document.querySelector('#runnerPayloads').value='0\\n1\\n-1';
    document.querySelector('#runnerMatch').value='fixture=runner';
    document.querySelector('#runnerDelay').value='100';
    await startRunner();return workflowState.runner.results;
  })()`);
  assert.equal(runResults.length, 3);
  assert.ok(runResults.every((row) => row.status === 200 && row.check === true));
  for (let i = 0; i < runResults.length; i++) {
    const body = JSON.parse(runResults[i].response.split('\n\n').slice(1).join('\n\n'));
    assert.equal(body.body, `{"amount":${['0', '1', '-1'][i]}}`);
    assert.equal(body.headers.cookie, 'fixture=runner');
  }
  assert.deepEqual(await evaluate('chrome.declarativeNetRequest.getSessionRules()'), []);

  const cancelResult = await evaluate(`(async()=>{
    sendToRunner(${JSON.stringify('GET /slow?value={{payload}} HTTP/1.1\nHost: 127.0.0.1:' + server.address().port + '\n\n')},${JSON.stringify(fixture)});
    document.querySelector('#runnerPayloads').value='1\\n2\\n3';
    const promise=startRunner();setTimeout(()=>workflowState.runner.controller?.abort(),100);await promise;
    return {rows:workflowState.runner.results,running:workflowState.runner.running,rules:await chrome.declarativeNetRequest.getSessionRules()};
  })()`);
  assert.equal(cancelResult.running, false);
  assert.equal(cancelResult.rows.length, 1);
  assert.equal(cancelResult.rows[0].error, 'Cancelled');
  assert.deepEqual(cancelResult.rules, []);
  const timeoutResult = await evaluate(`(async()=>{
    const r={id:-2,raw:'GET /slow HTTP/1.1\\nHost: 127.0.0.1:${server.address().port}\\n\\n',target:${JSON.stringify(fixture)},abort:null};
    return sendRepeater(r,{quiet:true,timeoutMs:100});
  })()`);
  assert.equal(timeoutResult.error, 'Timed out');
  assert.deepEqual(await evaluate('chrome.declarativeNetRequest.getSessionRules()'), []);
  // Restore the successful run for the captured UI examples.
  await evaluate(`(()=>{
    workflowState.runner.results=${JSON.stringify(runResults)};workflowState.runner.selectedId=3;workflowState.runner.planned=3;
    document.querySelector('#runnerRequest').value=${JSON.stringify(template)};
    document.querySelector('#runnerPayloads').value='0\\n1\\n-1';
    document.querySelector('#runnerMeta').textContent='Finished · 3 requests · 0 errors';renderRunner();
  })()`);
  const snapshotCount = await evaluate(`(async()=>{
    const r=newRepeater({raw:${JSON.stringify(repeaterRaw)},target:${JSON.stringify(fixture)}});
    await sendRepeater(r);await sendRepeater(r);return r.snapshots.length;
  })()`);
  assert.equal(snapshotCount, 2);
  const collection = await evaluate(`(()=>{const item=addCollection({raw:${JSON.stringify(template)},target:${JSON.stringify(fixture)},name:'Validation cases',folder:'API tests'});return {item,count:document.querySelectorAll('#collectionList button').length}})()`);
  assert.equal(collection.item.name, 'Validation cases');
  assert.ok(collection.count > 0);
  assert.equal(await evaluate(`(async()=>{
    saveWorkspace();await flushLocalSave();
    return (await LocalStore.read()).workspace.collections[0].name;
  })()`), 'Validation cases');
  assert.equal(await evaluate("(async()=>{const s=await LocalStore.read();return s.workspace.history.length>0 && s.workspace.repeaters.some(r=>r.snapshots?.length===2)})()"), true);
  const curlUi = await evaluate(`(()=>{
    document.querySelector('#repImportCurl').click();
    document.querySelector('#curlInput').value=${JSON.stringify(`curl '${fixture}/curl' -H 'X-Test: imported'`)};
    document.querySelector('#curlImportRun').click();
    return {closed:!document.querySelector('#curlDialog').open,raw:activeRepeater().raw};
  })()`);
  assert.equal(curlUi.closed, true);
  assert.match(curlUi.raw, /X-Test: imported/);
  await evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));document.querySelector('#toolSearch').value='Site Map';document.querySelector('#toolSearch').dispatchEvent(new Event('input'));document.querySelector('#toolList button').click()})()`);
  assert.equal(await evaluate("document.querySelector('.view.active').id"), 'view-sitemap');
  assert.equal(await evaluate("Workbench.hash('SHA-256','abc')"), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const builder = await evaluate(`(async()=>{
    addEnvironment('Local test', 'baseUrl=${fixture}\\ntoken=builder-test-token');
    document.querySelector('#builderUrl').value='{{baseUrl}}/builder';
    document.querySelector('#builderMethod').value='POST';document.querySelector('#builderAuth').value='bearer';
    document.querySelector('#builderAuthValue').value='{{token}}';document.querySelector('#builderBodyMode').value='json';
    document.querySelector('#builderBody').value='{"amount":9007199254740993}';
    document.querySelector('#builderAssertions').value='[{"type":"status","equals":200},{"type":"json","path":"/headers/authorization","equals":"Bearer builder-test-token"}]';
    await sendBuilder();return {response:labState.builder.response,tests:labState.builder.tests};
  })()`);
  assert.match(builder.response, /9007199254740993/);
  assert.ok(builder.tests.every((test) => test.pass));
  assert.equal(await evaluate('state.history.at(-1).source'), 'API Builder', 'API tool sends are kept in local HTTP History');
  assert.match(await evaluate('buildApiRequest().raw'), /\{\{baseUrl\}\}/, 'saved Builder requests retain environment URL variables');
  assert.match(await evaluate('buildApiRequest().raw'), /Bearer \{\{token\}\}/, 'saved Builder requests retain bearer token variables');
  await evaluate(`(()=>{
    newRepeater({raw:'GET /auth-compare HTTP/1.1\\nHost: 127.0.0.1:${server.address().port}\\nAuthorization: Bearer auth-test\\nCookie: session=fixture\\n\\n',target:${JSON.stringify(fixture)}});
    document.querySelector('#securitySource').value='repeater';
  })()`);
  const comparison = await evaluate('(async()=>{await compareCredentials();return labState.comparison})()');
  assert.match(comparison.left, /Bearer auth-test/);
  assert.doesNotMatch(comparison.right, /Bearer auth-test|session=fixture/);
  assert.deepEqual(await evaluate('chrome.declarativeNetRequest.getSessionRules()'), []);
  await evaluate(`(async()=>{
    document.querySelector('#securityScan').click();document.querySelector('#tabSelect').value='${fixtureTab}';await attach();
    await cdp('Runtime.evaluate',{expression:'window.fixtureSocket=new WebSocket(${JSON.stringify(fixture.replace('http:', 'ws:') + '/live')});window.fixtureSocket.onopen=()=>window.fixtureSocket.send("fixture-outbound");'});
  })()`);
  await until('labState.websocketFrames.some(f=>f.direction==="Sent") && labState.websocketFrames.some(f=>f.direction==="Received")');
  assert.ok(await evaluate('labState.websocketFrames.some(f=>f.data.includes("fixture-live-message"))'));
  await evaluate('(async()=>{await cdp("Runtime.evaluate",{expression:"window.fixtureSocket.close()"});await detach()})()');
  const persisted = await evaluate(`(async()=>{
    await flushLocalSave();const backup=captureWorkspace();Lab.validateBackup(backup);
    const encrypted=await Lab.encryptBackup(backup,'fixture-backup-password');
    const decrypted=await Lab.decryptBackup(encrypted,'fixture-backup-password');
    window.fixtureBackup=decrypted;
    return {history:backup.workspace.history.length,repeaters:backup.workspace.repeaters.length,collections:backup.workspace.collections.length,frames:backup.workspace.websocketFrames.length,environments:backup.workspace.environments.length,results:backup.workspace.runnerResults.length};
  })()`);
  assert.ok(persisted.history > 0);
  assert.ok(persisted.environments > 0);
  const requestsBeforeRestore = fixtureRequestCount;
  await evaluate('(async()=>{workflowState.collections=[];labState.environments=[];state.history=[];await applyBackup(Lab.validateBackup(window.fixtureBackup))})()');
  assert.equal(fixtureRequestCount, requestsBeforeRestore, 'workspace restore sends no HTTP requests');
  assert.equal(await evaluate('workflowState.collections.length'), persisted.collections);
  assert.equal(await evaluate('state.history.length'), persisted.history);
  assert.equal(await evaluate('state.settings.autoMode'), false);
  assert.equal(await evaluate('state.attached'), false);
  await call('Page.reload');
  await until('typeof labState !== "undefined" && labState.ready && document.readyState === "complete"');
  assert.equal(await evaluate('state.history.length'), persisted.history);
  assert.equal(await evaluate('state.repeaters.length'), persisted.repeaters);
  assert.equal(await evaluate('workflowState.collections.length'), persisted.collections);
  assert.equal(await evaluate('labState.websocketFrames.length'), persisted.frames);
  assert.equal(await evaluate('labState.environments.length'), persisted.environments);
  assert.equal(await evaluate('workflowState.runner.results.length'), persisted.results);
  assert.match(await evaluate('labState.builder.response'), /9007199254740993/);
  // Exercise the file-import preview and explicit restore action.
  const currentBackup = await evaluate('captureWorkspace()');
  const backupPath = `${process.cwd()}/local/browser-fixture-backup.json`;
  await fs.writeFile(backupPath, JSON.stringify(currentBackup));
  await call('DOM.enable');
  let root = await call('DOM.getDocument');
  let fileInput = await call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#backupFile' });
  await call('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [backupPath] });
  await until('labState.pendingBackup && !document.querySelector("#backupPreview").classList.contains("hidden")');
  assert.match(await evaluate('document.querySelector("#backupSummary").textContent'), /No requests are sent/);
  const uiRequestsBeforeRestore = fixtureRequestCount;
  await evaluate('document.querySelector("#backupRestore").click()');
  await until('!labState.pendingBackup');
  assert.equal(fixtureRequestCount, uiRequestsBeforeRestore);
  await fs.writeFile(backupPath, '{"format":"interceptor-backup","version":1,"workspace":{"history":"bad"}}');
  root = await call('DOM.getDocument');
  fileInput = await call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#backupFile' });
  await call('DOM.setFileInputFiles', { nodeId: fileInput.nodeId, files: [backupPath] });
  await until('document.querySelector("#toast").textContent.includes("Backup import failed")');
  assert.equal(await evaluate('labState.pendingBackup'), null);
  assert.equal(await evaluate('state.history.length'), persisted.history);
  await fs.rm(backupPath);
  assert.deepEqual(exceptions, []);

  if (process.argv.includes('--screenshots')) {
    await fs.mkdir('local/screenshots-1.1.0', { recursive: true });
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await evaluate(`(()=>{
      state.compare.left=${JSON.stringify('HTTP/1.1 200 OK\nContent-Type: application/json\n\n{"amount":99,"validated":false}')};
      state.compare.right=${JSON.stringify('HTTP/1.1 200 OK\nContent-Type: application/json\n\n{"amount":1,"validated":true}')};
      document.querySelector('#decoderInput').value='{"orderId":9007199254740993,"amount":1,"validated":true}';runDecoder();
      document.querySelector('#toast').classList.remove('show');
    })()`);
    for (const view of ['history', 'repeater', 'comparer', 'decoder', 'intercept', 'sitemap', 'inspector', 'runner', 'collections', 'builder', 'security', 'websocket', 'workspace']) {
      if (view === 'intercept') {
        await evaluate(`(async()=>{
          document.querySelector('#tabSelect').value='${fixtureTab}';await attach();
          state.interceptOn=true;await applyFetch();
          await cdp('Runtime.evaluate',{expression:${JSON.stringify(`fetch('${fixture}/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"orderId":"demo-1042","amount":99,"currency":"USD"}'})`)}});
        })()`);
        await until('state.queue.length > 0');
      }
      await evaluate(`(()=>{
        if('${view}'==='repeater') state.activeRepeaterId=state.repeaters.find(r=>r.raw.includes('/replay'))?.id || state.activeRepeaterId;
        switchView('${view}');
        document.querySelector('#toast').classList.remove('show');
      })()`);
      await delay(150);
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(`local/screenshots-1.1.0/${view}.png`, Buffer.from(shot.data, 'base64'));
      if (view === 'intercept') await evaluate('(async()=>{await releaseAll(false);state.interceptOn=false;await detach()})()');
    }
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await evaluate("switchView('comparer')");
    await delay(150);
    let shot = await call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile('local/screenshots-1.1.0/comparer-light.png', Buffer.from(shot.data, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 760, height: 960, deviceScaleFactor: 1, mobile: false });
    await evaluate("switchView('decoder')");
    await delay(150);
    const overflow = await evaluate('document.documentElement.scrollWidth > innerWidth');
    assert.equal(overflow, false, 'narrow workbench fits the viewport');
    shot = await call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile('local/screenshots-1.1.0/decoder-narrow.png', Buffer.from(shot.data, 'base64'));
    for (const view of ['runner', 'collections', 'inspector', 'sitemap', 'builder', 'security', 'websocket', 'workspace']) {
      await evaluate(`switchView('${view}')`);await delay(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, `${view} fits narrow viewport`);
    }
  }
  await evaluate('(async()=>{workflowState.remember=true;saveWorkspace();await new Promise(r=>setTimeout(r,400))})()');
  await call('Page.reload', { ignoreCache: true });
  await until('typeof workflowState !== "undefined" && workflowState.collections.length && document.readyState === "complete"');
  assert.equal(await evaluate('workflowState.collections[0].name'), 'Validation cases');
  assert.match(await evaluate('workflowState.variables'), /host=127\.0\.0\.1/);
  await evaluate('(()=>{switchView("collections");document.querySelector("#collectionOpen").click()})()');
  assert.match(await evaluate('activeRepeater().raw'), /\{\{payload\}\}/);
  await evaluate('(async()=>{saveWorkspace();await flushLocalSave()})()');
  assert.equal(await evaluate('LocalStore.read().then(data=>data.workspace.collections.length>0)'), true);
  assert.deepEqual(exceptions, []);
  console.log('PASS: intercept/Auto/Repeater, Runner and cancellation, API Builder/auth/assertions, credential comparison, live WebSocket capture, full encrypted backup/restore/reload; no runtime exceptions.');
} finally {
  if (fixtureTab) await evaluate(`chrome.tabs.remove(${fixtureTab})`).catch(() => {});
  await call('Page.close').catch(() => {});
  socket.close();
  for (const connection of socketConnections) connection.destroy();
  await new Promise((resolve) => server.close(resolve));
}
