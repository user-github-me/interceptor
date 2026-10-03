'use strict';
/* Raw HTTP message helpers: serialize / parse raw requests & responses,
 * base64 <-> bytes, body decoding, cURL export. No DOM or chrome.* usage,
 * so it can be unit-tested in Node. */
(function (global) {
  const REASONS = {
    100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted',
    204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found',
    303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone',
    413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity',
    429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented',
    502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  };

  const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n');

  /** CDP headers come as an object (duplicates joined by "\n") or as a {name,value} array. */
  function headersToList(h) {
    if (!h) return [];
    if (Array.isArray(h)) return h.map((x) => ({ name: String(x.name), value: String(x.value ?? '') }));
    const out = [];
    for (const [name, value] of Object.entries(h)) {
      for (const part of String(value).split('\n')) out.push({ name, value: part });
    }
    return out;
  }

  function getHeader(list, name) {
    const n = name.toLowerCase();
    const h = list.find((x) => x.name.toLowerCase() === n);
    return h ? h.value : undefined;
  }

  function splitMessage(raw) {
    const text = norm(raw).replace(/^(?:[ \t]*\n)+/, '');
    const sep = text.indexOf('\n\n');
    return sep === -1
      ? { head: text.replace(/\n$/, ''), body: '' }
      : { head: text.slice(0, sep), body: text.slice(sep + 2) };
  }

  function parseHeaderLines(lines) {
    const headers = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const i = line.indexOf(':');
      if (i <= 0) throw new Error(`Invalid header line: "${line}" (expected "Name: value")`);
      const name = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`Invalid HTTP header: "${name}"`);
      headers.push({ name, value });
    }
    return headers;
  }

  /** Multipart bodies need CRLF, which <textarea> silently converts to LF. */
  function fixBodyLineEndings(headers, body) {
    const ct = getHeader(headers, 'content-type') || '';
    return /^multipart\//i.test(ct) ? norm(body).replace(/\n/g, '\r\n') : body;
  }

  function serializeRequest({ method, url, headers, body }) {
    const u = new URL(url);
    const list = headersToList(headers).filter((h) => !h.name.startsWith(':') && h.name.toLowerCase() !== 'host');
    const lines = [`${method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`];
    for (const h of list) lines.push(`${h.name}: ${h.value}`);
    return lines.join('\n') + '\n\n' + norm(body || '');
  }

  /**
   * Parse a raw request. The URL is built from the request line + Host header,
   * using the scheme of `baseUrl` (absolute URLs in the request line win).
   */
  function parseRequest(raw, baseUrl) {
    const { head, body } = splitMessage(raw);
    const lines = head.split('\n');
    const m = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/i.exec(lines[0] || '');
    if (!m) throw new Error('Invalid request line. Expected e.g. "POST /api/login HTTP/1.1"');
    const method = m[1].toUpperCase();
    const target = m[2];
    const headers = parseHeaderLines(lines.slice(1));
    let url;
    if (/^https?:\/\//i.test(target)) {
      url = new URL(target);
    } else {
      const base = new URL(baseUrl);
      const host = getHeader(headers, 'host') || base.host;
      url = new URL(`${base.protocol}//${host}${target.startsWith('/') ? target : '/' + target}`);
    }
    const rest = headers.filter((h) => h.name.toLowerCase() !== 'host');
    return { method, url: url.href, headers: rest, body: fixBodyLineEndings(rest, body) };
  }

  function statusText(code, text) {
    return text || REASONS[code] || '';
  }

  function serializeResponse({ status, statusText: st, headers, body, httpVersion }) {
    const lines = [`${httpVersion || 'HTTP/1.1'} ${status} ${statusText(status, st)}`.trimEnd()];
    for (const h of headersToList(headers)) if (!h.name.startsWith(':')) lines.push(`${h.name}: ${h.value}`);
    return lines.join('\n') + '\n\n' + norm(body || '');
  }

  function parseResponse(raw) {
    const { head, body } = splitMessage(raw);
    const lines = head.split('\n');
    const m = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/i.exec((lines[0] || '').trim());
    if (!m) throw new Error('Invalid status line. Expected e.g. "HTTP/1.1 200 OK"');
    const headers = parseHeaderLines(lines.slice(1));
    return { status: Number(m[1]), statusText: (m[2] || '').trim(), headers, body: fixBodyLineEndings(headers, body) };
  }

  // ---- bytes / base64 ----
  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const utf8ToB64 = (str) => bytesToB64(new TextEncoder().encode(str));

  function concatBytes(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  /** Decode bytes as UTF-8 text, or report them as binary. */
  function decodeBody(bytes) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Many NUL / control chars => almost certainly binary.
      const sample = text.slice(0, 4096);
      const ctrl = (sample.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
      if (sample.length && ctrl / sample.length > 0.05) return { text: '', binary: true, size: bytes.length };
      return { text, binary: false, size: bytes.length };
    } catch {
      return { text: '', binary: true, size: bytes.length };
    }
  }

  /** Format JSON without converting number tokens to floating point values. */
  function formatJson(text, pretty = true) {
    JSON.parse(text); // Validate syntax; use the source tokens for output.
    let out = '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    const line = () => '\n' + '  '.repeat(depth);
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        out += c;
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (/\s/.test(c)) continue;
      if (c === '"') { inString = true; out += c; }
      else if (c === '{' || c === '[') {
        out += c;
        depth++;
        let nextIndex = i + 1;
        while (/\s/.test(text[nextIndex] || '')) nextIndex++;
        const next = text[nextIndex];
        if (pretty && next !== '}' && next !== ']') out += line();
      } else if (c === '}' || c === ']') {
        depth--;
        let prevIndex = i - 1;
        while (/\s/.test(text[prevIndex] || '')) prevIndex--;
        const prev = text[prevIndex];
        if (pretty && prev !== '{' && prev !== '[') out += line();
        out += c;
      } else if (c === ',') out += pretty ? ',' + line() : ',';
      else if (c === ':') out += pretty ? ': ' : ':';
      else out += c;
    }
    return out;
  }

  function prettyBody(body) {
    const t = (body || '').trim();
    if (!t || !/^[[{]/.test(t)) return body;
    try { return formatJson(t); } catch { return body; }
  }

  function toCurl({ method, url, headers, body }) {
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const parts = [`curl ${q(url)}`];
    if (method !== 'GET' || body) parts.push(`-X ${q(method)}`);
    for (const h of headersToList(headers)) {
      if (h.name.startsWith(':') || /^(host|content-length)$/i.test(h.name)) continue;
      parts.push(`-H ${q(`${h.name}: ${h.value}`)}`);
    }
    if (body) parts.push(`--data-raw ${q(body)}`);
    return parts.join(' \\\n  ');
  }

  // ---- Auto-rewrite of a named parameter (price-tampering test) ----
  const eqName = (a, b) => a.toLowerCase() === b.toLowerCase();

  /** Coerce the replacement to the same JSON type as the value being replaced.
   * A null field is treated like a number when the replacement looks numeric. */
  function coerce(cur, value) {
    const numeric = /^-?\d+(?:\.\d+)?$/.test(value);
    if ((typeof cur === 'number' || cur === null) && numeric) return Number(value);
    if (typeof cur === 'boolean' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
    return value;
  }

  /** Rewrite JSON primitives while preserving all unrelated source bytes. */
  function rewriteJsonText(text, param, value, changes) {
    let pos = 0;
    const replacements = [];
    const ws = () => { while (/[ \t\r\n]/.test(text[pos] || '')) pos++; };
    const stringToken = () => {
      const start = pos;
      if (text[pos] !== '"') throw new Error('Expected JSON string');
      for (pos++; pos < text.length; pos++) {
        if (text[pos] === '\\') { pos++; continue; }
        if (text[pos] === '"') {
          pos++;
          const raw = text.slice(start, pos);
          return { start, end: pos, value: JSON.parse(raw) };
        }
      }
      throw new Error('Unterminated JSON string');
    };
    const primitiveToken = () => {
      ws();
      if (text[pos] === '"') return stringToken();
      const start = pos;
      const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(pos));
      if (!m) throw new Error('Expected JSON value');
      pos += m[0].length;
      return { start, end: pos, value: JSON.parse(m[0]) };
    };
    const valueToken = (path) => {
      ws();
      if (text[pos] === '{') { objectToken(path); return; }
      if (text[pos] === '[') { arrayToken(path); return; }
      primitiveToken();
    };
    const objectToken = (path) => {
      pos++;
      ws();
      if (text[pos] === '}') { pos++; return; }
      while (pos < text.length) {
        ws();
        const key = stringToken().value;
        ws();
        if (text[pos++] !== ':') throw new Error('Expected colon');
        const childPath = path ? `${path}.${key}` : key;
        ws();
        if (eqName(key, param) && text[pos] !== '{' && text[pos] !== '[') {
          const token = primitiveToken();
          const numeric = (typeof token.value === 'number' || token.value === null) && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
          const to = numeric ? value : coerce(token.value, value);
          const replacement = numeric ? value : JSON.stringify(to);
          if (text.slice(token.start, token.end) !== replacement) {
            replacements.push({ start: token.start, end: token.end, text: replacement });
            changes.push({ where: 'json', key: childPath, from: token.value, to: numeric && Number.isSafeInteger(Number(value)) ? Number(value) : to });
          }
        } else {
          valueToken(childPath);
        }
        ws();
        if (text[pos] === '}') { pos++; return; }
        if (text[pos++] !== ',') throw new Error('Expected comma');
      }
      throw new Error('Unterminated JSON object');
    };
    const arrayToken = (path) => {
      pos++;
      ws();
      if (text[pos] === ']') { pos++; return; }
      let index = 0;
      while (pos < text.length) {
        valueToken(`${path}[${index++}]`);
        ws();
        if (text[pos] === ']') { pos++; return; }
        if (text[pos++] !== ',') throw new Error('Expected comma');
      }
      throw new Error('Unterminated JSON array');
    };
    ws();
    valueToken('');
    ws();
    if (pos !== text.length) throw new Error('Unexpected JSON data');
    let out = text;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i];
      out = out.slice(0, r.start) + r.text + out.slice(r.end);
    }
    return out;
  }

  function rewriteUrlEncoded(body, param, value, changes, where) {
    // Preserve order and untouched pairs; only rewrite matching keys.
    return body.split('&').map((pair) => {
      if (!pair) return pair;
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key;
      try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch { key = rawKey; }
      if (!eqName(key, param)) return pair;
      const from = eq === -1 ? '' : decodeSafe(pair.slice(eq + 1));
      if (from === value) return pair;
      changes.push({ where, key, from, to: value });
      return `${rawKey}=${encodeURIComponent(value)}`;
    }).join('&');
  }
  const decodeSafe = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Rewrite a matching field's value inside a multipart/form-data body. */
  function rewriteMultipart(body, param, value, changes) {
    const first = /^--([^\r\n]+)\r?\n/.exec(body);
    if (!first) return body;
    const delimiter = `--${first[1]}`;
    const marker = new RegExp('(?:^|\\r?\\n)' + reEscape(delimiter) + '(?=\\r?\\n|--(?:\\r?\\n|$))', 'g');
    const offsets = [...body.matchAll(marker)].map((m) => m.index + m[0].length - delimiter.length);
    if (offsets.length < 2) return body;
    const parts = [body.slice(0, offsets[0])];
    for (let i = 0; i < offsets.length; i++) {
      parts.push(body.slice(offsets[i] + delimiter.length, offsets[i + 1] ?? body.length));
    }
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (/^--/.test(part)) continue;
      const lead = part.startsWith('\r\n') ? 2 : part.startsWith('\n') ? 1 : 0;
      const crlf = part.indexOf('\r\n\r\n', lead);
      const lf = part.indexOf('\n\n', lead);
      const sep = crlf >= 0 ? crlf : lf;
      const sepLen = crlf >= 0 ? 4 : 2;
      if (sep < 0) continue;
      const head = part.slice(lead, sep);
      const disposition = head.split(/\r?\n/).find((line) => /^content-disposition\s*:/i.test(line));
      if (!disposition || /;\s*filename\*?\s*=/i.test(disposition)) continue;
      const attrs = disposition.replace(/^content-disposition\s*:/i, '');
      const match = /(?:^|;)\s*name\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(attrs);
      const field = match && (match[1] ?? match[2]);
      if (!field || !eqName(field, param)) continue;
      const start = sep + sepLen;
      const tail = part.endsWith('\r\n') ? 2 : part.endsWith('\n') ? 1 : 0;
      const end = part.length - tail;
      const from = part.slice(start, end);
      if (from === value) continue;
      changes.push({ where: 'multipart', key: field, from, to: value });
      parts[i] = part.slice(0, start) + value + part.slice(end);
    }
    return parts.join(delimiter);
  }

  /**
   * Rewrite every occurrence of `param` to `value` across the request's query
   * string and body (JSON, form-urlencoded, or multipart). Returns the possibly
   * new url/body plus a list of the changes made (empty if nothing matched).
   */
  function applyParamRule(req, param, value) {
    const changes = [];
    let url = req.url;
    let body = req.body || '';
    param = String(param);
    value = String(value);
    if (!param) return { url, body, changes };

    const hashAt = url.indexOf('#');
    const searchEnd = hashAt < 0 ? url.length : hashAt;
    const queryAt = url.indexOf('?');
    if (queryAt >= 0 && queryAt < searchEnd) {
      const query = url.slice(queryAt + 1, searchEnd);
      const rewritten = rewriteUrlEncoded(query, param, value, changes, 'query');
      if (rewritten !== query) url = url.slice(0, queryAt + 1) + rewritten + url.slice(searchEnd);
    }

    const ct = (getHeader(headersToList(req.headers), 'content-type') || '').toLowerCase();
    const trimmed = body.trim();
    const looksJson = /^[[{]/.test(trimmed);
    // json covers application/json, text/json and the +json family (hal, ld, vnd.api…)
    const isJson = /[/+]json\b/.test(ct);
    const isForm = /application\/x-www-form-urlencoded/.test(ct);
    const isMultipart = /multipart\/form-data/.test(ct);
    if (body) {
      if (isJson || (!ct && looksJson)) {
        rewriteJsonBody();
      } else if (isForm || (!ct && /^[^=&\s]+=/.test(trimmed))) {
        body = rewriteUrlEncoded(body, param, value, changes, 'form');
      } else if (isMultipart) {
        try { body = rewriteMultipart(body, param, value, changes); } catch { /* leave body */ }
      } else if (looksJson) {
        // Unrecognized content-type but the body is shaped like JSON — try anyway.
        rewriteJsonBody();
      }
    }
    function rewriteJsonBody() {
      try {
        const jc = [];
        const rewritten = rewriteJsonText(body, param, value, jc);
        if (jc.length) { changes.push(...jc); body = rewritten; }
      } catch { /* not valid JSON, leave it */ }
    }
    return { url, body, changes };
  }

  // Common names for a payment amount, forced by Auto mode's default rule.
  const DEFAULT_PARAMS =
    'amount, payableAmount, payingAmount, amountToPay, paymentAmount, totalAmount, ' +
    'grandTotal, orderTotal, subtotal, price, unitPrice, amountDue, netAmount, ' +
    'finalAmount, chargeAmount, billAmount, totalPrice, payment';

  /** Split a rule's parameter field into individual names (comma / whitespace separated). */
  function splitNames(s) {
    return String(s || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  }

  /** One URL pattern per line. Lines may be plain text, shell-style globs, or /regex/flags. */
  function splitPatterns(input) {
    return String(input || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
  }

  function compileUrlPattern(pattern) {
    const regex = /^\/(.*)\/([a-z]*)$/i.exec(pattern);
    if (regex) {
      try {
        if (/[^imsu]/.test(regex[2])) throw new Error('Supported regex flags are i, m, s, and u.');
        const compiled = new RegExp(regex[1], regex[2]);
        return { valid: true, test: (url) => compiled.test(url) };
      }
      catch (error) { return { valid: false, error: error.message, test: () => false }; }
    }
    if (/[?*]/.test(pattern)) {
      try {
        const source = reEscape(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
        const re = new RegExp('^' + source + '$', 'i');
        return { valid: true, test: (url) => {
          try {
            const target = /^[a-z]+:\/\//i.test(pattern) ? url : url.replace(/^https?:\/\//i, '');
            return re.test(target);
          } catch { return false; }
        } };
      } catch (error) { return { valid: false, error: error.message, test: () => false }; }
    }
    const needle = pattern.toLowerCase();
    return { valid: true, test: (url) => url.toLowerCase().includes(needle) };
  }

  /** Exclusions win. A blank include list means every HTTP(S) request. */
  function urlInScope(url, include, exclude) {
    if (!/^https?:/i.test(String(url || ''))) return { allowed: false, errors: [] };
    const errors = [];
    const build = (text, label) => splitPatterns(text).map((pattern) => {
      const compiled = compileUrlPattern(pattern);
      if (!compiled.valid) errors.push(`${label} “${pattern}”: ${compiled.error}`);
      return compiled;
    }).filter((item) => item.valid);
    const includes = build(include, 'Include');
    const excludes = build(exclude, 'Exclude');
    const included = !splitPatterns(include).length || includes.some((item) => item.test(url));
    const excluded = excludes.some((item) => item.test(url));
    return { allowed: errors.length === 0 && included && !excluded, errors };
  }

  /** Extract a text body from a CDP request object (Fetch/Network). */
  function requestBodyText(req) {
    if (req.postDataEntries && req.postDataEntries.length) {
      try {
        const complete = req.postDataEntries.every((e) => typeof e.bytes === 'string');
        const bytes = concatBytes(req.postDataEntries.map((e) => (e.bytes ? b64ToBytes(e.bytes) : new Uint8Array())));
        const d = decodeBody(bytes);
        return { text: complete && !d.binary ? d.text : '', known: complete && !d.binary, binary: d.binary, size: d.size };
      } catch { return { text: '', known: false, binary: false }; }
    }
    if (typeof req.postData === 'string') return { text: req.postData, known: true, binary: false };
    return { text: '', known: !req.hasPostData, binary: false };
  }

  /** Display placeholders describe unavailable bytes and must never become a payload. */
  function isUnavailableRequestBody(body) {
    return /^\[binary request body\b/.test(String(body || '')) ||
      /^\[request body unavailable\b/.test(String(body || '')) ||
      /\n?\[… request body truncated;/.test(String(body || ''));
  }

  const STATIC_TYPES = new Set(['Image', 'Font', 'Stylesheet', 'Media']);
  const STATIC_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|css|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|map)$/i;
  /** True for requests that are almost certainly static assets (skipped by default). */
  function isStatic(type, url) {
    if (STATIC_TYPES.has(type)) return true;
    try { return STATIC_EXT.test(new URL(url).pathname); } catch { return false; }
  }

  /**
   * Apply several rules in sequence, threading the rewritten url/body through
   * each. A rule's `param` may list several names sharing one `value`, so many
   * parameters can be forced in a single pass.
   */
  function applyParamRules(req, rules) {
    let url = req.url;
    let body = req.body || '';
    const changes = [];
    const seen = new Set();
    for (const rule of rules || []) {
      for (const name of splitNames(rule && rule.param)) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue; // don't apply the same name twice
        seen.add(key);
        const r = applyParamRule({ method: req.method, url, headers: req.headers, body }, name, rule.value);
        url = r.url;
        body = r.body;
        changes.push(...r.changes);
      }
    }
    return { url, body, changes };
  }

  const api = {
    REASONS, norm, headersToList, getHeader, serializeRequest, parseRequest,
    serializeResponse, parseResponse, statusText, bytesToB64, b64ToBytes, utf8ToB64,
    concatBytes, decodeBody, formatJson, prettyBody, toCurl, applyParamRule, applyParamRules,
    splitNames, splitPatterns, compileUrlPattern, urlInScope, DEFAULT_PARAMS, isStatic, requestBodyText, isUnavailableRequestBody,
  };
  global.HTTP = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
