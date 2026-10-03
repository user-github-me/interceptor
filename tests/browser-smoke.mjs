import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const endpoint = process.argv[2];
const mode = process.argv[3] || 'dashboard';
if (!endpoint) throw new Error('Pass the dashboard webSocketDebuggerUrl as the first argument.');

const socket = new WebSocket(endpoint);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const exceptions = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.text || 'runtime exception');
  }
});

function call(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await call('Runtime.enable');
await call('Page.enable');
await call('Page.reload', { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, 700));

const dashboardExpression = `(() => {
  const required = ['tabSelect', 'attachBtn', 'historyTable', 'repEditor', 'compareA', 'compareB', 'compareTable', 'decoderInput', 'decoderOutput'];
  const missing = required.filter((id) => !document.getElementById(id));
  document.querySelector('[data-view="comparer"]').click();
  compareA.value = 'HTTP/1.1 200 OK\\nContent-Type: application/json\\n\\n{"amount":1,"ok":true}';
  compareA.dispatchEvent(new Event('input'));
  compareB.value = 'HTTP/1.1 200 OK\\nContent-Type: application/json\\n\\n{"amount":2,"ok":true}';
  compareB.dispatchEvent(new Event('input'));
  compareRun.click();
  document.querySelector('[data-view="decoder"]').click();
  decoderInput.value = '{"hello":"world"}';
  decoderAction.value = 'json-pretty';
  decoderRun.click();
  return {
    ready: document.readyState,
    title: document.title,
    missing,
    tabs: [...document.querySelectorAll('.tabs > button')].map((button) => button.textContent.trim()),
    diffRows: document.querySelectorAll('#compareTable tbody tr').length,
    decoderOutput: decoderOutput.value,
    activeView: document.querySelector('.view.active')?.id,
    workbench: typeof Workbench,
  };
})()`;
const popupExpression = `(() => {
  const required = ['scopeSeg', 'rules', 'autoInclude', 'autoExclude', 'scopeError', 'openPanel'];
  const missing = required.filter((id) => !document.getElementById(id));
  const include = document.getElementById('autoInclude');
  include.value = '/[broken/';
  include.dispatchEvent(new Event('input'));
  return {
    ready: document.readyState,
    title: document.title,
    missing,
    ruleRows: document.querySelectorAll('#rules .rule').length,
    scopeError: document.getElementById('scopeError').textContent,
    includeInvalid: include.classList.contains('invalid'),
  };
})()`;
const expression = mode === 'popup' ? popupExpression : dashboardExpression;
const evaluated = await call('Runtime.evaluate', { expression, returnByValue: true });
const result = evaluated.result.value;

assert.equal(result.ready, 'complete');
assert.deepEqual(result.missing, []);
if (mode === 'popup') {
  assert.ok(result.ruleRows > 0);
  assert.equal(result.includeInvalid, true);
  assert.match(result.scopeError, /Include/);
} else {
  assert.equal(result.workbench, 'object');
  assert.equal(result.activeView, 'view-decoder');
  assert.ok(result.tabs.some((name) => name.includes('Comparer')));
  assert.ok(result.tabs.some((name) => name.endsWith('Decoder')));
  assert.ok(result.diffRows > 0);
  assert.match(result.decoderOutput, /\n  "hello": "world"\n/);
}
assert.deepEqual(exceptions, []);

if (process.argv.includes('--screenshot')) {
  if (mode === 'popup') {
    await call('Runtime.evaluate', { expression: `(async()=>{settings.autoInclude='localhost:*/*';await save();renderScopeFields();await refreshStatus()})()`, awaitPromise: true });
  }
  await call('Emulation.setDeviceMetricsOverride', { width: mode === 'popup' ? 380 : 1440, height: mode === 'popup' ? 590 : 960, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir('local/screenshots-1.1.0', { recursive: true });
  await fs.writeFile(`local/screenshots-1.1.0/${mode}.png`, Buffer.from(shot.data, 'base64'));
}

console.log(JSON.stringify(result, null, 2));
socket.close();
