import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Additional release checks use the integration harness's isolated local server.
export async function runReleaseChecks({ evaluate, call, until, fixture, requestCount }) {
  const raw = (method, path, headers = '', body = '') => `${method} ${fixture}${path} HTTP/1.1${headers ? '\n' + headers : ''}\n\n${body}`;
  const set = (fields) => Object.entries(fields).map(([id, value]) => `$('#${id}').value=${JSON.stringify(value)};`).join('');
  const file = async (selector, value) => {
    const path = `${process.cwd()}/local/release-test-import.json`;
    await fs.writeFile(path, JSON.stringify(value));
    const root = await call('DOM.getDocument');
    const input = await call('DOM.querySelector', { nodeId: root.root.nodeId, selector });
    await call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path] });
    await fs.rm(path);
  };
  await evaluate(`window.releaseDownloads=[];window.releaseCreateURL=URL.createObjectURL;window.releaseAnchorClick=HTMLAnchorElement.prototype.click;
    URL.createObjectURL=function(blob){window.releaseDownloads.push(blob);return window.releaseCreateURL.call(URL,blob)};
    HTMLAnchorElement.prototype.click=function(){if(!this.download) return window.releaseAnchorClick.call(this)};`);
  const download = async (click) => {
    const before = await evaluate('window.releaseDownloads.length');
    await evaluate(click);
    await until(`window.releaseDownloads.length>${before}`);
    return evaluate('window.releaseDownloads.at(-1).text()');
  };
  try {
    // Every Decoder operation goes through the real UI handler, including errors.
    const codecs = [
      ['url-encode', 'a&中', 'a%26%E4%B8%AD'], ['url-decode', 'a+b%26c', 'a b&c'],
      ['base64-encode', 'é中', 'w6nkuK0='], ['base64-decode', 'w6nkuK0=', 'é中'],
      ['html-encode', '<&"', '&lt;&amp;&quot;'], ['html-decode', '&lt;&#x4e2d;', '<中'],
      ['hex-encode', 'é', 'c3a9'], ['hex-decode', 'c3a9', 'é'],
      ['json-minify', '{ "id": 9007199254740993 }', '{"id":9007199254740993}'],
      ['sha256', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ];
    for (const [action, input, expected] of codecs) assert.equal(await evaluate(`(async()=>{${set({ decoderAction: action, decoderInput: input })}await runDecoder();return $('#decoderOutput').value})()`), expected, action);
    assert.equal((await evaluate(`(async()=>{${set({ decoderAction: 'sha512', decoderInput: 'abc' })}await runDecoder();return $('#decoderOutput').value})()`)).length, 128);
    assert.match(await evaluate(`(async()=>{${set({ decoderAction: 'jwt-inspect', decoderInput: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.' })}await runDecoder();return $('#decoderOutput').value})()`), /test/);
    assert.equal(await evaluate(`(async()=>{${set({ decoderAction: 'hex-decode', decoderInput: 'z1' })}await runDecoder();return $('#decoderOutput').value})()`), '');
    await evaluate(`$('#decoderInput').value='&'.repeat(250000);$('#decoderAction').value='html-encode';runDecoder()`);
    await until(`$('#decoderOutput').value.length===1250000`);
    await evaluate(`$('#decoderSwap').click()`);
    assert.equal(await evaluate(`$('#decoderInput').value.length`), 1250000);
    await evaluate(`$('#decoderClear').click()`);
    assert.equal(await evaluate(`$('#decoderInput').value+$('#decoderOutput').value`), '');
    await evaluate(`state.compare={left:${JSON.stringify('a\nb')},right:${JSON.stringify('a\nc')},leftLabel:'A',rightLabel:'B',unified:''};switchView('comparer');$('#compareRun').click()`);
    assert.match(await evaluate('state.compare.unified'), /- b\n\+ c/);
    await evaluate(`$('#compareSwap').click()`);
    assert.equal(await evaluate('state.compare.left'), 'a\nc');
    await evaluate(`$('#compareClear').click()`);
    assert.equal(await evaluate('state.compare.left+state.compare.right'), '');

    // Auth, form encoding, raw data, and send-blocking validation.
    const builderBase = { builderMethod: 'POST', builderUrl: `${fixture}/release-builder`, builderHeaders: '', builderBodyMode: 'raw', builderBody: 'raw=é&42', builderAssertions: '[{"type":"status","equals":200}]' };
    for (const [auth, name, value, expected] of [['none', '', '', null], ['basic', 'tester', 'secret', 'Basic dGVzdGVyOnNlY3JldA=='], ['apikey', 'X-Api-Key', 'local-test', 'local-test']]) {
      const result = await evaluate(`(async()=>{${set({ ...builderBase, builderAuth: auth, builderAuthName: name, builderAuthValue: value })}await sendBuilder();return labState.builder})()`);
      const echo = JSON.parse(result.response.split('\n\n').slice(1).join('\n\n'));
      assert.equal(echo.body, 'raw=é&42');
      assert.equal(echo.headers[auth === 'apikey' ? 'x-api-key' : 'authorization'] || null, expected);
      assert.ok(result.tests.every((test) => test.pass));
    }
    await evaluate(`workflowState.variables+=${JSON.stringify('\nformToken=a&b')};${set({ ...builderBase, builderAuth: 'none', builderBodyMode: 'form', builderBody: 'token={{formToken}}\nname=é' })}`);
    const form = await evaluate(`(async()=>{const request=buildApiRequest();await sendBuilder();return {raw:request.raw,response:labState.builder.response}})()`);
    assert.match(form.raw, /\{\{url:formToken\}\}/);
    assert.match(form.response, /token=a%26b&name=%C3%A9/);
    const beforeInvalid = requestCount();
    for (const fields of [{ builderHeaders: 'Bad Header: nope' }, { builderAuth: 'apikey', builderAuthName: 'Bad Header', builderAuthValue: 'token' }, { builderAuth: 'bearer', builderAuthValue: '{{missingReleaseVariable}}' }, { builderBodyMode: 'json', builderBody: '{bad' }]) {
      await evaluate(`(async()=>{${set({ ...builderBase, builderAuth: 'none', ...fields })}await sendBuilder()})()`);
    }
    assert.equal(requestCount(), beforeInvalid, 'invalid Builder drafts send nothing');
    const redirect = await evaluate(`(async()=>{const r=newRepeater({raw:${JSON.stringify(raw('POST', '/redirect', 'Content-Type: text/plain', 'old-body'))},target:'${fixture}',follow:true});const result=await sendRepeater(r);return {result,sent:r.sent,history:state.history.at(-1)}})()`);
    assert.equal(redirect.result.url, `${fixture}/redirect-final`);
    assert.match(redirect.sent, /^GET /);
    assert.doesNotMatch(redirect.sent, /old-body/);
    assert.equal(redirect.history.method, 'GET');
    assert.equal(redirect.history.url, `${fixture}/redirect-final`);
    const assertionRaw = raw('GET', '/assertion');
    const tested = await evaluate(`(async()=>{const r=newRepeater({raw:${JSON.stringify(assertionRaw)},target:'${fixture}',assertions:'[{"type":"status","equals":200},{"type":"status","equals":404}]'});await sendRepeater(r);$('#repSave').click();return {tests:r.tests,snapshots:r.snapshots,saved:selectedCollection()}})()`);
    assert.deepEqual(tested.tests.map((t) => t.pass), [true, false]);
    assert.deepEqual(tested.snapshots[0].tests.map((t) => t.pass), [true, false]);
    assert.equal(tested.saved.assertions, '[{"type":"status","equals":200},{"type":"status","equals":404}]');
    await evaluate(`${set({ runnerRequest: raw('GET', '/checks?value={{payload}}'), runnerTarget: fixture, runnerPayloads: '1\n2', runnerAssertions: '[{"type":"status","equals":200},{"type":"status","equals":404}]', runnerMatch: '', runnerDelay: '100' })}`);
    assert.deepEqual(await evaluate('(async()=>{await startRunner();return workflowState.runner.results.map(r=>r.tests.map(t=>t.pass))})()'), [[true, false], [true, false]]);
    assert.match(await evaluate(`$('#runnerTable').textContent`), /1\/2 tests/);
    assert.match(await download(`$('#runnerExport').click()`), /payload/i);
    const beforeOversize = requestCount();
    await evaluate(`workflowState.variables+=${JSON.stringify('\nexpanded=')}+'x'.repeat(210000);${set({ runnerRequest: raw('POST', '/checks?value={{payload}}', '', '{{expanded}}'), runnerPayloads: '1' })}startRunner()`);
    assert.equal(requestCount(), beforeOversize, 'expanded Runner cap checked before sends');
    await evaluate(`workflowState.variables=workflowState.variables.split(${JSON.stringify('\nexpanded=')})[0]`);

    // History filters and actual export payloads; imports save without further clicks.
    for (const filter of ['release-builder', 'dGVzdGVyOnNlY3JldA==', 'raw=é&42']) {
      assert.ok(await evaluate(`(()=>{${set({ historyFilter: filter, historyMethod: 'POST', historyStatus: '2' })}return filteredHistory().length})()`), filter);
    }
    const har = JSON.parse(await download('exportHar()'));
    assert.equal(har.log.version, '1.2');
    assert.ok(har.log.entries.every((entry) => entry.request.method === 'POST' && entry.response.status === 200));
    await evaluate(set({ historyFilter: '', historyMethod: '', historyStatus: '' }));
    const siteMap = JSON.parse(await download(`$('#siteMapExport').click()`));
    assert.ok(JSON.stringify(siteMap).includes('/release-builder'));
    const postman = { info: { name: 'Release Postman' }, variable: [{ key: 'postmanToken', value: 'a&b' }], item: [{ name: 'Form', request: { method: 'POST', url: `${fixture}/postman`, body: { mode: 'urlencoded', urlencoded: [{ key: 'token', value: '{{postmanToken}}' }] } } }, { name: 'Unsupported', request: { method: 'GET', url: `${fixture}/postman-unsupported`, auth: { type: 'oauth2' } } }] };
    const count = await evaluate('workflowState.collections.length');
    await file('#collectionImportFile', postman);
    await until(`workflowState.collections.length===${count + 2}`);
    assert.match(await evaluate(`$('#toast').textContent`), /auth|OAuth|oauth/i);
    assert.match(await evaluate(`Workflow.prepareRequest(workflowState.collections.at(-2).raw,'${fixture}',workspaceVariableText()).raw`), /token=a%26b/);
    const collectionExport = JSON.parse(await download(`$('#collectionExport').click()`));
    assert.equal(collectionExport.variables, undefined);
    const envs = await evaluate('labState.environments');
    await evaluate(`while(labState.environments.length<50)addEnvironment('Capacity fixture','x=1')`);
    await file('#collectionImportFile', postman);
    await until(`$('#toast').textContent.includes('Import needs an environment')`);
    assert.equal(await evaluate('workflowState.collections.length'), count + 2, 'failed import is atomic');
    await evaluate(`labState.environments=${JSON.stringify(envs)};renderWorkspace()`);

    // Passive review, redacted reports, persisted review state; comparison stop/guards.
    await evaluate(`state.history.push({id:++state.seq,url:'https://release.example.test/profile?token=secret-value',method:'GET',status:200,type:'Document',state:'done',wallTime:Date.now(),httpVersion:'HTTP/1.1',reqHeaders:[{name:'Authorization',value:'Bearer local'}],reqBody:'',resHeaders:[{name:'Content-Type',value:'text/html'},{name:'Set-Cookie',value:'session=private-cookie; SameSite=None'},{name:'Cache-Control',value:'public'}],resBody:'SQLSTATE[fixture]',mime:'text/html',size:17});`);
    const beforeReview = requestCount();
    await evaluate(`$('#securityScan').click()`);
    assert.equal(requestCount(), beforeReview);
    assert.ok(await evaluate(`labState.findings.some(f=>f.code==='cookie-secure') && labState.findings.some(f=>f.code==='debug-error')`));
    await evaluate(`$('#securityFindings [data-status="ignored"]').click()`);
    assert.ok(await evaluate(`labState.findings.some(f=>f.status==='ignored')`));
    const report = await download(`$('#securityExport').click()`);
    assert.doesNotMatch(report, /secret-value|private-cookie/);
    await evaluate(`newRepeater({raw:${JSON.stringify(raw('POST', '/unsafe', 'Authorization: Bearer local'))},target:'${fixture}'});$('#securitySource').value='repeater'`);
    const beforeCompare = requestCount();
    await evaluate('compareCredentials()');
    assert.equal(requestCount(), beforeCompare, 'comparison refuses mutation methods');
    const stopped = await evaluate(`(async()=>{newRepeater({raw:${JSON.stringify(raw('GET', '/slow-compare', 'Authorization: Bearer local'))},target:'${fixture}'});const p=compareCredentials();setTimeout(()=>$('#securityStop').click(),100);await p;return labState.comparison.summary})()`);
    assert.equal(stopped, 'Cancelled');
    assert.deepEqual(await evaluate('chrome.declarativeNetRequest.getSessionRules()'), []);
    await evaluate(`captureWebSocket('Network.webSocketCreated',{requestId:'release-binary',url:'ws://fixture.test/binary'});captureWebSocket('Network.webSocketFrameReceived',{requestId:'release-binary',response:{opcode:2,payloadData:'w6nkuK0='}});renderWebSockets();$('#wsFilter').value='w6nkuK0=';renderWebSockets();$('#wsTable tbody tr').click();$('#wsDecode').click()`);
    assert.equal(await evaluate(`$('#decoderAction').value`), 'base64-decode');
    await evaluate('runDecoder()');
    assert.equal(await evaluate(`$('#decoderOutput').value`), 'é中');
    assert.ok(JSON.parse(await download(`$('#wsExport').click()`)).frames.some((frame) => frame.opcode === 2));
    await evaluate(`captureWebSocket('Network.webSocketFrameReceived',{requestId:'release-binary',response:{opcode:1,payloadData:'x'.repeat(21000)}})`);
    assert.equal(await evaluate('labState.websocketFrames.at(-1).data.length'), 20000);
    assert.equal(await evaluate('labState.websocketFrames.at(-1).truncated'), true);
    await evaluate(set({ wsFilter: '' }));

    // Large tool output is a valid backup; quota failures still allow export.
    await evaluate(`state.compare.left=state.repeaters.find(r=>r.response.length>1000000).response;$('#inspectResponse').value=state.compare.left;$('#decoderInput').value='&'.repeat(250000);$('#decoderAction').value='html-encode';runDecoder()`);
    const backup = await evaluate('(async()=>{await flushLocalSave();const data=captureWorkspace();Lab.validateBackup(data);return data})()');
    assert.ok(backup.workspace.compare.left.length > 1000000);
    assert.ok(backup.workspace.fields.decoderOutput.length > 1000000);
    await evaluate(`window.releaseWrite=LocalStore.write;LocalStore.write=async()=>{throw new Error('Simulated quota exhausted')}`);
    const emergency = JSON.parse(await download(`$('#backupDownload').click()`));
    assert.equal(emergency.workspace.history.length, backup.workspace.history.length);
    await evaluate(`(async()=>{LocalStore.write=window.releaseWrite;await flushLocalSave()})()`);
    await evaluate(`$('#backupPassword').value='release-encrypted-password'`);
    const encrypted = JSON.parse(await download(`$('#backupDownload').click()`));
    assert.equal(encrypted.format, 'interceptor-encrypted-backup');
    await evaluate(`$('#backupPassword').value='wrong-password'`);
    await file('#backupFile', encrypted);
    await until(`$('#toast').textContent.includes('Backup import failed')`);
    assert.equal(await evaluate('labState.pendingBackup'), null);
    await evaluate(`$('#backupPassword').value='release-encrypted-password'`);
    await file('#backupFile', encrypted);
    await until('labState.pendingBackup');
    const beforeRestore = requestCount();
    await evaluate(`workflowState.variables+=${JSON.stringify('\nundoMarker=before-restore')};$('#backupRestore').click()`);
    await until('!labState.pendingBackup');
    assert.doesNotMatch(await evaluate('workflowState.variables'), /undoMarker/);
    await evaluate(`$('#workspaceUndoRestore').click()`);
    await until('workflowState.variables.includes("undoMarker")');
    assert.equal(requestCount(), beforeRestore, 'restore and undo send no traffic');
    // Corrupt saved records are preserved, and exporting current drafts remains possible.
    await evaluate(`LocalStore.write({format:'interceptor-backup',version:1,workspace:{history:'invalid'}})`);
    await call('Page.reload');
    await until('typeof labState!=="undefined" && labState.ready && labState.storageBlocked');
    assert.equal(await evaluate('LocalStore.read().then(data=>data.workspace.history)'), 'invalid');
    await evaluate(`window.releaseDownloads=[];window.releaseCreateURL=URL.createObjectURL;window.releaseAnchorClick=HTMLAnchorElement.prototype.click;URL.createObjectURL=function(blob){window.releaseDownloads.push(blob);return window.releaseCreateURL.call(URL,blob)};HTMLAnchorElement.prototype.click=function(){if(!this.download)return window.releaseAnchorClick.call(this)}`);
    const blockedBackup = JSON.parse(await download(`$('#backupDownload').click()`));
    assert.equal(blockedBackup.format, 'interceptor-backup');
    await evaluate(`applyBackup(Lab.validateBackup(${JSON.stringify(backup)}))`);
    await call('Page.reload');
    await until('typeof labState!=="undefined" && labState.ready && document.readyState==="complete"');
    assert.equal(await evaluate('labState.storageBlocked'), false);
    assert.ok(await evaluate(`labState.findings.some(f=>f.status==='ignored')`));
    assert.ok(await evaluate(`state.repeaters.some(r=>r.tests?.some(t=>!t.pass)&&r.snapshots[0]?.tests?.length===2)`));
    console.log('PASS: release edge cases for codecs, auth/forms, redirects, assertions, exports, Postman, passive review, binary frames, quota fallback, encrypted import, undo and corrupt-storage recovery.');
  } finally {
    await evaluate(`if(window.releaseCreateURL)URL.createObjectURL=window.releaseCreateURL;if(window.releaseAnchorClick)HTMLAnchorElement.prototype.click=window.releaseAnchorClick`).catch(() => {});
  }
}
