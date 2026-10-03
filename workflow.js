'use strict';
/* Local request workflows; no browser APIs or network access. */
(function (global) {
  const HTTP = global.HTTP || (typeof require !== 'undefined' ? require('./http.js') : null);

  function variablesFromText(text) {
    const values = Object.create(null);
    for (const [i, line] of String(text || '').split(/\r?\n/).entries()) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const split = line.indexOf('=');
      const key = line.slice(0, split).trim();
      if (split < 1 || !/^[A-Za-z_][\w.-]*$/.test(key)) throw new Error(`Variable line ${i + 1}: use name=value.`);
      values[key] = line.slice(split + 1);
    }
    return values;
  }

  function interpolate(text, values) {
    const missing = new Set();
    const result = String(text || '').replace(/\{\{\s*(url:)?([\w.-]+)\s*\}\}/g, (whole, encoding, key) => {
      if (!Object.hasOwn(values, key)) { missing.add(key); return whole; }
      return encoding ? encodeURIComponent(String(values[key])) : String(values[key]);
    });
    if (missing.size) throw new Error(`Missing variables: ${[...missing].join(', ')}.`);
    return result;
  }

  /** Encode literal form text while keeping environment values encoded at send time. */
  function encodeFormTemplate(text) {
    let result = '', offset = 0;
    for (const match of String(text ?? '').matchAll(/\{\{\s*(?:url:)?([\w.-]+)\s*\}\}/g)) {
      result += encodeURIComponent(String(text ?? '').slice(offset, match.index)) + `{{url:${match[1]}}}`;
      offset = match.index + match[0].length;
    }
    return result + encodeURIComponent(String(text ?? '').slice(offset));
  }

  function prepareRequest(raw, target, variableText = '', extra = {}) {
    const values = Object.assign(variablesFromText(variableText), extra);
    const expandedRaw = interpolate(raw, values);
    const expandedTarget = interpolate(target, values);
    const parsed = HTTP.parseRequest(expandedRaw, expandedTarget);
    if (!/^https?:$/.test(new URL(parsed.url).protocol)) throw new Error('Requests must use HTTP or HTTPS.');
    if (HTTP.isUnavailableRequestBody(parsed.body)) throw new Error('This request body was not captured completely. Replace it with the original payload before sending.');
    return { raw: expandedRaw, target: new URL(parsed.url).origin, parsed };
  }

  function payloadsFromText(text) {
    const payloads = String(text || '').replace(/\r\n/g, '\n').split('\n');
    if (payloads.at(-1) === '') payloads.pop();
    if (!payloads.length || (payloads.length === 1 && !payloads[0])) throw new Error('Add at least one payload.');
    if (payloads.length > 50) throw new Error('A run is limited to 50 payloads.');
    if (payloads.some((value) => value.length > 10_000)) throw new Error('Each payload must be 10,000 characters or fewer.');
    return payloads;
  }

  /** Tokenize a supported cURL command as data; never execute shell text. */
  function shellTokens(input) {
    const tokens = [];
    let word = '';
    let quote = '';
    let started = false;
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (quote) {
        if (c === quote) { quote = ''; continue; }
        if (c === '\\' && quote === '"') {
          const next = input[i + 1];
          if (['"', '\\', '$', '`', '\n'].includes(next)) { i++; if (next !== '\n') word += next; continue; }
        }
        word += c;
      } else if (c === '"' || c === "'") { quote = c; started = true; }
      else if (c === '\\') {
        if (++i >= input.length) throw new Error('Unfinished escape in cURL command.');
        if (input[i] !== '\n') { word += input[i]; started = true; }
      } else if (/\s/.test(c)) {
        if (started) { tokens.push(word); word = ''; started = false; }
      } else {
        if (';|&<>`'.includes(c) || c === '$') throw new Error('Shell operators and expansions are not supported. Paste a single literal cURL command.');
        word += c; started = true;
      }
    }
    if (quote) throw new Error('Unclosed quote in cURL command.');
    if (started) tokens.push(word);
    return tokens;
  }

  function importCurl(input) {
    if (String(input || '').length > 1_000_000) throw new Error('cURL import is limited to 1 million characters.');
    const tokens = shellTokens(String(input || '').trim());
    if (!/^(?:curl|curl\.exe)$/.test(tokens.shift() || '')) throw new Error('Paste a command starting with curl.');
    let method = '';
    let url = '';
    let follow = false;
    const headers = [];
    const body = [];
    const argument = (flag) => {
      if (!tokens.length) throw new Error(`Missing value after ${flag}.`);
      return tokens.shift();
    };
    while (tokens.length) {
      const flag = tokens.shift();
      if (['-X', '--request'].includes(flag)) method = argument(flag).toUpperCase();
      else if (['-H', '--header'].includes(flag)) {
        const value = argument(flag);
        const split = value.indexOf(':');
        if (split < 1) throw new Error('cURL headers must use Name: value.');
        headers.push({ name: value.slice(0, split).trim(), value: value.slice(split + 1).trim() });
      } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json'].includes(flag)) {
        const value = argument(flag);
        if (flag !== '--data-raw' && value.startsWith('@')) throw new Error('File uploads are not supported in cURL import. Paste the request body directly.');
        body.push(value);
        if (flag === '--json') {
          headers.push({ name: 'Content-Type', value: 'application/json' }, { name: 'Accept', value: 'application/json' });
        }
      } else if (['-b', '--cookie'].includes(flag)) {
        const value = argument(flag);
        if (!value.includes('=')) throw new Error('Cookie files are not supported. Use a literal Cookie header.');
        headers.push({ name: 'Cookie', value });
      } else if (['-A', '--user-agent', '-e', '--referer'].includes(flag)) {
        headers.push({ name: ['-A', '--user-agent'].includes(flag) ? 'User-Agent' : 'Referer', value: argument(flag) });
      } else if (['-u', '--user'].includes(flag)) {
        headers.push({ name: 'Authorization', value: 'Basic ' + HTTP.utf8ToB64(argument(flag)) });
      } else if (['-L', '--location'].includes(flag)) follow = true;
      else if (['-I', '--head'].includes(flag)) method = 'HEAD';
      else if (['--compressed', '-s', '--silent', '-S', '--show-error', '-v', '--verbose', '--globoff'].includes(flag)) { /* display options */ }
      else if (flag === '--url') url = argument(flag);
      else if (flag.startsWith('-')) throw new Error(`Unsupported cURL option: ${flag}. Import would be incomplete.`);
      else if (!url) url = flag;
      else throw new Error('Import one cURL request at a time.');
    }
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error('cURL URL must use HTTP or HTTPS.');
    if (target.username || target.password) throw new Error('Use --user for URL credentials.');
    const bodyText = body.join('&');
    if (body.length && !HTTP.getHeader(headers, 'content-type')) headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
    return { raw: HTTP.serializeRequest({ method: method || (body.length ? 'POST' : 'GET'), url: target.href, headers, body: bodyText }), target: target.origin, follow };
  }

  function siteMap(entries) {
    const groups = new Map();
    for (const entry of entries || []) {
      let url;
      try { url = new URL(entry.url); } catch { continue; }
      if (!/^https?:$/.test(url.protocol)) continue;
      const method = String(entry.method || 'GET');
      const key = `${url.origin}\n${method}\n${url.pathname}`;
      if (!groups.has(key)) groups.set(key, { key, origin: url.origin, method, path: url.pathname, count: 0, statuses: new Set(), params: new Set(), totalMs: 0, timed: 0, errors: 0, entryId: entry.id });
      const group = groups.get(key);
      group.count++;
      group.entryId = entry.id;
      if (entry.status != null) group.statuses.add(entry.status);
      for (const key of url.searchParams.keys()) group.params.add(key);
      if (entry.error || Number(entry.status) >= 400) group.errors++;
      if (Number.isFinite(entry.duration)) { group.totalMs += entry.duration; group.timed++; }
    }
    return [...groups.values()].map((group) => ({ ...group, statuses: [...group.statuses].sort(), params: [...group.params].sort(), averageMs: group.timed ? group.totalMs / group.timed : null }))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }

  function inspectRequest(raw, target, response = '') {
    if (raw.length + response.length > 2_000_000) throw new Error('Inspector inputs are limited to 2 million characters.');
    const req = HTTP.parseRequest(raw, target);
    const url = new URL(req.url);
    const fields = [];
    for (const [name, value] of url.searchParams) fields.push({ location: 'Query', name, value });
    const headers = HTTP.headersToList(req.headers);
    for (const header of headers) fields.push({ location: 'Header', name: header.name, value: header.value });
    for (const header of headers.filter((h) => h.name.toLowerCase() === 'cookie')) {
      for (const cookie of header.value.split(';')) {
        const split = cookie.indexOf('=');
        if (split >= 0) fields.push({ location: 'Cookie', name: cookie.slice(0, split).trim(), value: cookie.slice(split + 1).trim() });
      }
    }
    const type = HTTP.getHeader(headers, 'content-type') || '';
    const notes = [];
    if (/application\/x-www-form-urlencoded/i.test(type)) {
      for (const [name, value] of new URLSearchParams(req.body)) fields.push({ location: 'Form', name, value });
    } else if (/[/+]json\b/i.test(type) || /^[\[{]/.test(req.body.trim())) {
      try {
        let marker = '__interceptor_number__';
        while (req.body.includes(marker)) marker += '_';
        const walk = (value, path, depth = 0) => {
          if (fields.length > 500 || depth > 30) return;
          if (value && typeof value === 'object') {
            for (const [key, child] of Object.entries(value)) walk(child, Array.isArray(value) ? `${path}[${key}]` : path ? `${path}.${key}` : key, depth + 1);
          } else fields.push({ location: 'JSON', name: path || '(root)', value: typeof value === 'string' && value.startsWith(marker) ? value.slice(marker.length) : JSON.stringify(value) });
        };
        // Represent numeric tokens as their exact source text, avoiding rounded IDs.
        const numericStrings = req.body.replace(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (whole, number) => number ? JSON.stringify(marker + number) : whole);
        JSON.parse(req.body);
        walk(JSON.parse(numericStrings), '');
      } catch { notes.push('Request body is not valid JSON.'); }
    }
    if (/multipart\/form-data/i.test(type)) notes.push('Multipart payload is shown in the raw request; file bytes are not decoded here.');
    const responseHeaders = [];
    const cookies = [];
    if (response) {
      try {
        const res = HTTP.parseResponse(response);
        for (const header of res.headers) {
          responseHeaders.push(header);
          if (header.name.toLowerCase() !== 'set-cookie') continue;
          const parts = header.value.split(';').map((value) => value.trim());
          const first = parts.shift();
          const split = first.indexOf('=');
          const attrs = new Map(parts.map((part) => { const i = part.indexOf('='); return [part.slice(0, i < 0 ? undefined : i).toLowerCase(), i < 0 ? true : part.slice(i + 1)]; }));
          cookies.push({ name: split < 0 ? first : first.slice(0, split), value: split < 0 ? '' : first.slice(split + 1), secure: attrs.has('secure'), httpOnly: attrs.has('httponly'), sameSite: attrs.get('samesite') || 'not specified', path: attrs.get('path') || '', domain: attrs.get('domain') || '' });
        }
        if (url.protocol === 'https:' && !HTTP.getHeader(res.headers, 'strict-transport-security')) notes.push('HSTS is not present in this captured response.');
        if (!HTTP.getHeader(res.headers, 'x-content-type-options')) notes.push('X-Content-Type-Options is not present in this captured response.');
        if ((HTTP.getHeader(res.headers, 'content-type') || '').includes('text/html') && !HTTP.getHeader(res.headers, 'content-security-policy')) notes.push('Content-Security-Policy is not present in this HTML response.');
      } catch { notes.push('Response could not be parsed.'); }
    }
    if (fields.length > 500) notes.push('Field preview limited to 500 rows.');
    return { method: req.method, url: req.url, fields: fields.slice(0, 500), responseHeaders, cookies, notes };
  }

  function importCollection(input) {
    if (!input || input.format !== 'interceptor-collection' || input.version !== 1 || !Array.isArray(input.requests)) throw new Error('This file is not an Interceptor collection.');
    if (input.requests.length > 100) throw new Error('A collection can contain up to 100 requests.');
    if (input.requests.reduce((n, item) => n + String(item?.raw || '').length, 0) > 5_000_000) throw new Error('Collection request text is limited to 5 million characters.');
    return input.requests.map((item, i) => {
      if (!item || typeof item.raw !== 'string' || typeof item.target !== 'string' || item.raw.length > 500_000 || item.target.length > 10_000) throw new Error(`Invalid collection request ${i + 1}.`);
      if (item.assertions != null && (typeof item.assertions !== 'string' || item.assertions.length > 100_000)) throw new Error('Invalid saved assertions.');
      return { name: String(item.name || `Request ${i + 1}`).slice(0, 100), folder: String(item.folder || 'General').slice(0, 80), raw: item.raw, target: item.target, follow: !!item.follow, notes: String(item.notes || '').slice(0, 2000), assertions: item.assertions || '[]' };
    });
  }

  function csvRows(rows) {
    const cell = (value) => {
      let text = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    return rows.map((row) => row.map(cell).join(',')).join('\r\n');
  }

  const api = { variablesFromText, interpolate, encodeFormTemplate, prepareRequest, payloadsFromText, importCurl, siteMap, inspectRequest, importCollection, csvRows };
  global.Workflow = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
