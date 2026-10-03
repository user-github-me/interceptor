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

test('encrypted full backups authenticate data and reject wrong passwords or tampering', async () => {
  const data = backup(); data.workspace.variables = 'token=example-test-token';
  const encrypted = await Lab.encryptBackup(data, 'local-test-password');
  assert.doesNotMatch(JSON.stringify(encrypted), /example-test-token/);
  assert.deepEqual(await Lab.decryptBackup(encrypted, 'local-test-password'), data);
  await assert.rejects(Lab.decryptBackup(encrypted, 'wrong-password'), /wrong password/);
  await assert.rejects(Lab.decryptBackup({ ...encrypted, data: encrypted.data.slice(0, -4) + 'AAAA' }, 'local-test-password'), /damaged/);
  await assert.rejects(Lab.encryptBackup(data, 'short'), /8 characters/);
});
