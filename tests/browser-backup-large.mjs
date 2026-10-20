import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Run separately after the ordinary suite, using an isolated profile only.
// Synthetic workspace responses stay in that browser; no captured credentials
// or 204 MB JSON values are transferred over the debugging connection.
const origin = process.argv[2] || 'http://127.0.0.1:9226';
const localDirectory = path.resolve('local');
await fs.mkdir(localDirectory, { recursive: true });
const targets = await (await fetch(`${origin}/json/list`)).json();
const worker = targets.find((target) => target.type === 'service_worker' && target.url.endsWith('/background.js'));
const existing = targets.find((target) => target.url.startsWith('chrome-extension://') && target.url.endsWith('/dashboard.html'));
const explicitIdAt = process.argv.indexOf('--extension-id');
const explicitId = explicitIdAt >= 0 ? process.argv[explicitIdAt + 1] : '';
if (!worker && !existing && !/^[a-p]{32}$/.test(explicitId)) throw new Error('Load Interceptor in an isolated browser first, or pass --extension-id ID for its idle worker.');
const extensionUrl = new URL(worker?.url || existing?.url || `chrome-extension://${explicitId}/background.js`);
const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.host}`;
const target = existing || await (await fetch(`${origin}/json/new?${extensionOrigin}/dashboard.html`, { method: 'PUT' })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let id = 0; const pending = new Map(), exceptions = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  const task = pending.get(message.id); if (!task) return;
  clearTimeout(task.timer); pending.delete(message.id);
  if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
});
function call(method, params = {}) {
  const sequence = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(sequence); reject(new Error(`Timed out: ${method}`)); }, 120_000);
    pending.set(sequence, { resolve, reject, timer }); socket.send(JSON.stringify({ id: sequence, method, params }));
  });
}
async function evaluate(expression) {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function until(expression) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const value = await evaluate(expression); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition not reached: ${expression}`);
}

let fileTab, originalCaptured = false, previousRecord;
const fixturePath = path.join(localDirectory, 'browser-file-history-fixture.html');
const report = { version: 1, browser: (await (await fetch(`${origin}/json/version`)).json()).Browser, startedAt: new Date().toISOString(), large: [] };
try {
  await call('Runtime.enable'); await call('Page.enable');
  await until('document.readyState === "complete" && typeof Disclosure !== "undefined"');
  if (!await evaluate('Disclosure.accepted()')) { await until('document.querySelector(".disclosure-dialog[open]")'); await evaluate('document.querySelector(".disclosure-actions .primary").click()'); }
  await until('typeof labState !== "undefined" && labState.ready');
  assert.equal(await evaluate('state.attached || repeaterBusy || workflowState.runner.running || labState.activeTest'), false, 'finish other tests before running the backup benchmark');
  await evaluate(`window.backupBenchmarkOriginal=captureWorkspace();window.backupBenchmarkReady=labState.ready;window.backupBenchmarkBlocked=labState.storageBlocked;`);
  previousRecord = await evaluate('LocalStore.previous().then(value=>value||null)');
  originalCaptured = true;

  const fileAccess = await evaluate('new Promise(resolve=>chrome.extension.isAllowedFileSchemeAccess(resolve))');
  if (fileAccess) {
    console.log('Checking real local-file capture, reload, backup import and undo…');
    await fs.writeFile(fixturePath, '<!doctype html><title>Interceptor local-file fixture</title><h1>Passive file history fixture</h1>');
    const url = pathToFileURL(fixturePath).href;
    fileTab = await (await fetch(`${origin}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    const tabId = await until(`chrome.tabs.query({}).then(tabs=>tabs.find(tab=>(tab.url||tab.pendingUrl)===${JSON.stringify(url)})?.id)`);
    assert.ok(tabId, 'file fixture is a selectable browser tab');
    await evaluate(`(async()=>{await refreshTabs();$('#tabSelect').value=${JSON.stringify(String(tabId))};await attach();await cdp('Page.reload');})()`);
    await until(`state.history.some(entry=>entry.url===${JSON.stringify(url)} && entry.state==='done')`);
    await evaluate('(async()=>{await detach();await flushLocalSave();})()');
    await call('Page.reload');
    await until('typeof labState !== "undefined" && labState.ready');
    assert.equal(await evaluate(`state.history.some(entry=>entry.url===${JSON.stringify(url)})`), true, 'local file survives database reload');
    // Reload loses the in-memory original, so reconstruct it from the current
    // fixture workspace without the one newly captured file record.
    await evaluate(`window.backupBenchmarkOriginal=captureWorkspace();window.backupBenchmarkOriginal.workspace.history=window.backupBenchmarkOriginal.workspace.history.filter(entry=>entry.url!==${JSON.stringify(url)});window.backupBenchmarkReady=labState.ready;window.backupBenchmarkBlocked=labState.storageBlocked;`);
    for (const password of ['', 'browser-fixture-backup-password']) {
      assert.equal(await evaluate(`(async()=>{
        const fixture=captureWorkspace(),blob=await Backup.createBlob(fixture,${JSON.stringify(password)});
        const imported=await Backup.readFile(new File([blob],'file-history.jsonl'),${JSON.stringify(password)});
        await applyBackup(imported);
        const restored=state.history.some(entry=>entry.url===${JSON.stringify(url)});
        await applyBackup(Lab.validateBackup(await LocalStore.previous()));
        return restored;
      })()`), true);
      await until('!backupBusy && state.history.length>0');
    }
    const noReplay = await evaluate(`(async()=>{const request={id:-5,raw:'GET ${url} HTTP/1.1\\n\\n',target:${JSON.stringify(url)}};const result=await sendRepeater(request);return result?.error||request.error||request.meta||''})()`);
    assert.match(noReplay, /http|URL|target|invalid|request/i, 'active Repeater rejects file requests');
    report.file = { status: 'passed', captureReload: true, plaintextEncryptedRestore: true, activeFileReplayRejected: true };
  } else {
    report.file = { status: 'not run', reason: 'Chrome file-access setting is disabled in this isolated profile.' };
    if (process.argv.includes('--require-file-access')) throw new Error(report.file.reason);
    console.log('File fixture skipped: enable Allow access to file URLs for a complete run.');
  }

  await evaluate(`(async()=>{window.backupBenchmarkDownloadLocal=downloadLocal;downloadLocal=function(blob,name,type){window.backupBenchmarkBlob=blob instanceof Blob?blob:new Blob([blob],{type});};window.backupBenchmarkCreateURL=URL.createObjectURL;window.backupBenchmarkClick=HTMLAnchorElement.prototype.click;
    URL.createObjectURL=function(blob){window.backupBenchmarkBlob=blob;return window.backupBenchmarkCreateURL.call(URL,blob)};
    HTMLAnchorElement.prototype.click=function(){if(!this.download)return window.backupBenchmarkClick.call(this)};
    clearTimeout(localSaveTimer);await localSavePromise;labState.storageBlocked=true;
    state.repeaters=Array.from({length:51},(_,i)=>({id:i+1,raw:'GET /large HTTP/1.1\\nHost: localhost:3000\\n\\n',target:'http://localhost:3000',response:'HTTP/1.1 200 OK\\n\\n'+'x'.repeat(3_999_992)+String(i+1).padStart(8,'0'),sent:'',assertions:'[]',snapshots:[],view:'res'}));
    state.activeRepeaterId=1;state.repSeq=51;renderRepeater();switchView('workspace');
    window.backupBenchmarkStats={ticks:0,maxTimerGapMs:0,last:performance.now(),heapStart:performance.memory?.usedJSHeapSize||null,heapPeak:performance.memory?.usedJSHeapSize||null};
    window.backupBenchmarkTimer=setInterval(()=>{const stats=window.backupBenchmarkStats,now=performance.now();stats.ticks++;stats.maxTimerGapMs=Math.max(stats.maxTimerGapMs,now-stats.last);stats.last=now;if(performance.memory)stats.heapPeak=Math.max(stats.heapPeak||0,performance.memory.usedJSHeapSize)},50);
    window.backupBenchmarkCloneStart=performance.now();window.backupBenchmarkSnapshot=captureWorkspace();window.backupBenchmarkCloneMs=performance.now()-window.backupBenchmarkCloneStart;})()`);
  for (const encrypted of [false, true]) {
    console.log(`Benchmarking 51 × 4 MB responses through actual ${encrypted ? 'encrypted' : 'plaintext'} download/import UI…`);
    await evaluate(`window.backupBenchmarkBlob=null;window.backupBenchmarkExportStart=performance.now();$('#backupPassword').value=${JSON.stringify(encrypted ? 'browser-fixture-backup-password' : '')};$('#backupDownload').click();`);
    await until('window.backupBenchmarkBlob && !backupBusy || (!backupBusy && !$("#backupStatus").textContent.includes("Preparing backup") && $("#backupStatus").textContent && $("#backupStatus").textContent!=="Backup downloaded.")');
    const exportInfo = await evaluate('({exportMs:performance.now()-window.backupBenchmarkExportStart,fileBytes:window.backupBenchmarkBlob.size,cloneMs:window.backupBenchmarkCloneMs,...window.backupBenchmarkStats})');
    assert.ok(exportInfo.fileBytes > 200_000_000);
    await evaluate(`(()=>{window.backupBenchmarkImportStart=performance.now();$('#backupPassword').value=${JSON.stringify(encrypted ? 'browser-fixture-backup-password' : '')};const input=$('#backupFile');Object.defineProperty(input,'files',{configurable:true,value:[new File([window.backupBenchmarkBlob],'large-workspace.jsonl')]});input.dispatchEvent(new Event('change'));})()`);
    await until('labState.pendingBackup && !backupBusy');
    const importInfo = await evaluate('({importMs:performance.now()-window.backupBenchmarkImportStart,first:labState.pendingBackup.repeaters[0].response.slice(-8),lastResponse:labState.pendingBackup.repeaters[50].response.slice(-8),count:labState.pendingBackup.repeaters.length,passwordCleared:!$("#backupPassword").value,...window.backupBenchmarkStats})');
    assert.equal(importInfo.count, 51); assert.equal(importInfo.first, '00000001'); assert.equal(importInfo.lastResponse, '00000051'); assert.equal(importInfo.passwordCleared, true);
    assert.ok(importInfo.ticks > 0, 'UI timers continue while exporting and importing');
    report.large.push({ encrypted, ...exportInfo, ...importInfo });
    await evaluate(`$('#backupDismiss').click();window.backupBenchmarkBlob=null;`);
  }
  console.log('Checking existing plaintext JSON above the former 200 MB ceiling…');
  report.legacy = await evaluate(`(async()=>{
    const snapshot=window.backupBenchmarkSnapshot,baseline=JSON.stringify({...snapshot,workspace:{...snapshot.workspace,repeaters:[]}}),marker='"repeaters":[]',at=baseline.indexOf(marker);
    const parts=[baseline.slice(0,at)+'"repeaters":[' ];snapshot.workspace.repeaters.forEach((entry,index)=>{if(index)parts.push(',');parts.push(JSON.stringify(entry))});parts.push(']'+baseline.slice(at+marker.length));
    const file=new File(parts,'legacy-large.json'),start=performance.now(),workspace=await Backup.readFile(file);
    return {fileBytes:file.size,importMs:performance.now()-start,count:workspace.repeaters.length,last:workspace.repeaters[50].response.slice(-8)};
  })()`);
  assert.ok(report.legacy.fileBytes > 200_000_000); assert.equal(report.legacy.count, 51); assert.equal(report.legacy.last, '00000051');
  assert.deepEqual(exceptions, []);
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(localDirectory, 'browser-backup-large-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS: large download/import, encryption and legacy recovery; original workspace restored.');
} finally {
  if (originalCaptured) {
    await evaluate(`(async()=>{clearInterval(window.backupBenchmarkTimer);if(state.attached)await detach();clearTimeout(localSaveTimer);await localSavePromise.catch(()=>{});labState.ready=false;restoreWorkspace(Lab.validateBackup(window.backupBenchmarkOriginal),true);labState.storageBlocked=window.backupBenchmarkBlocked;labState.ready=window.backupBenchmarkReady;if(!labState.storageBlocked)await flushLocalSave();if(window.backupBenchmarkDownloadLocal)downloadLocal=window.backupBenchmarkDownloadLocal;if(window.backupBenchmarkCreateURL)URL.createObjectURL=window.backupBenchmarkCreateURL;if(window.backupBenchmarkClick)HTMLAnchorElement.prototype.click=window.backupBenchmarkClick;labState.pendingBackup=null;$('#backupPreview').classList.add('hidden');const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('interceptor-workspace',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});await new Promise((resolve,reject)=>{const tx=db.transaction('workspaces','readwrite'),store=tx.objectStore('workspaces');const previous=${JSON.stringify(previousRecord)};if(previous)store.put(previous,'before-restore');else store.delete('before-restore');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();})()`).catch((error) => { console.error('Cleanup failed:', error.message); });
  }
  if (fileTab) await fetch(`${origin}/json/close/${fileTab.id}`).catch(() => {});
  await fs.rm(fixturePath, { force: true });
  socket.close();
}
