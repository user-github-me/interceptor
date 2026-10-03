'use strict';
/* Dependency-free analysis helpers used by the dashboard and Node tests. */
(function (global) {
  const HTTP = global.HTTP || (typeof require !== 'undefined' ? require('./http.js') : null);

  function textBodyFromHar(content) {
    if (!content || typeof content.text !== 'string') return '';
    if (content.encoding !== 'base64') return content.text;
    try {
      const decoded = HTTP.decodeBody(HTTP.b64ToBytes(content.text));
      return decoded.binary ? `[binary ${content.mimeType || 'data'}, ${decoded.size} bytes — not shown]` : decoded.text;
    } catch {
      return '[invalid base64 response body]';
    }
  }

  /** Convert a HAR 1.2 log into the dashboard's in-memory history shape. */
  function importHar(har, limit = 5000) {
    const entries = har && har.log && har.log.entries;
    if (!Array.isArray(entries)) throw new Error('This file is not a HAR log (log.entries is missing).');
    return entries.slice(-Math.max(1, limit)).map((item) => {
      const req = item.request || {};
      const res = item.response || {};
      const content = res.content || {};
      const started = Date.parse(item.startedDateTime || '');
      return {
        method: String(req.method || 'GET').toUpperCase(),
        url: String(req.url || ''),
        reqHeaders: HTTP.headersToList(req.headers),
        reqBody: req.postData && typeof req.postData.text === 'string' ? req.postData.text : '',
        type: String(item._resourceType || item._initiator?.type || 'Imported'),
        wallTime: Number.isFinite(started) ? started : Date.now(),
        ts: 0,
        status: Number.isFinite(Number(res.status)) ? Number(res.status) : 0,
        statusText: String(res.statusText || ''),
        resHeaders: HTTP.headersToList(res.headers),
        resBody: textBodyFromHar(content),
        httpVersion: String(res.httpVersion || req.httpVersion || 'HTTP/1.1'),
        size: Number.isFinite(Number(res.bodySize)) && Number(res.bodySize) >= 0
          ? Number(res.bodySize)
          : Number(content.size) >= 0 ? Number(content.size) : null,
        duration: Number.isFinite(Number(item.time)) ? Math.max(0, Number(item.time)) : null,
        state: 'done',
        error: item._error ? String(item._error) : null,
        mime: String(content.mimeType || ''),
        note: 'imported HAR',
        reqExtra: true,
        resExtra: true,
        edited: false,
        source: 'har',
      };
    }).filter((entry) => {
      try { return /^https?:$/.test(new URL(entry.url).protocol); } catch { return false; }
    });
  }

  function normalizeForCompare(text, prettyJson) {
    const raw = HTTP.norm(text || '');
    if (!prettyJson) return raw;
    const split = raw.indexOf('\n\n');
    if (split < 0) return HTTP.prettyBody(raw);
    return raw.slice(0, split + 2) + HTTP.prettyBody(raw.slice(split + 2));
  }

  /**
   * Produce aligned line pairs using an LCS diff. Inputs are capped so a pasted
   * multi-megabyte response cannot freeze the extension page.
   */
  function diffLines(left, right, maxLines = 700) {
    const maxChars = 200_000;
    const aText = HTTP.norm(left || '');
    const bText = HTTP.norm(right || '');
    const aAll = aText.slice(0, maxChars).split('\n');
    const bAll = bText.slice(0, maxChars).split('\n');
    const truncated = aText.length > maxChars || bText.length > maxChars || aAll.length > maxLines || bAll.length > maxLines;
    const a = aAll.slice(0, maxLines);
    const b = bAll.slice(0, maxLines);
    const width = b.length + 1;
    const matrix = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        matrix[i * width + j] = a[i] === b[j]
          ? matrix[(i + 1) * width + j + 1] + 1
          : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
      }
    }

    const raw = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        raw.push({ type: 'same', left: a[i++], right: b[j++] });
      } else if (j >= b.length || (i < a.length && matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) {
        raw.push({ type: 'remove', left: a[i++], right: '' });
      } else {
        raw.push({ type: 'add', left: '', right: b[j++] });
      }
    }

    // Pair delete/add runs so replacements line up side by side.
    const rows = [];
    for (let p = 0; p < raw.length;) {
      if (raw[p].type === 'same') { rows.push(raw[p++]); continue; }
      const removed = [];
      const added = [];
      while (p < raw.length && raw[p].type !== 'same') {
        if (raw[p].type === 'remove') removed.push(raw[p].left);
        else added.push(raw[p].right);
        p++;
      }
      const count = Math.max(removed.length, added.length);
      for (let k = 0; k < count; k++) {
        const hasLeft = k < removed.length;
        const hasRight = k < added.length;
        rows.push({
          type: hasLeft && hasRight ? 'change' : hasLeft ? 'remove' : 'add',
          left: hasLeft ? removed[k] : '',
          right: hasRight ? added[k] : '',
        });
      }
    }
    if (truncated) rows.push({ type: 'notice', left: `Preview limited to ${maxLines} lines / ${maxChars.toLocaleString()} characters per side`, right: 'Full input remains in the editors above.' });
    return { rows, truncated, leftLines: aAll.length, rightLines: bAll.length };
  }

  function htmlEncode(input) {
    return String(input).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function htmlDecode(input) {
    return String(input).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
      const lower = entity.toLowerCase();
      if (lower[0] === '#') {
        const n = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        try { return Number.isFinite(n) ? String.fromCodePoint(n) : whole; } catch { return whole; }
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] || whole;
    });
  }

  function base64Decode(input) {
    const compact = String(input).trim().replace(/-/g, '+').replace(/_/g, '/');
    const padded = compact + '='.repeat((4 - compact.length % 4) % 4);
    return new TextDecoder('utf-8', { fatal: true }).decode(HTTP.b64ToBytes(padded));
  }

  function inspectJwt(input) {
    const parts = String(input).trim().split('.');
    if (parts.length !== 3) throw new Error('A JWT must have three dot-separated parts.');
    let header;
    let payload;
    try {
      header = JSON.parse(base64Decode(parts[0]));
      payload = JSON.parse(base64Decode(parts[1]));
    } catch {
      throw new Error('The JWT header or payload is not valid base64url JSON.');
    }
    return JSON.stringify({ header, payload, signature: parts[2], verified: false }, null, 2);
  }

  function transform(action, input) {
    const text = String(input ?? '');
    switch (action) {
      case 'json-pretty': return HTTP.formatJson(text);
      case 'json-minify': return HTTP.formatJson(text, false);
      case 'url-encode': return encodeURIComponent(text);
      case 'url-decode': return decodeURIComponent(text.replace(/\+/g, ' '));
      case 'base64-encode': return HTTP.utf8ToB64(text);
      case 'base64-decode': return base64Decode(text);
      case 'html-encode': return htmlEncode(text);
      case 'html-decode': return htmlDecode(text);
      case 'jwt-inspect': return inspectJwt(text);
      case 'hex-encode': return [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      case 'hex-decode': {
        const hex = text.replace(/\s/g, '');
        if (!/^(?:[\da-f]{2})*$/i.test(hex)) throw new Error('Hex input must contain complete pairs of hexadecimal digits.');
        return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(hex.match(/../g) || [], (pair) => parseInt(pair, 16)));
      }
      default: throw new Error(`Unknown transform: ${action}`);
    }
  }

  async function hash(algorithm, text) {
    if (!['SHA-256', 'SHA-512'].includes(algorithm)) throw new Error('Unsupported hash algorithm.');
    const bytes = new TextEncoder().encode(String(text));
    const digest = await global.crypto.subtle.digest(algorithm, bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  const api = { importHar, normalizeForCompare, diffLines, htmlEncode, htmlDecode, base64Decode, inspectJwt, transform, hash };
  global.Workbench = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
