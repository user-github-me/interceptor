'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Workflow = require('../workflow.js');
const HTTP = require('../http.js');
const Workbench = require('../workbench.js');

test('variables preserve literal values, reject missing names, and validate targets', () => {
  const prepared = Workflow.prepareRequest('POST / HTTP/1.1\nHost: {{host}}\nAuthorization: Bearer {{token}}\n\n{"id":{{id}}}', '{{base}}', 'base=https://example.test\nhost=example.test\ntoken=a=b\nid=9007199254740993');
  assert.equal(prepared.parsed.body, '{"id":9007199254740993}');
  assert.equal(HTTP.getHeader(prepared.parsed.headers, 'authorization'), 'Bearer a=b');
  assert.throws(() => Workflow.prepareRequest('GET / HTTP/1.1\nHost: {{host}}\n\n', 'https://example.test', ''), /Missing variables/);
  assert.throws(() => Workflow.variablesFromText('not a variable'), /line 1/);
});

test('encoded form templates preserve environments and encode separators at send time', () => {
  const form = Workflow.encodeFormTemplate('literal &= {{ token }} / {{other}}');
  assert.equal(form, 'literal%20%26%3D%20{{url:token}}%20%2F%20{{url:other}}');
  assert.equal(Workflow.interpolate(form, Workflow.variablesFromText('token=a&b\nother=é')), 'literal%20%26%3D%20a%26b%20%2F%20%C3%A9');
  assert.throws(() => Workflow.interpolate('{{url:missing}}', {}), /Missing variables/);
});

test('sending captured binary or unavailable request previews is blocked', () => {
  for (const body of ['[request body unavailable — original bytes were not captured]', '[binary request body, 12 B — not shown]', 'prefix\n[… request body truncated; 800 KB total]']) {
    assert.throws(() => Workflow.prepareRequest('POST / HTTP/1.1\nContent-Type: application/octet-stream\n\n' + body, 'https://example.test'), /not captured completely/);
  }
  assert.equal(Workflow.prepareRequest('POST / HTTP/1.1\n\noriginal bytes', 'https://example.test').parsed.body, 'original bytes');
});

test('cURL import round-trips quoted headers and body without executing shell text', () => {
  const original = { method: 'POST', url: 'https://example.test/pay?a=1&b=2', headers: [{ name: 'X-Test', value: "it's literal" }, { name: 'Content-Type', value: 'application/json' }], body: '{"amount":1}' };
  const imported = Workflow.importCurl(HTTP.toCurl(original));
  const parsed = HTTP.parseRequest(imported.raw, imported.target);
  assert.equal(parsed.url, original.url);
  assert.equal(parsed.body, original.body);
  assert.equal(HTTP.getHeader(parsed.headers, 'x-test'), "it's literal");
  assert.throws(() => Workflow.importCurl('curl https://example.test ; echo unsafe'), /operators/);
  assert.throws(() => Workflow.importCurl("curl 'https://example.test' --data-binary '@file'"), /File uploads/);
  assert.throws(() => Workflow.importCurl("curl 'https://example.test' --insecure"), /Unsupported/);
});

test('Site Map groups query variations while retaining method and origin boundaries', () => {
  const endpoints = Workflow.siteMap([
    { id: 1, method: 'GET', url: 'https://example.test/orders?a=1', status: 200, duration: 10 },
    { id: 2, method: 'GET', url: 'https://example.test/orders?b=2', status: 404, duration: 30 },
    { id: 3, method: 'POST', url: 'https://example.test/orders', status: 201 },
  ]);
  assert.equal(endpoints.length, 2);
  const get = endpoints.find((endpoint) => endpoint.method === 'GET');
  assert.deepEqual(get.params, ['a', 'b']);
  assert.equal(get.averageMs, 20);
  assert.equal(get.errors, 1);
  assert.equal(get.entryId, 2);
});

test('Inspector preserves repeated parameters, exact JSON numbers and cookie attributes', () => {
  const request = 'POST /?tag=a&tag=b HTTP/1.1\nHost: example.test\nContent-Type: application/json\nCookie: session=abc=123; theme=dark\n\n{"id":9007199254740993,"nested":{"amount":1},"string":"123"}';
  const response = 'HTTP/1.1 200 OK\nContent-Type: text/html\nSet-Cookie: session=hello; Path=/; Secure; HttpOnly; SameSite=Lax\n\n<html></html>';
  const inspected = Workflow.inspectRequest(request, 'https://example.test', response);
  assert.equal(inspected.fields.filter((field) => field.name === 'tag').length, 2);
  assert.equal(inspected.fields.find((field) => field.name === 'id').value, '9007199254740993');
  assert.equal(inspected.fields.find((field) => field.name === 'string').value, '"123"');
  assert.equal(inspected.fields.find((field) => field.location === 'Cookie' && field.name === 'session').value, 'abc=123');
  assert.equal(inspected.cookies[0].httpOnly, true);
  assert.equal(inspected.cookies[0].sameSite, 'Lax');
});

test('payload and collection import enforce limits and preserve literal values', () => {
  assert.deepEqual(Workflow.payloadsFromText('0\n"hello"\nnull\n'), ['0', '"hello"', 'null']);
  assert.throws(() => Workflow.payloadsFromText(Array(51).fill('x').join('\n')), /50/);
  assert.throws(() => Workflow.importCollection({ requests: [] }), /not an Interceptor/);
  const [request] = Workflow.importCollection({ format: 'interceptor-collection', version: 1, requests: [{ raw: 'GET / HTTP/1.1\nHost: {{host}}\n\n', target: '{{base}}', name: 'Health check' }] });
  assert.equal(request.name, 'Health check');
  assert.equal(request.target, '{{base}}');
});

test('hex and hashes support Unicode and standard known vectors', async () => {
  assert.equal(Workbench.transform('hex-decode', Workbench.transform('hex-encode', 'Hello 世界')), 'Hello 世界');
  assert.throws(() => Workbench.transform('hex-decode', 'abc'), /pairs/);
  assert.equal(await Workbench.hash('SHA-256', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('CSV export quotes commas, multiline text, and prevents formula execution', () => {
  assert.equal(Workflow.csvRows([['=SUM(1,2)', 'a"b', 'two\nlines'], ['okay', -1, '']]), '"\'=SUM(1,2)","a""b","two\nlines"\r\n"okay","\'-1",""');
});
