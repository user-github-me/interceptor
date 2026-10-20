'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Backup = require('../backup.js');
const Lab = require('../lab.js');
const HTTP = require('../http.js');
const fs = require('node:fs');
const vm = require('node:vm');

const empty = () => ({ format: 'interceptor-backup', version: 1, workspace: { history: [], repeaters: [], collections: [], autoLog: [], runnerResults: [], findings: [], environments: [], websocketFrames: [], fields: {}, settings: {} } });
const password = 'local-fixture-backup-password';
async function frames(blob) { return (await blob.text()).trimEnd().split('\n'); }
const framed = (lines) => new Blob([lines.join('\n') + '\n']);

test('chunked plaintext and encrypted backups retain UTF-8, escaped strings, local files and legacy compatibility', async () => {
  const data = empty();
  data.workspace.history.push({ id: 1, url: 'file:///tmp/fixture.html', method: 'GET', wallTime: 1, reqHeaders: [], resHeaders: [], resBody: 'Local document' });
  data.workspace.fields.decoderOutput = 'a'.repeat(Backup.limits.chunkBytes - 800) + '\u0000"\\é中😀'.repeat(100) + 'tail';
  data.workspace.settings.ownKeys = JSON.parse('{"__proto__":{"local":true},"constructor":{"fixture":1}}');
  for (const secret of ['', password]) {
    const progress = [];
    const blob = await Backup.createBlob(data, secret, { onProgress: (event) => progress.push(event) });
    assert.ok(progress.length >= 2);
    assert.ok(progress.every((event) => event.phase === 'export'));
    if (secret) assert.doesNotMatch(await blob.text(), /Local document|fixture\.html/);
    const workspace = await Backup.readFile(blob, secret);
    assert.deepEqual(workspace, data.workspace);
    assert.equal(Object.getPrototypeOf(workspace.settings.ownKeys), Object.prototype);
    assert.equal(Object.hasOwn(workspace.settings.ownKeys, '__proto__'), true);
  }
  assert.deepEqual(await Backup.readFile(new Blob([JSON.stringify(data, null, 2)])), data.workspace);
  assert.deepEqual(await Backup.readFile(new Blob([JSON.stringify(await Lab.encryptBackup(data, password))]), password), data.workspace);
});

test('backup parsing rejects duplicate keys, invalid Unicode bytes, incomplete JSON, nesting and array attacks', async () => {
  for (const json of ['{"format":"interceptor-backup","format":"interceptor-backup"}', '{"settings":{"__proto__":1,"__proto__":2}}', '{"a":[1,]}', '{"a":1,}', '{"a":"unfinished', '{} garbage', '{"a":NaN}', '{"a":1e9999}']) {
    await assert.rejects(Backup.readFile(new Blob([json])));
  }
  await assert.rejects(Backup.readFile(new Blob([new Uint8Array([0x7b, 0xc0, 0xaf, 0x7d])])), /encoded data|encoding/i);
  await assert.rejects(Backup.readFile(new Blob(['['.repeat(101) + '0' + ']'.repeat(101)])), /deeply/);
  await assert.rejects(Backup.readFile(new Blob(['[' + '0,'.repeat(10_000) + '0]'])), /10,000/);
  const excessive = empty(); excessive.workspace.fields.decoderOutput = 'x'.repeat(Backup.limits.stringChars + 1);
  await assert.rejects(Backup.createBlob(excessive), /tool draft|too large/);
  await assert.rejects(Backup.readFile({ size: Backup.limits.fileBytes + 1, slice() { throw Error('Must reject before reading'); } }), /1.4 GB/);
});

test('framed backups require header, contiguous bounded chunks, matching footer and no trailing data', async () => {
  const data = empty(); data.workspace.fields.decoderOutput = 'x'.repeat(Backup.limits.chunkBytes + 100);
  const original = await frames(await Backup.createBlob(data));
  const variants = [original.slice(0, -1), original.concat('{}'), original.slice(0, -2).concat(original.at(-1)), [original[0], original[2], original[1], ...original.slice(3)]];
  const footer = JSON.parse(original.at(-1)); footer.bytes++;
  variants.push([...original.slice(0, -1), JSON.stringify(footer)]);
  const header = JSON.parse(original[0]); header.chunkBytes++;
  variants.push([JSON.stringify(header), ...original.slice(1)]);
  variants.push([original[0].replace('"encrypted":false', '"encrypted":false,"encrypted":false'), ...original.slice(1)]);
  const chunk = JSON.parse(original[1]); chunk.data = chunk.data.slice(0, -1) + '!';
  variants.push([original[0], JSON.stringify(chunk), ...original.slice(2)]);
  for (const variant of variants) await assert.rejects(Backup.readFile(framed(variant)));
  await assert.rejects(Backup.readFile(new Blob([original.join('\n')])), /line ending/);
  await assert.rejects(Backup.readFile(new Blob([original[0] + '\n' + 'x'.repeat(2 * Backup.limits.chunkBytes)])), /frame is too large/);

  // The integrity chain verifies bytes; schema validation separately rejects
  // even a correctly hashed frame that contains executable history URLs.
  const invalid = empty(); invalid.workspace.history.push({ id: 1, url: 'javascript:alert(1)', method: 'GET', wallTime: 1, reqHeaders: [], resHeaders: [] });
  const bytes = new TextEncoder().encode(JSON.stringify(invalid));
  const chained = new Uint8Array(32 + bytes.length); chained.set(bytes, 32);
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', chained)).toString('hex');
  await assert.rejects(Backup.readFile(framed([original[0], JSON.stringify({ kind: 'chunk', index: 0, data: HTTP.bytesToB64(bytes) }), JSON.stringify({ kind: 'end', chunks: 1, bytes: bytes.length, hash })])), /history URL/);
});

test('encrypted chunk authentication rejects wrong passwords, reordering, substituted metadata and damaged footer', async () => {
  const data = empty(); data.workspace.fields.decoderOutput = 'private fixture '.repeat(80_000);
  const original = await frames(await Backup.createBlob(data, password));
  await assert.rejects(Backup.readFile(framed(original), 'wrong-fixture-password'), /wrong password|damaged/);
  await assert.rejects(Backup.createBlob(data, 'short'), /8 characters/);
  const reorder = [original[0], original[2], original[1], ...original.slice(3)];
  const header = JSON.parse(original[0]); header.nonce = HTTP.bytesToB64(new Uint8Array(8));
  const footer = JSON.parse(original.at(-1)); footer.data = 'AAAA';
  for (const variant of [reorder, [JSON.stringify(header), ...original.slice(1)], [...original.slice(0, -1), JSON.stringify(footer)], original.slice(0, -1)]) {
    await assert.rejects(Backup.readFile(framed(variant)), /8 characters|password|reordered|incomplete/);
    await assert.rejects(Backup.readFile(framed(variant), password));
  }
});

test('the aggregate JSON boundary round-trips exactly and rejects the next byte before download or restore', async () => {
  // Exercise the production parser/serializer with a smaller aggregate budget,
  // preserving production chunk size. This makes byte-exact boundaries cheap
  // enough for each contribution while the separate 204 MB fixture stays real.
  const limit = 3 * Backup.limits.chunkBytes;
  const source = fs.readFileSync(require.resolve('../backup.js'), 'utf8').replace('const MAX_JSON_BYTES = 1_000_000_000;', `const MAX_JSON_BYTES = ${limit};`);
  const context = vm.createContext({ HTTP, Lab, Blob, TextEncoder, TextDecoder, Uint8Array, DataView, crypto, setTimeout });
  vm.runInContext(source, context);
  const bounded = context.Backup, data = empty(); data.workspace.fields.decoderOutput = '';
  data.workspace.fields.decoderOutput = 'x'.repeat(limit - Buffer.byteLength(JSON.stringify(data)));
  assert.equal(Buffer.byteLength(JSON.stringify(data)), limit);
  for (const secret of ['', password]) {
    const blob = await bounded.createBlob(data, secret);
    const workspace = await bounded.readFile(blob, secret);
    assert.equal(workspace.fields.decoderOutput.length, data.workspace.fields.decoderOutput.length);
  }
  data.workspace.fields.decoderOutput += 'x';
  await assert.rejects(bounded.createBlob(data), /1 GB/);
  // A file produced by the ordinary larger-budget writer cannot bypass the
  // importer budget; it fails before an object is returned to the UI.
  const oversized = await Backup.createBlob(data);
  await assert.rejects(bounded.readFile(oversized), /1 GB/);
});

test('corrupt saved records have an explicit raw recovery export without weakening normal restore validation', async () => {
  const damaged = empty(); damaged.workspace.history = 'broken saved metadata';
  await assert.rejects(Backup.createBlob(damaged), /history/);
  const recovery = await Backup.recoveryBlob(damaged);
  const rawFrames = await frames(recovery);
  const chunk = JSON.parse(rawFrames[1]);
  const recovered = JSON.parse(new TextDecoder().decode(HTTP.b64ToBytes(chunk.data)));
  assert.deepEqual(recovered, damaged);
  assert.equal(damaged.workspace.history, 'broken saved metadata');
  await assert.rejects(Backup.readFile(recovery), /history/);
});

test('51 accepted 4 MB Repeater responses round-trip as chunked backups including encryption overhead', { timeout: 180_000 }, async () => {
  const data = empty(), response = 'HTTP/1.1 200 OK\n\n' + 'x'.repeat(4_000_000);
  data.workspace.repeaters = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, raw: 'GET /large HTTP/1.1\nHost: localhost:3000\n\n', target: 'http://localhost:3000', response, sent: '', assertions: '[]' }));
  Lab.validateBackup(data, { clone: false });
  for (const secret of ['', password]) {
    const blob = await Backup.createBlob(data, secret);
    assert.ok(blob.size > 200_000_000, 'fixture covers the previous file-import ceiling');
    assert.ok(blob.size < Backup.limits.fileBytes);
    const workspace = await Backup.readFile(blob, secret);
    assert.equal(workspace.repeaters.length, 51);
    assert.equal(workspace.repeaters[0].response, response);
    assert.equal(workspace.repeaters[50].response, response);
  }
  // Recover already-downloaded plaintext JSON over the old 200 MB ceiling too.
  // Construct separate entry pieces rather than a monolithic 204 MB string.
  const baseline = JSON.stringify({ ...data, workspace: { ...data.workspace, repeaters: [] } });
  const marker = '"repeaters":[]', at = baseline.indexOf(marker);
  const parts = [baseline.slice(0, at) + '"repeaters":['];
  for (const [i, entry] of data.workspace.repeaters.entries()) { if (i) parts.push(','); parts.push(JSON.stringify(entry)); }
  parts.push(']' + baseline.slice(at + marker.length));
  const legacy = new Blob(parts);
  assert.ok(legacy.size > 200_000_000);
  const restored = await Backup.readFile(legacy);
  assert.equal(restored.repeaters.length, 51);
  assert.equal(restored.repeaters[50].response, response);
});
