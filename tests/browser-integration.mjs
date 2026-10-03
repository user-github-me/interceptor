import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';

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

const server = http.createServer((req, res) => {
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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixture = `http://127.0.0.1:${server.address().port}`;
let fixtureTab;
try {
  await call('Runtime.enable');
  await call('Page.enable');
  await until('typeof state !== "undefined" && document.readyState === "complete" && state.repeaters.length');
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
    workflowState.remember=true;saveWorkspace();await new Promise(r=>setTimeout(r,400));
    return (await chrome.storage.local.get('workspace')).workspace.requests[0].name;
  })()`), 'Validation cases');
  await evaluate('(async()=>{workflowState.remember=false;saveWorkspace();await new Promise(r=>setTimeout(r,50))})()');
  assert.equal(await evaluate("chrome.storage.local.get('workspace').then(data=>data.workspace===undefined)"), true);
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
    for (const view of ['history', 'repeater', 'comparer', 'decoder', 'intercept', 'sitemap', 'inspector', 'runner', 'collections']) {
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
    for (const view of ['runner', 'collections', 'inspector', 'sitemap']) {
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
  await evaluate('(async()=>{workflowState.remember=false;saveWorkspace();await new Promise(r=>setTimeout(r,50))})()');
  assert.equal(await evaluate("chrome.storage.local.get('workspace').then(data=>data.workspace===undefined)"), true);
  assert.deepEqual(exceptions, []);
  console.log('PASS: live intercept/Auto/Repeater, HAR, Site Map, Inspector, variables, payload Runner and cancellation, snapshots, collection persistence; no runtime exceptions.');
} finally {
  if (fixtureTab) await evaluate(`chrome.tabs.remove(${fixtureTab})`).catch(() => {});
  await call('Page.close').catch(() => {});
  socket.close();
  await new Promise((resolve) => server.close(resolve));
}
