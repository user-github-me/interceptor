import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';

// Use an isolated Chromium profile with Interceptor loaded. The action popup is
// opened as an extension page for CDP access; its activeTab is explicitly set to
// our HTTP fixture, matching the context provided by clicking the toolbar action.
const debuggingOrigin = process.argv[2] || 'http://127.0.0.1:9226';
const targets = await (await fetch(`${debuggingOrigin}/json/list`)).json();
const extensionTarget = targets.find((target) => target.url.startsWith('chrome-extension://') && /\/(background\.js|dashboard\.html|popup\.html)$/.test(target.url));
if (!extensionTarget) throw new Error('Load Interceptor in the isolated test browser first.');
const extensionOrigin = extensionTarget.url.slice(0, extensionTarget.url.lastIndexOf('/'));
const popup = await (await fetch(`${debuggingOrigin}/json/new?${extensionOrigin}/popup.html`, { method: 'PUT' })).json();

function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  const exceptions = [];
  let sequence = 0;
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  async function call(method, params = {}) {
    await ready;
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
  return { call, evaluate, exceptions, close: () => socket.close() };
}
const client = connect(popup.webSocketDebuggerUrl);
const { call, evaluate } = client;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(expression) {
  for (let i = 0; i < 120; i++) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Condition not reached: ${expression}`);
}

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url.startsWith('/echo') ? 'application/json' : 'text/html');
  res.end(req.url.startsWith('/echo') ? JSON.stringify({ url: req.url }) : '<!doctype html><title>Popup scope fixture</title><h1>Local fixture</h1>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixture = `http://127.0.0.1:${server.address().port}`;
let fixtureTabs = [];
let dashboardCreated = false;
let dashboardId;
let originalStorage;
const fixtureClients = [];
try {
  await call('Runtime.enable'); await call('Page.enable');
  await until('document.readyState === "complete" && typeof settings !== "undefined" && document.querySelectorAll("#rules .rule").length');
  originalStorage = await evaluate('(async()=>({local:await chrome.storage.local.get("settings"),session:await chrome.storage.session.get("autoTabId")}))()');
  fixtureTabs = await evaluate(`(async()=>{
    const a=await chrome.tabs.create({url:${JSON.stringify(fixture + '/?fixture=one')},active:false});
    const b=await chrome.tabs.create({url:${JSON.stringify(fixture + '/?fixture=two')},active:false});
    activeTab={id:a.id,host:${JSON.stringify(new URL(fixture).host)},ok:true};
    settings={...normalize({autoMode:false,autoScope:'all',autoRules:[{param:'amount',value:'1'}]}),autoInclude:'127.0.0.1:*/*'};
    await save();renderRules();renderScopeFields();window.close=()=>{window.popupCloseRequested=true};
    return [a.id,b.id];
  })()`);
  await delay(300);
  const fixtureTargets = await (await fetch(`${debuggingOrigin}/json/list`)).json();
  for (const name of ['one', 'two']) {
    const target = fixtureTargets.find((entry) => entry.type === 'page' && entry.url === fixture + '/?fixture=' + name);
    assert.ok(target, `fixture ${name} opened`);
    const connected = connect(target.webSocketDebuggerUrl);
    await connected.call('Runtime.enable'); fixtureClients.push(connected);
  }
  async function expectScope(scope) {
    const rendered = await evaluate(`(()=>{renderScope();return [...document.querySelectorAll('#scopeSeg button')].map(button=>({scope:button.dataset.scope,pressed:button.getAttribute('aria-pressed'),active:button.classList.contains('active')}))})()`);
    assert.ok(rendered.every((button) => button.pressed === String(button.scope === scope) && button.active === (button.scope === scope)), `scope ${scope} has consistent visual and ARIA state`);
  }
  async function setInput(selector, value) {
    await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  }
  async function fixtureFetch(index, path) {
    return fixtureClients[index].evaluate(`fetch(${JSON.stringify(fixture + path)}).then(response=>response.json())`);
  }
  await expectScope('off');
  assert.equal(await evaluate('document.querySelector("#scopeSeg [data-scope=tab]").disabled'), false);

  await evaluate('document.querySelector("#scopeSeg [data-scope=tab]").click()');
  await until(`chrome.runtime.sendMessage({type:'getAutoStatus'}).then(status=>status.on && status.scope==='tab' && status.tabId===${fixtureTabs[0]} && status.attached.includes(${fixtureTabs[0]}))`);
  await expectScope('tab');
  assert.match(await evaluate('document.querySelector("#scopeInfo").textContent'), /127\.0\.0\.1/);
  assert.equal((await fixtureFetch(0, '/echo?amount=9')).url, '/echo?amount=1');
  assert.equal((await fixtureFetch(1, '/echo?amount=9')).url, '/echo?amount=9', 'This tab leaves the other fixture unchanged');
  assert.equal(await evaluate(`chrome.runtime.sendMessage({type:'getAutoStatus'}).then(status=>status.attached.includes(${fixtureTabs[1]}))`), false);

  await evaluate('document.querySelector("#scopeSeg [data-scope=all]").click()');
  await until(`chrome.runtime.sendMessage({type:'getAutoStatus'}).then(status=>status.on && status.scope==='all' && ${JSON.stringify(fixtureTabs)}.every(id=>status.attached.includes(id)))`);
  await expectScope('all');
  assert.equal((await fixtureFetch(1, '/echo?amount=9')).url, '/echo?amount=1');
  await evaluate('document.querySelector("#scopeSeg [data-scope=off]").click()');
  await until('chrome.runtime.sendMessage({type:"getAutoStatus"}).then(status=>!status.on && status.attached.length===0)');
  await expectScope('off');
  assert.equal((await fixtureFetch(0, '/echo?amount=9')).url, '/echo?amount=9');
  assert.equal(await evaluate('chrome.storage.session.get("autoTabId").then(data=>data.autoTabId)'), null);
  assert.equal(await evaluate('chrome.storage.local.get("settings").then(data=>Object.hasOwn(data.settings,"autoTabId"))'), false, 'tab IDs stay in session storage');

  await evaluate('document.querySelector("#addRule").click()');
  assert.equal(await evaluate('document.querySelectorAll("#rules .rule").length'), 2);
  await setInput('#rules .rule:last-child .rp', 'discount, tax');
  await setInput('#rules .rule:last-child .rv', '0');
  await until('chrome.storage.local.get("settings").then(data=>data.settings.autoRules.length===2 && data.settings.autoRules[1].param==="discount, tax" && data.settings.autoRules[1].value==="0")');
  assert.match(await evaluate('document.querySelector("#ruleNote").textContent'), /3 field names/);
  await evaluate('document.querySelector("#rules .rule:first-child .rx").click()');
  await until('chrome.storage.local.get("settings").then(data=>data.settings.autoRules.length===1 && data.settings.autoRules[0].param==="discount, tax")');
  await evaluate('document.querySelector("#rules .rule .rx").click()');
  await until('chrome.storage.local.get("settings").then(data=>data.settings.autoRules.length===1 && data.settings.autoRules[0].param==="")');
  assert.equal(await evaluate('document.querySelectorAll("#rules .rule").length'), 1, 'removing the last rule leaves an editable empty rule');
  assert.match(await evaluate('document.querySelector("#ruleNote").textContent'), /No field names/);
  await evaluate('document.querySelector("#resetRules").click()');
  await until('chrome.storage.local.get("settings").then(data=>data.settings.autoRules[0].param===HTTP.DEFAULT_PARAMS && data.settings.autoRules[0].value==="1")');

  await setInput('#autoInclude', '/[broken/');
  await until('document.querySelector("#scopeError").textContent.includes("Include")');
  assert.equal(await evaluate('document.querySelector("#autoInclude").classList.contains("invalid")'), true);
  await evaluate('document.querySelector("#scopeSeg [data-scope=all]").click()');
  await expectScope('off');
  assert.equal(await evaluate('settings.autoMode'), false, 'invalid scope blocks enabling Auto');
  await setInput('#autoInclude', '127.0.0.1:*/*');
  await setInput('#autoExclude', '/echo/g');
  await until('document.querySelector("#scopeError").textContent.includes("Exclude")');
  await setInput('#autoExclude', 'never-rewrite');
  await until('chrome.storage.local.get("settings").then(data=>data.settings.autoInclude==="127.0.0.1:*/*" && data.settings.autoExclude==="never-rewrite")');
  assert.equal(await evaluate('document.querySelector("#scopeError").textContent'), '');
  await call('Page.reload');
  await until('document.readyState === "complete" && typeof settings !== "undefined" && document.querySelectorAll("#rules .rule").length');
  assert.equal(await evaluate('settings.autoRules[0].param'), await evaluate('HTTP.DEFAULT_PARAMS'));
  assert.equal(await evaluate('document.querySelector("#autoInclude").value'), '127.0.0.1:*/*');
  assert.equal(await evaluate('document.querySelector("#autoExclude").value'), 'never-rewrite');
  await evaluate(`(()=>{activeTab={id:${fixtureTabs[0]},host:${JSON.stringify(new URL(fixture).host)},ok:true};renderScope();window.close=()=>{window.popupCloseRequested=true}})()`);
  await expectScope('off');

  const workbench = await evaluate('(async()=>{const url=chrome.runtime.getURL("dashboard.html");const existing=await chrome.tabs.query({url});if(existing.length)return {id:existing[0].id,created:false};const tab=await chrome.tabs.create({url,active:false});return {id:tab.id,created:true}})()');
  dashboardId = workbench.id; dashboardCreated = workbench.created;
  await until('chrome.tabs.query({url:chrome.runtime.getURL("dashboard.html")}).then(tabs=>tabs.length>0)');
  const workbenchCount = await evaluate('chrome.tabs.query({url:chrome.runtime.getURL("dashboard.html")}).then(tabs=>tabs.length)');
  await evaluate('openPanel()');
  assert.equal(await evaluate('chrome.tabs.query({url:chrome.runtime.getURL("dashboard.html")}).then(tabs=>tabs.length)'), workbenchCount, 'Open workbench reuses the existing dashboard');
  assert.equal(await evaluate(`chrome.tabs.get(${dashboardId}).then(tab=>tab.active)`), true);
  assert.equal(await evaluate('window.popupCloseRequested'), true);
  await evaluate('(()=>{activeTab={id:-1,host:"",ok:false};renderScope()})()');
  assert.equal(await evaluate('document.querySelector("#scopeSeg [data-scope=tab]").disabled'), true, 'This tab is disabled for nonweb pages');

  if (process.argv.includes('--screenshots') || process.argv.includes('--screenshot')) {
    await evaluate(`(()=>{activeTab={id:${fixtureTabs[0]},host:${JSON.stringify(new URL(fixture).host)},ok:true};renderScope()})()`);
    await call('Emulation.setDeviceMetricsOverride', { width: 380, height: 590, deviceScaleFactor: 1, mobile: false });
    await fs.mkdir('local/screenshots-1.1.0', { recursive: true });
    for (const theme of ['dark', 'light']) {
      await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      await evaluate('window.scrollTo(0,0)');
      await delay(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, 'popup has no horizontal overflow');
      assert.equal(await evaluate('(()=>{const box=document.querySelector("#openPanel").getBoundingClientRect();return box.top>=0 && box.bottom<=innerHeight})()'), true, 'Open workbench stays visible');
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(`local/screenshots-1.1.0/popup${theme === 'light' ? '-light' : ''}.png`, Buffer.from(shot.data, 'base64'));
    }
  }
  assert.deepEqual(client.exceptions, []);
  for (const fixtureClient of fixtureClients) assert.deepEqual(fixtureClient.exceptions, []);
  console.log('PASS: popup Off/This tab/All tabs, scoped rewrites, add/remove/reset rules, scope errors, local/session persistence and reload, existing workbench focus, ARIA states; no runtime exceptions.');
} finally {
  await evaluate('(async()=>{settings.autoMode=false;settings.autoTabId=null;await save()})()').catch(() => {});
  if (fixtureTabs.length) await evaluate(`chrome.tabs.remove(${JSON.stringify(fixtureTabs)})`).catch(() => {});
  if (dashboardCreated) await evaluate(`chrome.tabs.remove(${dashboardId})`).catch(() => {});
  if (originalStorage) {
    await evaluate(`(async()=>{
      const previous=${JSON.stringify(originalStorage)};
      if(Object.hasOwn(previous.local,'settings')) await chrome.storage.local.set(previous.local);else await chrome.storage.local.remove('settings');
      if(Object.hasOwn(previous.session,'autoTabId')) await chrome.storage.session.set(previous.session);else await chrome.storage.session.remove('autoTabId');
    })()`).catch(() => {});
  }
  for (const fixtureClient of fixtureClients) fixtureClient.close();
  await call('Page.close').catch(() => {}); client.close();
  await new Promise((resolve) => server.close(resolve));
}
