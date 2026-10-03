'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Lab = require('../lab.js');

test('declarative assertions check status, headers, JSON Pointer, text and budgets', () => {
  const items = Lab.parseAssertions(JSON.stringify([
    { type: 'status', equals: 201 }, { type: 'header', name: 'Content-Type', contains: 'json' },
    { type: 'header', name: 'X-Secret', absent: true }, { type: 'json', path: '/a~1b/~0key/0', equals: 42 },
    { type: 'json', path: '/missing', absent: true }, { type: 'bodyContains', value: '42' },
    { type: 'time', max: 500 }, { type: 'size', max: 1000 },
  ]));
  const response = 'HTTP/1.1 201 Created\nContent-Type: application/json\n\n{"a/b":{"~key":[42]}}';
  assert.ok(Lab.runAssertions(items, response, { duration: 25, bytes: 30 }).every((result) => result.pass));
  assert.ok(Lab.runAssertions(items, response, { error: 'Cancelled' }).every((result) => !result.pass));
  assert.equal(Lab.runAssertions([{ type: 'json', path: '/constructor' }], response)[0].pass, false);
  assert.equal(Lab.runAssertions([{ type: 'json', path: '', equals: { b: 2, a: 1 } }], 'HTTP/1.1 200 OK\n\n{"a":1,"b":2}')[0].pass, true);
  assert.equal(Lab.runAssertions([{ type: 'json', path: '/missing', absent: true }], 'HTTP/1.1 200 OK\n\nnot JSON')[0].pass, false);
  assert.throws(() => Lab.parseAssertions('[{"type":"script"}]'), /unknown/);
  assert.throws(() => Lab.parseAssertions('[{"type":"status","equals":0}]'), /HTTP status/);
});

test('assertions use repeated headers and valid JSON Pointer array indices', () => {
  const response = 'HTTP/1.1 200 OK\nSet-Cookie: first=1; Secure\nSet-Cookie: session=fixture; HttpOnly\n\n{"list":["value"]}';
  const tests = Lab.parseAssertions('[{"type":"header","name":"Set-Cookie","contains":"HttpOnly"},{"type":"json","path":"/list/0","equals":"value"},{"type":"json","path":"/list/length","absent":true},{"type":"json","path":"/list/01","absent":true}]');
  assert.ok(Lab.runAssertions(tests, response).every((result) => result.pass));
  assert.throws(() => Lab.parseAssertions('[{"type":"json","path":"/~2"}]'), /Pointer/);
  assert.throws(() => Lab.parseAssertions('[{"type":"header","name":"X-Test","absent":"false"}]'), /absent/);
  assert.throws(() => Lab.parseAssertions('[{"type":"header","name":"X-Test","equals":"a","contains":"b"}]'), /choose/);
});

test('capped response previews cannot falsely pass full-body size or JSON assertions', () => {
  const tests = Lab.parseAssertions('[{"type":"size","max":9000000},{"type":"json","path":"/id","equals":1},{"type":"bodyContains","value":"visible"},{"type":"status","equals":200}]');
  const results = Lab.runAssertions(tests, 'HTTP/1.1 200 OK\n\n{"id":1,"label":"visible"}', { truncated: true, bytes: 4001000 });
  assert.deepEqual(results.map((result) => result.pass), [false, false, true, true]);
  assert.match(results[0].detail, /Cannot verify/);
});

test('JSON assertions cannot silently round large numeric IDs', () => {
  assert.throws(() => Lab.parseAssertions('[{"type":"json","path":"/id","equals":9007199254740993}]'), /safe integer/);
  const tests = Lab.parseAssertions('[{"type":"json","path":"/id","equals":42},{"type":"json","path":"/id"},{"type":"bodyContains","value":"9007199254740993"}]');
  const results = Lab.runAssertions(tests, 'HTTP/1.1 200 OK\n\n{"id":9007199254740993}');
  assert.equal(results[0].pass, false);
  assert.equal(results[1].pass, true);
  assert.equal(results[1].actual, '9007199254740993');
  assert.equal(results[2].pass, true);
  const nested = Lab.runAssertions(Lab.parseAssertions('[{"type":"json","path":""}]'), 'HTTP/1.1 200 OK\n\n{"nested":{"id":9007199254740993},"label":"__interceptor_exact_number__"}');
  assert.match(nested[0].actual, /9007199254740993/);
  assert.match(nested[0].actual, /"label":"__interceptor_exact_number__"/);
  assert.throws(() => Lab.parseAssertions('[{"type":"json","path":"/value","equals":0.10000000000000001}]'), /precise/);
  const decimal = Lab.runAssertions(Lab.parseAssertions('[{"type":"json","path":"/value","equals":0.1}]'), 'HTTP/1.1 200 OK\n\n{"value":0.10000000000000001}');
  assert.equal(decimal[0].pass, false);
  assert.equal(decimal[0].actual, '0.10000000000000001');
  const literal = Lab.runAssertions(Lab.parseAssertions('[{"type":"json","path":"/label","equals":"__interceptor_exact_number__9007199254740993"}]'), 'HTTP/1.1 200 OK\n\n{"label":"__interceptor_exact_\\u006eumber__9007199254740993"}');
  assert.equal(literal[0].pass, true);
});

test('passive review deduplicates contextual findings and hides credential evidence', () => {
  const entry = { id: 1, url: 'https://example.test/private?token=very-secret', status: 200, reqHeaders: [{ name: 'Authorization', value: 'Bearer private' }], resHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'Set-Cookie', value: 'session=super-secret; SameSite=None' }, { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Credentials', value: 'true' }, { name: 'Cache-Control', value: 'public' }], resBody: 'SQLSTATE[123]' };
  const findings = Lab.passiveReview([entry, { ...entry, id: 2 }]);
  assert.ok(findings.some((item) => item.code === 'cors-wildcard'));
  assert.ok(findings.some((item) => item.code === 'cookie-none'));
  assert.ok(findings.some((item) => item.code === 'debug-error'));
  assert.ok(findings.some((item) => item.code === 'cache'));
  assert.equal(findings.length, Lab.passiveReview([entry]).length);
  assert.doesNotMatch(JSON.stringify(findings), /very-secret|super-secret|Bearer private/);
});

test('credential comparison removes credential headers while retaining query/body data', () => {
  const result = Lab.withoutCredentials('POST /?token=query-secret HTTP/1.1\nHost: example.test\nAuthorization: Bearer token\nCookie: session=test\nX-API-Key: key\nContent-Type: application/json\n\n{"token":"body-secret"}', 'https://example.test');
  assert.doesNotMatch(result.raw, /Authorization:|Cookie:|X-API-Key:/i);
  assert.match(result.raw, /token=query-secret/);
  assert.match(result.raw, /body-secret/);
});

test('Postman import preserves folder requests, variables, bearer auth and skips executable scripts', () => {
  const data = { info: { name: 'Local API' }, variable: [{ key: 'baseUrl', value: 'https://example.test' }], auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] }, event: [{ script: { exec: ['throw Error("never execute")'] } }], item: [{ name: 'API', item: [{ name: 'Create', request: { method: 'POST', url: '{{baseUrl}}/orders', header: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: '{"amount":1}' } } }, { name: 'File', request: { url: '{{baseUrl}}/upload', body: { mode: 'formdata' } } }] }] };
  const result = Lab.importPostman(data);
  assert.equal(result.requests.length, 1);
  assert.match(result.requests[0].raw, /Authorization: Bearer {{token}}/);
  assert.equal(result.requests[0].folder, 'API');
  assert.equal(result.variables, 'baseUrl=https://example.test');
  assert.ok(result.warnings.some((value) => value.includes('scripts')));
  assert.ok(result.warnings.some((value) => value.includes('formdata')));
});

test('Postman form variables expand with encoding and malformed imports fail before use', () => {
  const Workflow = require('../workflow.js');
  const data = { info: { name: 'Form' }, variable: [{ key: 'token', value: 'a&b=é' }, { key: 'unused', value: 'no', disabled: true }], item: [{ name: 'Submit', request: { method: 'POST', url: 'https://example.test/form', header: [{ key: 'X-Count', value: 0 }], body: { mode: 'urlencoded', urlencoded: [{ key: 'field', value: '{{token}}-literal &=' }] } } }] };
  const result = Lab.importPostman(data);
  assert.equal(Workflow.prepareRequest(result.requests[0].raw, result.requests[0].target, result.variables).parsed.body, 'field=a%26b%3D%C3%A9-literal%20%26%3D');
  assert.match(result.requests[0].raw, /X-Count: 0/);
  assert.doesNotMatch(result.variables, /unused/);
  const poisoned = structuredClone(data); poisoned.variable[0].value = 'first\ntoken=injected';
  assert.throws(() => Lab.importPostman(poisoned), /line breaks/);
  const headers = structuredClone(data); headers.item[0].request.header[0].value = 'value\nInjected: yes';
  assert.throws(() => Lab.importPostman(headers), /invalid request header/);
  const full = { info: { name: '100 requests' }, item: Array.from({ length: 100 }, (_, i) => ({ name: `Request ${i}`, request: { url: 'https://example.test/' } })) };
  full.item.push({ name: 'Empty folder', item: [] });
  assert.equal(Lab.importPostman(full).requests.length, 100);
  const rawWithoutHeaders = Lab.importPostman({ info: { name: 'Raw' }, item: [{ name: 'Raw body', request: { method: 'POST', url: 'https://example.test/raw', body: { mode: 'raw', raw: 'exact-body' } } }] });
  assert.equal(HTTP.parseRequest(rawWithoutHeaders.requests[0].raw, 'https://example.test').body, 'exact-body');
});

function backup() {
  return { format: 'interceptor-backup', version: 1, workspace: { history: [], repeaters: [], collections: [], autoLog: [], runnerResults: [], findings: [], environments: [], websocketFrames: [], fields: {}, settings: {} } };
}
test('backup validation rejects malformed restores and accepts unfinished assertion drafts', () => {
  const data = backup();
  data.workspace.repeaters.push({ id: 1, raw: 'GET / HTTP/1.1\n\n', target: 'https://example.test', assertions: '[unfinished', snapshots: [] });
  assert.equal(Lab.validateBackup(data).repeaters[0].assertions, '[unfinished');
  data.workspace.repeaters[0].snapshots.push({ id: '<script>', response: '', sent: '', label: 'bad' });
  assert.throws(() => Lab.validateBackup(data), /snapshot ID/);
  assert.throws(() => Lab.validateBackup({ ...backup(), version: 100 }), /backup/);
  const malformed = backup(); malformed.workspace.settings.autoRules = ['bad'];
  assert.throws(() => Lab.validateBackup(malformed), /rule/);
});

test('backups accept capped tool outputs and reject invalid render metadata before restore', () => {
  const data = backup();
  data.workspace.compare = { left: 'a'.repeat(4_000_100), right: 'b', leftLabel: 'large', rightLabel: 'small', unified: '' };
  data.workspace.fields = { inspectResponse: 'a'.repeat(4_000_100), decoderOutput: 'a'.repeat(9_000_000) };
  data.workspace.repeaters.push({ id: 1, raw: 'GET / HTTP/1.1\n\n', target: 'https://example.test', response: '', sent: 'a'.repeat(1_100_100), snapshots: [] });
  assert.equal(Lab.validateBackup(data).fields.decoderOutput.length, 9_000_000);
  const invalid = backup(); invalid.workspace.history.push({ id: 1, url: 'https://example.test/', method: 'GET', wallTime: Date.now(), reqHeaders: [], resHeaders: [], duration: 'x' });
  assert.throws(() => Lab.validateBackup(invalid), /duration/);
  invalid.workspace.history[0].duration = 20; invalid.workspace.history[0].id = 9007199254740992;
  assert.throws(() => Lab.validateBackup(invalid), /ID/);
  invalid.workspace.history[0].id = 1; invalid.workspace.history[0].note = { toString: 'invalid conversion' };
  assert.throws(() => Lab.validateBackup(invalid), /note/);
  const finding = backup(); finding.workspace.findings.push({ id: 1, entryId: 1, code: 'csp', severity: '<script>', title: 'test', url: 'https://example.test', evidence: '', advice: '', status: 'open' });
  assert.throws(() => Lab.validateBackup(finding), /metadata/);
  const layout = backup(); layout.workspace.layout = { version: 1, splits: { 'history-list': { y: 40 }, repeater: { x: 60, y: 50 } } };
  assert.deepEqual(Lab.validateBackup(layout).layout, layout.workspace.layout);
  layout.workspace.layout.splits.repeater.x = 90;
  assert.throws(() => Lab.validateBackup(layout), /ratio/);
});

test('encrypted full backups authenticate data and reject wrong passwords or tampering', async () => {
  const data = backup(); data.workspace.variables = 'token=example-test-token';
  const encrypted = await Lab.encryptBackup(data, 'local-test-password');
  assert.doesNotMatch(JSON.stringify(encrypted), /example-test-token/);
  assert.deepEqual(await Lab.decryptBackup(encrypted, 'local-test-password'), data);
  await assert.rejects(Lab.decryptBackup(encrypted, 'wrong-password'), /wrong password/);
  await assert.rejects(Lab.decryptBackup({ ...encrypted, data: encrypted.data.slice(0, -4) + 'AAAA' }, 'local-test-password'), /damaged/);
  await assert.rejects(Lab.encryptBackup(data, 'short'), /8 characters/);
});
