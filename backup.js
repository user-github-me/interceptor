'use strict';
/* Bounded, local full-workspace backup I/O. No scripts or network access. */
(function (global) {
  const HTTP = global.HTTP || (typeof require !== 'undefined' ? require('./http.js') : null);
  const Lab = global.Lab || (typeof require !== 'undefined' ? require('./lab.js') : null);
  const CHUNK_BYTES = 1_048_576;
  const MAX_JSON_BYTES = 1_000_000_000;
  const MAX_FILE_BYTES = 1_400_000_000;
  const MAX_LEGACY_ENCRYPTED_BYTES = 200_000_000;
  const MAX_NODES = 1_000_000;
  const MAX_DEPTH = 100;
  const MAX_STRING_CHARS = 16_000_000;
  const encoder = new TextEncoder();
  // Timer callbacks are clamped to one second in background tabs. MessageChannel
  // yields between chunks without turning a 204 MB backup into a minutes-long
  // operation, and still lets input/rendering tasks run between data chunks.
  let yieldChannel;
  const yieldQueue = [];
  function pause() {
    if (typeof window === 'undefined' || typeof MessageChannel === 'undefined') return new Promise((resolve) => setTimeout(resolve, 0));
    if (!yieldChannel) {
      yieldChannel = new MessageChannel();
      yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
      yieldChannel.port1.unref?.(); yieldChannel.port2.unref?.();
    }
    return new Promise((resolve) => { yieldQueue.push(resolve); yieldChannel.port2.postMessage(null); });
  }
  const fail = (text) => { throw new Error(text); };
  const budgetError = () => fail('Full backups support up to 1 GB of workspace JSON. Export individual history/collections too; no workspace data was changed.');

  // Only one scalar token is buffered. Containers are built directly into a new
  // object, without a full-file string or JSON.parse of the entire workspace.
  class JsonReader {
    constructor(options = {}) { this.stack = []; this.root = undefined; this.hasRoot = false; this.nodes = 0; this.token = null; this.legacyEncryptedBytes = options.legacyEncryptedBytes || 0; }
    add(value) {
      if (++this.nodes > MAX_NODES) fail('Backup has too many values (maximum 1,000,000).');
      const frame = this.stack.at(-1);
      if (!frame) {
        if (this.hasRoot) fail('Unexpected data after backup JSON.');
        this.root = value; this.hasRoot = true; return;
      }
      if (frame.type === 'array') {
        if (!['value', 'value-or-end'].includes(frame.state)) fail('Invalid backup JSON array.');
        if (frame.value.length >= 10_000) fail('Backup array exceeds 10,000 entries.');
        frame.value.push(value);
      } else {
        if (frame.state !== 'value') fail('Invalid backup JSON object.');
        // __proto__ is an ordinary own property, never an object setter.
        Object.defineProperty(frame.value, frame.key, { value, enumerable: true, writable: true, configurable: true });
      }
      frame.state = 'comma-or-end';
    }
    feed(text) {
      let i = 0;
      while (i < text.length) {
        if (this.token?.type === 'string') {
          const token = this.token;
          let end = i;
          while (end < text.length) {
            const ch = text[end++];
            if (token.escape) { token.escape = false; continue; }
            if (ch === '\\') { token.escape = true; continue; }
            if (ch === '"') { token.closed = true; break; }
          }
          const part = text.slice(i, end); token.parts.push(part); token.length += part.length; i = end;
          if (token.length > (token.key ? 120_002 : token.limit * 6 + 2)) fail('Backup JSON string is too large.');
          if (!token.closed) continue;
          const value = JSON.parse(token.parts.join(''));
          if (value.length > (token.key ? 20_000 : token.limit)) fail('Backup string value is too large.');
          this.token = null;
          if (token.key) {
            const frame = this.stack.at(-1);
            if (frame.keys.has(value)) fail('Duplicate property in backup JSON.');
            if (frame.keys.size >= 10_000) fail('Backup object has too many properties.');
            frame.keys.add(value); frame.key = value; frame.state = 'colon';
          } else this.add(value);
          continue;
        }
        if (this.token) {
          const token = this.token;
          const match = /^[A-Za-z0-9+\-.]*/.exec(text.slice(i))[0];
          token.parts.push(match); token.length += match.length; i += match.length;
          if (token.length > 1000) fail('Invalid numeric or literal backup JSON token.');
          if (i === text.length) continue;
          this.finishToken(); continue;
        }
        const ch = text[i];
        if (/\s/.test(ch)) { if (!/[ \t\r\n]/.test(ch)) fail('Invalid JSON whitespace.'); i++; continue; }
        const frame = this.stack.at(-1);
        if (frame?.state === 'colon') { if (ch !== ':') fail('Missing colon in backup JSON.'); frame.state = 'value'; i++; continue; }
        if (frame?.state === 'comma-or-end') {
          if (ch === ',') { frame.state = frame.type === 'object' ? 'key' : 'value'; i++; continue; }
          if (ch === (frame.type === 'object' ? '}' : ']')) { this.stack.pop(); i++; continue; }
          fail('Missing comma in backup JSON.');
        }
        if (frame?.type === 'object' && ['key', 'key-or-end'].includes(frame.state)) {
          if (ch === '}' && frame.state === 'key-or-end') { this.stack.pop(); i++; continue; }
          if (ch !== '"') fail('Invalid property name in backup JSON.');
          this.token = { type: 'string', key: true, parts: ['"'], length: 1, escape: false }; i++; continue;
        }
        if (frame?.type === 'array' && frame.state === 'value-or-end' && ch === ']') { this.stack.pop(); i++; continue; }
        if (!frame && this.hasRoot) fail('Unexpected data after backup JSON.');
        if (ch === '{' || ch === '[') {
          if (this.stack.length >= MAX_DEPTH) fail('Backup JSON is nested too deeply.');
          const value = ch === '{' ? {} : []; this.add(value);
          this.stack.push(ch === '{' ? { type: 'object', value, keys: new Set(), state: 'key-or-end' } : { type: 'array', value, state: 'value-or-end' }); i++; continue;
        }
        if (ch === '"') {
          const legacyData = this.stack.length === 1 && frame?.type === 'object' && frame.key === 'data' && this.root.format === 'interceptor-encrypted-backup';
          this.token = { type: 'string', key: false, parts: ['"'], length: 1, escape: false, limit: legacyData ? this.legacyEncryptedBytes || MAX_STRING_CHARS : MAX_STRING_CHARS }; i++; continue;
        }
        if (/[\-0-9tfn]/.test(ch)) { this.token = { type: 'primitive', parts: [], length: 0 }; continue; }
        fail('Invalid backup JSON.');
      }
    }
    finishToken() {
      const value = JSON.parse(this.token.parts.join(''));
      if (typeof value === 'number' && !Number.isFinite(value)) fail('Invalid non-finite number in backup.');
      this.token = null; this.add(value);
    }
    finish() {
      if (this.token?.type === 'primitive') this.finishToken();
      if (this.token || this.stack.length || !this.hasRoot) fail('Backup JSON is incomplete.');
      return this.root;
    }
  }

  // Generate bounded string pieces, preserving JSON's ordinary undefined/null
  // handling. Sources are local snapshots or validated imported objects.
  function* jsonPieces(value, depth = 0, seen = new Set(), counter = { nodes: 0 }) {
    if (++counter.nodes > MAX_NODES) fail('Backup has too many values (maximum 1,000,000).');
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_CHARS) fail('Backup string value is too large.');
      yield '"';
      for (let i = 0; i < value.length; i += 8192) yield JSON.stringify(value.slice(i, i + 8192)).slice(1, -1);
      yield '"'; return;
    }
    if (value == null || typeof value === 'boolean' || typeof value === 'number') { yield JSON.stringify(value); return; }
    if (typeof value !== 'object') fail('Unsupported value in backup.');
    if (depth >= MAX_DEPTH || seen.has(value)) fail('Backup contains a cycle or is nested too deeply.');
    seen.add(value);
    const array = Array.isArray(value), keys = array ? Array.from({ length: value.length }, (_, i) => i) : Object.keys(value).filter((key) => value[key] !== undefined);
    if (keys.length > 10_000) fail('Backup container exceeds 10,000 entries.');
    yield array ? '[' : '{'; let first = true;
    for (const key of keys) {
      if (!first) yield ','; first = false;
      if (!array) { if (key.length > 20_000) fail('Backup property name is too large.'); yield JSON.stringify(key); yield ':'; }
      yield* jsonPieces(array && value[key] === undefined ? null : value[key], depth + 1, seen, counter);
    }
    yield array ? ']' : '}'; seen.delete(value);
  }
  async function* jsonChunks(value) {
    let buffer = new Uint8Array(CHUNK_BYTES), offset = 0, total = 0;
    for (const piece of jsonPieces(value)) {
      const bytes = encoder.encode(piece);
      let position = 0;
      while (position < bytes.length) {
        const count = Math.min(bytes.length - position, CHUNK_BYTES - offset);
        buffer.set(bytes.subarray(position, position + count), offset); offset += count; position += count; total += count;
        if (total > MAX_JSON_BYTES) budgetError();
        if (offset === CHUNK_BYTES) { yield buffer; buffer = new Uint8Array(CHUNK_BYTES); offset = 0; }
      }
    }
    if (offset) yield buffer.subarray(0, offset);
  }
  function decode64(text, maxBytes) {
    if (typeof text !== 'string' || !text.length || text.length > 4 * Math.ceil(maxBytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail('Invalid backup Base64 encoding.');
    const bytes = HTTP.b64ToBytes(text);
    if (bytes.length > maxBytes || HTTP.bytesToB64(bytes) !== text) fail('Invalid backup Base64 encoding.');
    return bytes;
  }
  function ivFor(nonce, index) {
    const iv = new Uint8Array(12); iv.set(nonce); new DataView(iv.buffer).setUint32(8, index); return iv;
  }
  async function keyFor(password, salt) {
    if (typeof password !== 'string' || password.length < 8) fail('Use a backup password with at least 8 characters.');
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 200_000 }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function chain(previous, bytes) {
    const source = new Uint8Array(previous.length + bytes.length); source.set(previous); source.set(bytes, previous.length);
    return new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  }
  const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const aadFor = (headerLine, kind, index) => encoder.encode(headerLine + '\n' + kind + ':' + index);
  async function encodeBlob(backup, password, options) {
    const encrypted = !!password;
    const header = { format: 'interceptor-backup-stream', version: 2, encoding: 'base64', chunkBytes: CHUNK_BYTES, encrypted };
    let key, nonce;
    if (encrypted) {
      const salt = crypto.getRandomValues(new Uint8Array(16)); nonce = crypto.getRandomValues(new Uint8Array(8));
      header.salt = HTTP.bytesToB64(salt); header.nonce = HTTP.bytesToB64(nonce); header.iterations = 200_000;
      key = await keyFor(password, salt);
    }
    const headerLine = JSON.stringify(header), parts = [new Blob([headerLine + '\n'])];
    let fileBytes = parts[0].size, count = 0, total = 0, hash = new Uint8Array(32);
    const append = (line) => { const part = new Blob([line + '\n']); fileBytes += part.size; if (fileBytes > MAX_FILE_BYTES) budgetError(); parts.push(part); };
    for await (const plaintext of jsonChunks(backup)) {
      total += plaintext.length; hash = await chain(hash, plaintext);
      const output = encrypted ? new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivFor(nonce, count), additionalData: aadFor(headerLine, 'chunk', count) }, key, plaintext)) : plaintext;
      append(JSON.stringify({ kind: 'chunk', index: count, data: HTTP.bytesToB64(output) })); count++;
      options.onProgress?.({ phase: 'export', bytes: total, total: null });
      await pause();
    }
    const footer = { chunks: count, bytes: total, hash: hex(hash) };
    if (encrypted) {
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivFor(nonce, count), additionalData: aadFor(headerLine, 'end', count) }, key, encoder.encode(JSON.stringify(footer)));
      append(JSON.stringify({ kind: 'end', data: HTTP.bytesToB64(new Uint8Array(ciphertext)) }));
    } else append(JSON.stringify({ kind: 'end', ...footer }));
    return new Blob(parts, { type: 'application/x-ndjson' });
  }

  async function createBlob(backup, password = '', options = {}) {
    Lab.validateBackup(backup, { clone: false });
    return encodeBlob(backup, password, options);
  }
  // A corrupt saved record must remain recoverable for manual repair. This
  // explicit path preserves its raw values, without promising a valid restore.
  // It shares all serialization bounds and never overwrites local storage.
  async function recoveryBlob(savedRecord, options = {}) {
    return encodeBlob(savedRecord, '', options);
  }

  async function* fileBytes(file) {
    // Slicing imposes a bound even when a browser/Blob stream chooses huge reads.
    for (let position = 0; position < file.size; position += CHUNK_BYTES) yield new Uint8Array(await file.slice(position, position + CHUNK_BYTES).arrayBuffer());
  }
  async function* lines(file, options) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '', progress = 0;
    for await (const bytes of fileBytes(file)) {
      progress += bytes.length; pending += decoder.decode(bytes, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line.length > 4 * Math.ceil((CHUNK_BYTES + 16) / 3) + 256) fail('Backup frame is too large.');
        yield line;
      }
      if (pending.length > 4 * Math.ceil((CHUNK_BYTES + 16) / 3) + 256) fail('Backup frame is too large.');
      options.onProgress?.({ phase: 'import', bytes: progress, total: file.size }); await pause();
    }
    pending += decoder.decode();
    if (pending) fail('Backup is incomplete: missing final line ending.');
  }
  async function readFramed(file, password, options) {
    const reader = new JsonReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let header, headerLine, key, nonce, count = 0, total = 0, hash = new Uint8Array(32), ended = false, short = false;
    for await (const line of lines(file, options)) {
      if (ended) fail('Unexpected data after backup footer.');
      const frameReader = new JsonReader(); frameReader.feed(line);
      const frame = frameReader.finish();
      if (!header) {
        if (!frame || frame.format !== 'interceptor-backup-stream' || frame.version !== 2 || frame.encoding !== 'base64' || frame.chunkBytes !== CHUNK_BYTES || typeof frame.encrypted !== 'boolean') fail('Unsupported full backup header.');
        const allowed = frame.encrypted ? ['format', 'version', 'encoding', 'chunkBytes', 'encrypted', 'salt', 'nonce', 'iterations'] : ['format', 'version', 'encoding', 'chunkBytes', 'encrypted'];
        if (Object.keys(frame).length !== allowed.length || Object.keys(frame).some((key) => !allowed.includes(key))) fail('Invalid full backup header.');
        header = frame; headerLine = line;
        if (header.encrypted) {
          if (header.iterations !== 200_000) fail('Unsupported backup key derivation.');
          const salt = decode64(header.salt, 16); nonce = decode64(header.nonce, 8);
          if (salt.length !== 16 || nonce.length !== 8) fail('Invalid encrypted backup metadata.');
          key = await keyFor(password, salt);
        }
        continue;
      }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) fail('Invalid backup frame.');
      if (frame.kind === 'chunk') {
        if (short || frame.index !== count || Object.keys(frame).length !== 3 || Object.keys(frame).some((key) => !['kind', 'index', 'data'].includes(key))) fail('Missing, reordered or invalid backup chunk.');
        let bytes = decode64(frame.data, CHUNK_BYTES + (header.encrypted ? 16 : 0));
        if (header.encrypted) {
          try { bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivFor(nonce, count), additionalData: aadFor(headerLine, 'chunk', count) }, key, bytes)); }
          catch { fail('Unable to unlock backup: wrong password or damaged file.'); }
        }
        if (!bytes.length || bytes.length > CHUNK_BYTES) fail('Invalid backup chunk size.');
        short = bytes.length < CHUNK_BYTES; total += bytes.length;
        if (total > MAX_JSON_BYTES) budgetError();
        hash = await chain(hash, bytes); reader.feed(decoder.decode(bytes, { stream: true })); count++;
      } else if (frame.kind === 'end') {
        let footer = frame;
        if (header.encrypted) {
          if (Object.keys(frame).length !== 2) fail('Invalid encrypted backup footer.');
          try {
            const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivFor(nonce, count), additionalData: aadFor(headerLine, 'end', count) }, key, decode64(frame.data, 1024));
            footer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          } catch { fail('Unable to unlock backup: wrong password or damaged file.'); }
        }
        const expectedKeys = header.encrypted ? ['chunks', 'bytes', 'hash'] : ['kind', 'chunks', 'bytes', 'hash'];
        if (Object.keys(footer).length !== expectedKeys.length || Object.keys(footer).some((key) => !expectedKeys.includes(key)) || footer.chunks !== count || footer.bytes !== total || footer.hash !== hex(hash) || !count) fail('Backup is incomplete or damaged.');
        reader.feed(decoder.decode()); ended = true;
      } else fail('Unknown backup frame.');
    }
    if (!ended) fail('Backup is incomplete: final verification footer is missing.');
    return Lab.validateBackup(reader.finish(), { clone: false });
  }
  async function readLegacy(file, password, options) {
    // Original encrypted envelopes have one large Base64 scalar. Allow that
    // scalar only inside the legacy 200 MB compatibility budget.
    const reader = new JsonReader({ legacyEncryptedBytes: file.size <= MAX_LEGACY_ENCRYPTED_BYTES ? MAX_LEGACY_ENCRYPTED_BYTES : 0 }), decoder = new TextDecoder('utf-8', { fatal: true }); let total = 0;
    for await (const bytes of fileBytes(file)) {
      total += bytes.length; if (total > MAX_JSON_BYTES) budgetError();
      reader.feed(decoder.decode(bytes, { stream: true }));
      options.onProgress?.({ phase: 'import', bytes: total, total: file.size }); await pause();
    }
    reader.feed(decoder.decode()); let input = reader.finish();
    if (input?.format === 'interceptor-encrypted-backup') {
      if (file.size > MAX_LEGACY_ENCRYPTED_BYTES) fail('Legacy encrypted backups support up to 200 MB. Unlock and re-export using a version that created this file; new chunked backups support 1 GB of workspace JSON.');
      input = await Lab.decryptBackup(input, password);
    }
    return Lab.validateBackup(input, { clone: false });
  }
  async function readFile(file, password = '', options = {}) {
    if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1) fail('Choose a non-empty workspace backup file.');
    if (file.size > MAX_FILE_BYTES) fail('Full backup files support up to 1.4 GB, representing at most 1 GB of workspace JSON. No workspace data was changed.');
    const prefix = await file.slice(0, 8192).text();
    let first;
    try { first = JSON.parse(prefix.split('\n')[0]); } catch { /* Ordinary legacy JSON may span lines. */ }
    return first?.format === 'interceptor-backup-stream' ? readFramed(file, password, options) : readLegacy(file, password, options);
  }
  const api = { createBlob, recoveryBlob, readFile, limits: Object.freeze({ chunkBytes: CHUNK_BYTES, jsonBytes: MAX_JSON_BYTES, fileBytes: MAX_FILE_BYTES, nodes: MAX_NODES, depth: MAX_DEPTH, stringChars: MAX_STRING_CHARS }) };
  global.Backup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
