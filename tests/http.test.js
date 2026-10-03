'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const HTTP = require('../http.js');

test('raw requests round-trip duplicate headers and derive the target from Host', () => {
  const parsed = HTTP.parseRequest(
    'POST /pay?q=1 HTTP/1.1\r\nHost: api.example.test\r\nX-Test: one\r\nX-Test: two\r\n\r\namount=9',
    'https://fallback.test/',
  );
  assert.equal(parsed.url, 'https://api.example.test/pay?q=1');
  assert.deepEqual(parsed.headers.filter((h) => h.name === 'X-Test').map((h) => h.value), ['one', 'two']);
  assert.equal(parsed.body, 'amount=9');
});

test('query rewriting preserves unrelated URL encoding exactly', () => {
  const result = HTTP.applyParamRule({
    url: 'https://example.test/pay?note=hello%20world&amount=9&keep=a+b#receipt',
    headers: [],
    body: '',
  }, 'amount', '1');
  assert.equal(result.url, 'https://example.test/pay?note=hello%20world&amount=1&keep=a+b#receipt');
  assert.equal(result.changes.length, 1);
});

test('JSON rewriting is nested, type-aware, and lossless for unrelated values', () => {
  const body = '{\n  "orderId": 9007199254740993,\n  "items": [{"amount": 99, "ok": true}],\n  "Amount": "9"\n}';
  const result = HTTP.applyParamRule({
    url: 'https://example.test/pay',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, 'amount', '1');
  assert.equal(result.body, '{\n  "orderId": 9007199254740993,\n  "items": [{"amount": 1, "ok": true}],\n  "Amount": "1"\n}');
  assert.deepEqual(result.changes.map((c) => c.key), ['items[0].amount', 'Amount']);
  const largeReplacement = HTTP.applyParamRule({ url: 'https://example.test/', headers: { 'Content-Type': 'application/json' }, body: '{"amount":9}' }, 'amount', '9007199254740993');
  assert.equal(largeReplacement.body, '{"amount":9007199254740993}');
});

test('multipart rewriting changes exact fields and never file parts', () => {
  const body = [
    '--AaB03x',
    'Content-Disposition: form-data; name="amount"',
    '',
    '99',
    '--AaB03x',
    'Content-Disposition: form-data; name="upload"; filename="amount"',
    'Content-Type: text/plain',
    '',
    'DO NOT CHANGE',
    '--AaB03x--',
    '',
  ].join('\r\n');
  const result = HTTP.applyParamRule({
    url: 'https://example.test/upload',
    headers: { 'Content-Type': 'multipart/form-data; boundary=AaB03x' },
    body,
  }, 'amount', '1');
  assert.match(result.body, /name="amount"\r\n\r\n1\r\n/);
  assert.match(result.body, /filename="amount"[\s\S]*DO NOT CHANGE/);
  assert.equal(result.changes.length, 1);
});

test('URL scope supports text, glob, regex, comments, and exclusion precedence', () => {
  const include = '# local APIs\nlocalhost:*/*\n/^https:\\/\\/api\\.example\\.com\\//i';
  assert.equal(HTTP.urlInScope('http://localhost:3000/pay', include, '').allowed, true);
  assert.equal(HTTP.urlInScope('https://api.example.com/pay', include, '').allowed, true);
  assert.equal(HTTP.urlInScope('https://api.example.com/logout', include, '*/logout').allowed, false);
  assert.equal(HTTP.urlInScope('https://elsewhere.test/', include, '').allowed, false);
  assert.equal(HTTP.urlInScope('https://example.test/', '/[broken/', '').errors.length, 1);
  assert.equal(HTTP.urlInScope('https://example.test/', '', '/[broken/g').allowed, false);
  assert.equal(HTTP.urlInScope('https://example.test/', '', '/example/g').errors.length, 1);
  assert.equal(HTTP.urlInScope('https://production.test/?next=http://localhost:3000/pay', 'localhost:*/*', '').allowed, false);
});

test('incomplete CDP post data is never marked safe to replace', () => {
  const result = HTTP.requestBodyText({ hasPostData: true, postDataEntries: [{ bytes: btoa('known') }, {}] });
  assert.equal(result.known, false);
  assert.equal(HTTP.requestBodyText({ hasPostData: true, postData: 'partial', postDataEntries: [{ bytes: btoa('known') }, {}] }).known, false);
});

test('JSON formatting preserves large numeric tokens and escaped strings', () => {
  const input = '{"id":9007199254740993,"values":[1e999,{},[]],"text":"a\\\"b"}';
  assert.match(HTTP.prettyBody(input), /9007199254740993/);
  assert.equal(HTTP.formatJson(HTTP.prettyBody(input), false), input);
});

test('multipart values containing boundary-like text are replaced as a whole', () => {
  const body = '--test\r\nContent-Disposition: form-data; name="amount"\r\n\r\n99--testkeep\r\n--test--\r\n';
  const result = HTTP.applyParamRule({ url: 'https://example.test/', headers: { 'Content-Type': 'multipart/form-data; boundary=test' }, body }, 'amount', '1');
  assert.equal(result.body, '--test\r\nContent-Disposition: form-data; name="amount"\r\n\r\n1\r\n--test--\r\n');
});

test('cURL export shell-quotes custom methods and user-controlled values', () => {
  const curl = HTTP.toCurl({
    method: '`open Calculator`',
    url: 'https://example.test/a',
    headers: [{ name: 'X-Test', value: "it's safe" }],
    body: '',
  });
  assert.match(curl, /-X '`open Calculator`'/);
  assert.match(curl, /X-Test: it'\\''s safe/);
});
