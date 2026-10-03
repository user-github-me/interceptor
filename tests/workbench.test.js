'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Workbench = require('../workbench.js');

test('HAR import normalizes text and base64 responses', () => {
  const har = { log: { entries: [{
    startedDateTime: '2026-10-02T10:00:00.000Z',
    time: 12.5,
    request: { method: 'post', url: 'https://example.test/pay', httpVersion: 'HTTP/2', headers: [{ name: 'Content-Type', value: 'application/json' }], postData: { text: '{"amount":1}' } },
    response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/2', headers: [], bodySize: 5, content: { mimeType: 'text/plain', encoding: 'base64', text: btoa('hello') } },
  }] } };
  const [entry] = Workbench.importHar(har);
  assert.equal(entry.method, 'POST');
  assert.equal(entry.resBody, 'hello');
  assert.equal(entry.note, 'imported HAR');
});

test('HAR import rejects malformed input and non-HTTP entries', () => {
  assert.throws(() => Workbench.importHar({}), /not a HAR/);
  const result = Workbench.importHar({ log: { entries: [{ request: { url: 'data:text/plain,x' }, response: {} }] } });
  assert.deepEqual(result, []);
});

test('line diff aligns replacements and additions', () => {
  const diff = Workbench.diffLines('one\ntwo\nthree', 'one\nTWO\nthree\nfour');
  assert.deepEqual(diff.rows.map((r) => r.type), ['same', 'change', 'same', 'add']);
  assert.equal(diff.rows[1].left, 'two');
  assert.equal(diff.rows[1].right, 'TWO');
});

test('decoder transforms Unicode base64, URL values, HTML, JSON, and JWTs', () => {
  const b64 = Workbench.transform('base64-encode', 'Hello 世界');
  assert.equal(Workbench.transform('base64-decode', b64), 'Hello 世界');
  assert.equal(Workbench.transform('url-decode', 'hello+world%21'), 'hello world!');
  assert.equal(Workbench.transform('html-decode', '&lt;a&gt;&#x1F680;&lt;/a&gt;'), '<a>🚀</a>');
  assert.equal(Workbench.transform('json-minify', '{\n "ok": true\n}'), '{"ok":true}');
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${enc({ alg: 'none' })}.${enc({ sub: '123' })}.signature`;
  const inspected = JSON.parse(Workbench.transform('jwt-inspect', jwt));
  assert.equal(inspected.payload.sub, '123');
  assert.equal(inspected.verified, false);
});
