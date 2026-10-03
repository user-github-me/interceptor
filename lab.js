'use strict';
/* Passive review, declarative assertions, imports, and portable workspace data. */
(function (global) {
  const HTTP = global.HTTP || (typeof require !== 'undefined' ? require('./http.js') : null);
  const Workflow = global.Workflow || (typeof require !== 'undefined' ? require('./workflow.js') : null);

  const NUMBER_TOKEN = /"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  function canonicalNumber(token) {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
    let digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
    if (!digits) return '0';
    let exponent = Number(match[4] || 0) - (match[3] || '').length;
    const zeros = /0*$/.exec(digits)[0].length;
    digits = digits.slice(0, digits.length - zeros);
    exponent += zeros;
    return `${match[1]}${digits}e${exponent}`;
  }
  const unsafeNumber = (token) => !Number.isFinite(Number(token)) || (Number.isInteger(Number(token)) && !Number.isSafeInteger(Number(token))) || canonicalNumber(token) !== canonicalNumber(String(Number(token)));
  const numberSource = Symbol('exact JSON number');
  class ExactNumber { constructor(token) { this[numberSource] = token; } }
  function parseResponseJson(text) {
    // Retain out-of-range numeric tokens so rounded response IDs cannot pass a test.
    const decoded = JSON.parse(text);
    let marker = '__interceptor_exact_number__';
    while (JSON.stringify(decoded).includes(marker)) marker += '_';
    const source = text.replace(NUMBER_TOKEN, (whole, number) => number && unsafeNumber(number) ? JSON.stringify(marker + number) : whole);
    return JSON.parse(source, (key, value) => typeof value === 'string' && value.startsWith(marker) ? new ExactNumber(value.slice(marker.length)) : value);
  }

  function displayActual(value) {
    if (value == null) return '(missing)';
    if (value instanceof ExactNumber) return value[numberSource];
    if (typeof value !== 'object') return String(value);
    let marker = '__interceptor_exact_number__';
    try {
      while (JSON.stringify(value).includes(marker)) marker += '_';
      return JSON.stringify(value, (key, child) => child instanceof ExactNumber ? marker + child[numberSource] : child)
        .replace(/"__interceptor_exact_number__(_*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)"/g, (whole, suffix, number) => marker === '__interceptor_exact_number__' + suffix ? number : whole);
    } catch { return '[JSON value too deeply nested to preview]'; }
  }

  function parseAssertions(text) {
    if (!String(text || '').trim()) return [];
    const items = JSON.parse(text);
    if (!Array.isArray(items) || items.length > 50) throw new Error('Use a JSON array with up to 50 assertions.');
    for (const match of String(text).matchAll(NUMBER_TOKEN)) if (match[1] && unsafeNumber(match[1])) throw new Error('Assertion numbers must be finite, precise and within the safe integer range. Use bodyContains for exact numeric text outside that range.');
    for (const [i, item] of items.entries()) {
      if (!item || !['status', 'header', 'json', 'bodyContains', 'time', 'size'].includes(item.type)) throw new Error(`Assertion ${i + 1}: unknown type.`);
      if (item.type === 'header' && (typeof item.name !== 'string' || !item.name)) throw new Error(`Assertion ${i + 1}: header name is required.`);
      if (item.type === 'header' && !/^[!#$%&'*+.^_`|~\w-]+$/.test(item.name)) throw new Error(`Assertion ${i + 1}: invalid header name.`);
      if (item.type === 'json' && (typeof item.path !== 'string' || (item.path && !item.path.startsWith('/')))) throw new Error(`Assertion ${i + 1}: JSON paths use /data/id (JSON Pointer).`);
      if (item.type === 'bodyContains' && typeof item.value !== 'string') throw new Error(`Assertion ${i + 1}: value must be text.`);
      if (['time', 'size'].includes(item.type) && (!Number.isFinite(item.max) || item.max < 0)) throw new Error(`Assertion ${i + 1}: max must be a positive number.`);
      if (item.type === 'status' && (!Number.isInteger(item.equals) || item.equals < 100 || item.equals > 599)) throw new Error(`Assertion ${i + 1}: equals must be an HTTP status.`);
      if (item.type === 'json' && /~(?:[^01]|$)/.test(item.path)) throw new Error(`Assertion ${i + 1}: JSON Pointer escapes use ~0 and ~1.`);
      if (Object.hasOwn(item, 'absent') && typeof item.absent !== 'boolean') throw new Error(`Assertion ${i + 1}: absent must be true or false.`);
      if (item.absent && (Object.hasOwn(item, 'equals') || Object.hasOwn(item, 'contains'))) throw new Error(`Assertion ${i + 1}: absent cannot be combined with equals or contains.`);
      if (item.type === 'header' && Object.hasOwn(item, 'equals') && Object.hasOwn(item, 'contains')) throw new Error(`Assertion ${i + 1}: choose equals or contains.`);
    }
    return items;
  }

  function jsonPointer(value, path) {
    let current = value;
    if (!path) return { exists: true, value: current };
    for (const key of path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (current == null || typeof current !== 'object' || current instanceof ExactNumber || (Array.isArray(current) && !/^(?:0|[1-9]\d*)$/.test(key)) || !Object.hasOwn(current, key)) return { exists: false };
      current = current[key];
    }
    return { exists: true, value: current };
  }

  function runAssertions(assertions, responseRaw, metrics = {}) {
    const equivalent = (a, b, depth = 0) => {
      if (depth > 100) return false;
      if (a instanceof ExactNumber || b instanceof ExactNumber) return false;
      if (a === b) return true;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
      const keys = Object.keys(a);
      return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equivalent(a[key], b[key], depth + 1));
    };
    let response;
    try { response = HTTP.parseResponse(responseRaw); } catch { response = { status: 0, headers: [], body: '' }; }
    let json;
    let jsonValid = false;
    try { json = parseResponseJson(response.body); jsonValid = true; } catch { /* not JSON */ }
    return assertions.map((item, i) => {
      let pass = false;
      let actual;
      let label = item.name && item.type !== 'header' ? item.name : item.type;
      if (item.type === 'status') { actual = metrics.status || response.status; pass = actual === item.equals; label = `Status equals ${item.equals}`; }
      else if (item.type === 'header') {
        const values = response.headers.filter((header) => header.name.toLowerCase() === item.name.toLowerCase()).map((header) => header.value);
        actual = values.length ? values.join('\n') : null;
        pass = item.absent ? !values.length : Object.hasOwn(item, 'equals') ? values.some((value) => value === String(item.equals)) : Object.hasOwn(item, 'contains') ? values.some((value) => value.includes(String(item.contains))) : !!values.length;
        label = `Header ${item.name}`;
      } else if (item.type === 'json') {
        const found = jsonValid ? jsonPointer(json, item.path) : { exists: false };
        actual = found.value;
        pass = item.absent ? jsonValid && !found.exists : found.exists && (!Object.hasOwn(item, 'equals') || equivalent(actual, item.equals));
        label = `JSON ${item.path || '(root)'}`;
      } else if (item.type === 'bodyContains') { actual = response.body.includes(item.value); pass = actual; label = `Body contains ${item.value.slice(0, 60)}`; }
      else { actual = item.type === 'time' ? metrics.duration : metrics.bytes; pass = Number.isFinite(actual) && actual <= item.max; label = `${item.type === 'time' ? 'Time (ms)' : 'Size (bytes)'} ≤ ${item.max}`; }
      const incomplete = !!metrics.truncated && (item.type === 'size' || (item.type === 'bodyContains' && !pass) || item.type === 'json');
      if (incomplete) pass = false;
      if (metrics.error) pass = false;
      return { id: i + 1, label, pass, actual: displayActual(actual).slice(0, 4000), detail: metrics.error || (incomplete ? 'Cannot verify from a truncated response preview' : pass ? 'Passed' : 'Expectation not met') };
    });
  }

  function passiveReview(entries) {
    const findings = [];
    const seen = new Set();
    const add = (entry, code, severity, title, evidence, advice) => {
      let url;
      try { url = new URL(entry.url); } catch { return; }
      const key = `${code}|${url.origin}|${url.pathname}|${evidence}`;
      if (seen.has(key) || findings.length >= 1000) return;
      seen.add(key);
      url.username = ''; url.password = '';
      for (const name of [...url.searchParams.keys()]) if (/^(access_token|token|api[_-]?key|password|secret|authorization)$/i.test(name)) url.searchParams.set(name, '[redacted]');
      findings.push({ id: findings.length + 1, entryId: entry.id, code, severity, title, url: url.href, evidence: String(evidence).slice(0, 500), advice, status: 'open' });
    };
    for (const entry of entries || []) {
      let url;
      try { url = new URL(entry.url); } catch { continue; }
      if (!/^https?:$/.test(url.protocol)) continue;
      const headers = HTTP.headersToList(entry.resHeaders);
      const get = (name) => HTTP.getHeader(headers, name) || '';
      const local = /^(localhost|127\.|\[::1\])/.test(url.hostname);
      if (url.protocol === 'http:' && !local) add(entry, 'http', 'review', 'Unencrypted HTTP traffic', url.origin, 'Use HTTPS for deployed apps, especially traffic containing sessions or personal data.');
      if (entry.status == null || entry.error) continue;
      if (url.protocol === 'https:' && !get('strict-transport-security')) add(entry, 'hsts', 'info', 'HSTS not observed', 'No Strict-Transport-Security header', 'Check whether HSTS is appropriate for this deployed origin. Local/staging apps may intentionally omit it.');
      if (get('access-control-allow-origin') === '*' && get('access-control-allow-credentials').toLowerCase() === 'true') add(entry, 'cors-wildcard', 'review', 'Conflicting CORS credentials policy', 'Allow-Origin: *; Allow-Credentials: true', 'Browsers reject wildcard credentialed access. Review the intended origins and test from an untrusted browser origin.');
      const requestOrigin = HTTP.getHeader(HTTP.headersToList(entry.reqHeaders), 'origin');
      if (requestOrigin && get('access-control-allow-origin') === requestOrigin && get('access-control-allow-credentials').toLowerCase() === 'true') add(entry, 'cors-reflection', 'review', 'Credentialed CORS allows the captured origin', `Allowed origin: ${requestOrigin}`, 'This can be intentional. Verify the origin is allowlisted; this observation alone does not prove arbitrary origin reflection.');
      const html = /text\/html/i.test(get('content-type') || entry.mime || '');
      const csp = get('content-security-policy');
      if (html && !csp) add(entry, 'csp', 'info', 'HTML without an enforced CSP', 'No Content-Security-Policy header', 'Consider a policy suited to the app. A missing policy is defense-in-depth context, not proof of XSS.');
      if (html && !get('x-frame-options') && !/frame-ancestors\s/i.test(csp)) add(entry, 'frames', 'review', 'No framing restriction observed', 'No X-Frame-Options or CSP frame-ancestors', 'If this page performs sensitive actions, verify whether it should be embeddable and test clickjacking impact.');
      if (html && /(?:^|;)\s*script-src[^;]*'unsafe-eval'/i.test(csp)) add(entry, 'csp-eval', 'info', 'CSP permits unsafe-eval', 'script-src includes unsafe-eval', 'Review whether production scripts need eval-like execution.');
      if (get('x-content-type-options').toLowerCase() !== 'nosniff') add(entry, 'nosniff', 'info', 'MIME sniffing protection not observed', 'X-Content-Type-Options is absent or not nosniff', 'Consider adding nosniff alongside accurate Content-Type headers.');
      const sensitiveRequest = HTTP.headersToList(entry.reqHeaders).some((h) => /^(authorization|cookie)$/i.test(h.name));
      if (sensitiveRequest && /\bpublic\b/i.test(get('cache-control'))) add(entry, 'cache', 'review', 'Authenticated response marked public', `Cache-Control: ${get('cache-control')}`, 'Verify this response contains no user-specific data and that shared caches cannot serve it to another user.');
      for (const header of headers.filter((h) => h.name.toLowerCase() === 'set-cookie')) {
        const cookieName = header.value.split('=')[0];
        const attrs = header.value.split(';').slice(1).map((part) => part.trim().toLowerCase());
        const has = (name) => attrs.some((value) => value === name || value.startsWith(name + '='));
        if (url.protocol === 'https:' && !has('secure')) add(entry, 'cookie-secure', 'review', 'Cookie without Secure', cookieName, 'Use Secure for cookies that should only be sent over HTTPS.');
        if (!has('httponly')) add(entry, 'cookie-http', 'info', 'Cookie readable by JavaScript', cookieName, 'Session cookies usually benefit from HttpOnly. Some client-readable cookies intentionally omit it.');
        if (!has('samesite')) add(entry, 'cookie-same', 'info', 'Cookie without explicit SameSite', cookieName, 'Choose a SameSite policy that fits the cross-site flow; modern browser defaults vary with context.');
        if (attrs.includes('samesite=none') && !has('secure')) add(entry, 'cookie-none', 'review', 'SameSite=None cookie without Secure', cookieName, 'Modern browsers reject this combination; set Secure when cross-site cookies are necessary.');
      }
      for (const key of url.searchParams.keys()) {
        if (/^(access_token|token|api[_-]?key|password|secret|authorization)$/i.test(key)) add(entry, 'url-secret', 'review', 'Credential-like value in URL', `Query field: ${key} (value hidden)`, 'Move credentials out of URLs where feasible; URLs can appear in history, logs, and referrers.');
      }
      const body = String(entry.resBody || '').slice(0, 200_000);
      if (/(?:Traceback \(most recent call last\)|SQLSTATE\[|You have an error in your SQL syntax|at [\w.$]+\([^\n]+:\d+:\d+\))/i.test(body)) add(entry, 'debug-error', 'review', 'Detailed exception or database error', 'Recognizable debug/error signature in response body (values hidden)', 'Verify production returns a generic error and keeps diagnostic detail in server logs.');
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(body)) add(entry, 'private-key', 'review', 'Private-key marker in response', 'Private-key PEM marker (key content hidden)', 'Check whether a private key is exposed. Remove exposed material and rotate affected keys.');
      if (get('server') || get('x-powered-by')) add(entry, 'technology', 'info', 'Server technology disclosure', [get('server'), get('x-powered-by')].filter(Boolean).join(' · '), 'Review unnecessary version details; this does not establish an exploitable issue.');
    }
    return findings;
  }

  function withoutCredentials(raw, target) {
    const parsed = HTTP.parseRequest(raw, target);
    parsed.headers = parsed.headers.filter((header) => !/^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i.test(header.name));
    return { raw: HTTP.serializeRequest(parsed), target: new URL(parsed.url).origin, parsed };
  }

  function importPostman(input) {
    if (!input?.info || !Array.isArray(input.item)) throw new Error('Not a Postman collection.');
    const requests = [];
    const warnings = [];
    if (input.variable != null && !Array.isArray(input.variable)) throw new Error('Invalid Postman collection variables.');
    const variables = (input.variable || []).filter((item) => item && !item.disabled && /^[A-Za-z_][\w.-]*$/.test(item.key)).map((item) => {
      const value = String(item.value ?? '');
      if (/[\r\n]/.test(value)) throw new Error(`Postman variable ${item.key} contains line breaks; configure it in the request body instead.`);
      return `${item.key}=${value}`;
    }).join('\n');
    if (variables.length > 100_000) throw new Error('Postman variables are limited to 100,000 characters.');
    const walk = (items, folder = '', inheritedAuth = input.auth, depth = 0) => {
      if (depth > 20) throw new Error('Postman folders are nested too deeply.');
      if (!Array.isArray(items)) throw new Error('Invalid Postman folder.');
      for (const item of items) {
        if (!item || typeof item !== 'object') throw new Error('Invalid Postman item.');
        if (item.item) { walk(item.item, [folder, item.name].filter(Boolean).join(' / '), item.auth || inheritedAuth, depth + 1); continue; }
        const req = item.request;
        if (!req || typeof req !== 'object') { warnings.push(`${item.name}: skipped unsupported request.`); continue; }
        const url = typeof req.url === 'string' ? req.url : req.url?.raw;
        if (typeof url !== 'string' || !url) { warnings.push(`${item.name}: URL missing.`); continue; }
        if (req.header != null && !Array.isArray(req.header)) throw new Error(`${item.name}: invalid request headers.`);
        const headers = (req.header || []).filter((header) => header && !header.disabled).map((header) => {
          if (typeof header.key !== 'string' || !/^[!#$%&'*+.^_`|~\w-]+$/.test(header.key) || /[\r\n]/.test(String(header.value ?? ''))) throw new Error(`${item.name}: invalid request header.`);
          return { name: header.key, value: String(header.value ?? '') };
        });
        const auth = req.auth || inheritedAuth;
        if (auth?.type === 'bearer') {
          if (!Array.isArray(auth.bearer)) throw new Error(`${item.name}: invalid bearer authentication.`);
          const token = String(auth.bearer.find((value) => value?.key === 'token')?.value ?? '');
          if (/[\r\n]/.test(token)) throw new Error(`${item.name}: bearer token cannot contain line breaks.`);
          for (let i = headers.length - 1; i >= 0; i--) if (headers[i].name.toLowerCase() === 'authorization') headers.splice(i, 1);
          headers.push({ name: 'Authorization', value: 'Bearer ' + token });
        }
        else if (auth?.type && auth.type !== 'noauth') warnings.push(`${item.name}: ${auth.type} authentication must be configured in Builder.`);
        let body = '';
        if (req.body?.mode === 'raw') body = req.body.raw || '';
        else if (req.body?.mode === 'urlencoded') {
          if (!Array.isArray(req.body.urlencoded)) throw new Error(`${item.name}: invalid form body.`);
          body = req.body.urlencoded.filter((field) => field && !field.disabled).map((field) => `${Workflow.encodeFormTemplate(field.key)}=${Workflow.encodeFormTemplate(field.value ?? '')}`).join('&');
          if (!HTTP.getHeader(headers, 'content-type')) headers.push({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
        } else if (req.body?.mode) { warnings.push(`${item.name}: skipped ${req.body.mode} body. File uploads are not imported.`); continue; }
        if (item.event || req.event || input.event) warnings.push(`${item.name}: scripts are not executed or imported.`);
        if (requests.length >= 100) throw new Error('Postman import is limited to 100 requests.');
        const headerText = headers.map((header) => `${header.name}: ${header.value}`).join('\n');
        requests.push({ name: String(item.name || 'Request'), folder: folder || 'Postman', raw: `${String(req.method || 'GET').toUpperCase()} ${url} HTTP/1.1${headerText ? '\n' + headerText : ''}\n\n${body}`, target: /^https:/.test(url) ? 'https://localhost' : 'http://localhost', follow: false, notes: typeof req.description === 'string' ? req.description : '' });
      }
    };
    walk(input.item);
    return { requests: Workflow.importCollection({ format: 'interceptor-collection', version: 1, requests }), variables, warnings };
  }

  function validateBackup(input) {
    if (!input || input.format !== 'interceptor-backup' || input.version !== 1 || !input.workspace || typeof input.workspace !== 'object' || Array.isArray(input.workspace)) throw new Error('Not an Interceptor workspace backup.');
    const workspace = input.workspace;
    const arrays = { history: 2500, repeaters: 100, collections: 100, autoLog: 500, runnerResults: 50, findings: 1000, environments: 50, websocketFrames: 1000 };
    for (const [name, max] of Object.entries(arrays)) {
      if (!Array.isArray(workspace[name]) || workspace[name].length > max) throw new Error(`Backup ${name} must be an array with at most ${max} entries.`);
    }
    const str = (value, max, label) => { if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${label} in backup.`); };
    const object = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} in backup.`); };
    const id = (value, label) => { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${label} in backup.`); };
    const metadata = (value, label) => {
      for (const key of ['duration', 'bytes', 'size']) if (value[key] != null && (!Number.isFinite(value[key]) || value[key] < 0)) throw new Error(`Invalid ${label} ${key}.`);
      for (const key of ['follow', 'truncated']) if (value[key] != null && typeof value[key] !== 'boolean') throw new Error(`Invalid ${label} ${key}.`);
      for (const key of ['meta', 'error']) if (value[key] != null) str(value[key], 20_000, label + ' ' + key);
    };
    for (const entry of workspace.history) {
      object(entry, 'history entry');
      str(entry.url, 20_000, 'history URL');str(entry.method, 40, 'history method');
      if (!/^https?:$/.test(new URL(entry.url).protocol)) throw new Error('Backup history URL is not HTTP(S).');
      if (!Number.isFinite(entry.wallTime)) throw new Error('Invalid history metadata in backup.');
      id(entry.id, 'history ID'); metadata(entry, 'history');
      if (entry.status != null && (!Number.isInteger(entry.status) || entry.status < 0 || entry.status > 599)) throw new Error('Invalid history status.');
      if (entry.type != null) str(entry.type, 1000, 'history type');
      for (const key of ['statusText', 'httpVersion', 'state', 'mime', 'source', 'note']) if (entry[key] != null) str(entry[key], key === 'note' ? 1_000_000 : 20_000, 'history ' + key);
      if (entry.reqBodyComplete != null && typeof entry.reqBodyComplete !== 'boolean') throw new Error('Invalid history body completeness.');
      if (entry.reqBodyOmittedReason != null) str(entry.reqBodyOmittedReason, 20_000, 'body omission reason');
      for (const list of [entry.reqHeaders, entry.resHeaders]) {
        if (!Array.isArray(list) || list.length > 1000) throw new Error('Invalid history headers in backup.');
        for (const header of list) { str(header.name, 1000, 'header name');str(header.value, 100_000, 'header value'); }
      }
      if (entry.reqBody != null) str(entry.reqBody, 800_000, 'request body');
      if (entry.resBody != null) str(entry.resBody, 800_000, 'response body');
    }
    Workflow.importCollection({ format: 'interceptor-collection', version: 1, requests: workspace.collections });
    for (const request of workspace.repeaters) {
      object(request, 'Repeater request'); id(request.id, 'Repeater ID'); metadata(request, 'Repeater');
      if (request.snapshotSeq != null && (!Number.isSafeInteger(request.snapshotSeq) || request.snapshotSeq < 0)) throw new Error('Invalid snapshot sequence.');
      if (request.snapshotId != null && typeof request.snapshotId !== 'string' && !Number.isSafeInteger(request.snapshotId)) throw new Error('Invalid selected snapshot.');
      str(request.raw, 1_000_000, 'Repeater request');str(request.target, 20_000, 'Repeater target');
      if (request.response != null) str(request.response, 4_500_000, 'Repeater response');
      if (request.sent != null) str(request.sent, 1_200_000, 'sent request');
      if (request.assertions != null) str(request.assertions, 100_000, 'assertion draft');
      if (request.snapshots && (!Array.isArray(request.snapshots) || request.snapshots.length > 5)) throw new Error('Invalid response snapshots.');
      for (const snapshot of request.snapshots || []) { object(snapshot, 'response snapshot'); id(snapshot.id, 'snapshot ID'); str(snapshot.response, 201_000, 'snapshot response'); str(snapshot.sent, 201_000, 'snapshot request'); str(snapshot.label, 1000, 'snapshot label'); }
    }
    for (const environment of workspace.environments) { object(environment, 'environment'); if (environment.id != null) id(environment.id, 'environment ID'); str(environment.name, 100, 'environment name');str(environment.variables, 100_000, 'environment variables'); }
    if (workspace.variables != null) str(workspace.variables, 100_000, 'variables');
    for (const row of workspace.runnerResults) { object(row, 'Runner result'); id(row.id, 'Runner result'); metadata(row, 'Runner'); str(row.response, 101_000, 'Runner response'); str(row.raw, 200_000, 'Runner request'); str(row.target, 20_000, 'Runner target'); str(row.payload, 10_000, 'payload'); }
    for (const finding of workspace.findings) {
      object(finding, 'finding');
      for (const key of ['code', 'severity', 'title', 'url', 'evidence', 'advice', 'status']) str(finding[key], 20_000, 'finding ' + key);
      id(finding.id, 'finding ID'); id(finding.entryId, 'finding entry ID');
      if (!['open', 'reviewed', 'ignored'].includes(finding.status) || !['info', 'review'].includes(finding.severity)) throw new Error('Invalid finding metadata.');
    }
    for (const frame of workspace.websocketFrames) { object(frame, 'WebSocket frame'); id(frame.id, 'WebSocket ID'); str(frame.url, 20_000, 'WebSocket URL'); str(frame.data, 20_000, 'WebSocket frame'); if (!Number.isInteger(frame.opcode) || frame.opcode < 0 || frame.opcode > 15 || !['Sent', 'Received'].includes(frame.direction) || (frame.time != null && !Number.isFinite(frame.time))) throw new Error('Invalid frame metadata.'); }
    for (const name of Object.keys(arrays)) {
      const identifiers = workspace[name].filter((entry) => entry?.id != null).map((entry) => entry.id);
      if (new Set(identifiers).size !== identifiers.length) throw new Error('Duplicate IDs in backup.');
    }
    if (workspace.fields != null) {
      if (typeof workspace.fields !== 'object' || Array.isArray(workspace.fields)) throw new Error('Invalid tool drafts.');
      for (const [key, value] of Object.entries(workspace.fields)) if (typeof value !== 'boolean') str(value, key === 'decoderOutput' ? 10_000_000 : key === 'inspectResponse' ? 4_100_000 : 1_000_000, 'tool draft');
    }
    if (workspace.settings && (typeof workspace.settings !== 'object' || Array.isArray(workspace.settings))) throw new Error('Invalid backup settings.');
    for (const key of ['compare', 'builder', 'comparison']) if (workspace[key] != null && (typeof workspace[key] !== 'object' || Array.isArray(workspace[key]))) throw new Error('Invalid ' + key + ' in backup.');
    if (workspace.settings?.autoRules != null) {
      if (!Array.isArray(workspace.settings.autoRules) || workspace.settings.autoRules.length > 100) throw new Error('Invalid Auto rules.');
      for (const rule of workspace.settings.autoRules) { str(rule.param, 20_000, 'rule fields'); str(rule.value, 100_000, 'rule replacement'); }
    }
    for (const [name, max] of [['left', 4_100_000], ['right', 4_100_000], ['leftLabel', 1000], ['rightLabel', 1000], ['unified', 2_100_000]]) if (workspace.compare?.[name] != null) str(workspace.compare[name], max, 'comparison');
    for (const entry of workspace.autoLog) {
      object(entry, 'Auto log'); id(entry.id, 'Auto log ID'); id(entry.seqNo, 'Auto sequence'); str(entry.url, 20_000, 'Auto log URL'); str(entry.method, 40, 'Auto log method');
      if (!Array.isArray(entry.changes) || entry.changes.length > 1000) throw new Error('Invalid Auto log changes.');
      for (const change of entry.changes) { object(change, 'Auto change'); str(change.key, 20_000, 'change key'); if (change.where != null) str(change.where, 1000, 'change location'); if (change.from != null) str(String(change.from), 800_000, 'change value'); if (change.to != null) str(String(change.to), 800_000, 'change value'); }
    }
    const validateTests = (tests) => {
      if (!Array.isArray(tests) || tests.length > 50) throw new Error('Invalid assertion results.');
      for (const test of tests) { object(test, 'assertion result'); str(test.label, 1000, 'test label'); str(test.actual, 1_000_000, 'test actual'); str(test.detail, 20_000, 'test detail'); if (typeof test.pass !== 'boolean') throw new Error('Invalid test status.'); }
    };
    for (const row of [...workspace.repeaters, ...workspace.runnerResults, ...(workspace.builder ? [workspace.builder] : [])]) {
      if (row.status != null && (!Number.isInteger(row.status) || row.status < 0 || row.status > 599)) throw new Error('Invalid response status.');
      if (row.error != null) str(row.error, 20_000, 'response error');
      if (row.tests != null) validateTests(row.tests);
      for (const snapshot of row.snapshots || []) if (snapshot.tests != null) validateTests(snapshot.tests);
    }
    if (workspace.builder) {
      metadata(workspace.builder, 'Builder');
      str(workspace.builder.raw, 500_000, 'Builder request'); str(workspace.builder.target, 20_000, 'Builder target');
      if (workspace.builder.response != null) str(workspace.builder.response, 4_500_000, 'Builder response');
      if (workspace.builder.sent != null) str(workspace.builder.sent, 1_200_000, 'Builder sent request');
      if (workspace.builder.assertions != null) str(workspace.builder.assertions, 100_000, 'Builder assertions');
    }
    if (workspace.comparison) for (const key of ['left', 'right', 'summary']) str(workspace.comparison[key], 1_000_000, 'credential comparison');
    if (workspace.interceptDrafts != null) {
      if (!Array.isArray(workspace.interceptDrafts) || workspace.interceptDrafts.length > 100) throw new Error('Invalid paused drafts.');
      for (const draft of workspace.interceptDrafts) { object(draft, 'paused draft'); str(draft.raw, 1_000_000, 'paused draft'); str(draft.url, 20_000, 'paused URL'); if (!['request', 'response'].includes(draft.stage)) throw new Error('Invalid paused stage.'); }
    }
    if (workspace.layout != null) {
      object(workspace.layout, 'layout'); object(workspace.layout.splits, 'layout splits');
      if (workspace.layout.version !== 1) throw new Error('Unsupported layout preferences.');
      const splitNames = ['history-list', 'history-messages', 'intercept', 'repeater', 'decoder', 'comparer-inputs', 'comparer-result', 'inspector', 'inspector-messages', 'runner-plan', 'runner-results', 'collections', 'collection-sidebar', 'websocket', 'builder'];
      for (const [key, split] of Object.entries(workspace.layout.splits)) {
        if (!splitNames.includes(key)) throw new Error('Unknown layout split.');
        object(split, 'layout split');
        for (const [axis, ratio] of Object.entries(split)) if (!['x', 'y'].includes(axis) || !Number.isFinite(ratio) || ratio < 20 || ratio > 80) throw new Error('Invalid layout split ratio.');
      }
    }
    // The UI restores only named fields, without imported live session handles.
    return JSON.parse(JSON.stringify(workspace));
  }

  function base64(bytes) { return HTTP.bytesToB64(bytes); }
  function unbase64(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid encrypted backup encoding.');
    return HTTP.b64ToBytes(text);
  }
  async function backupKey(password, salt) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 200_000 }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptBackup(backup, password) {
    if (password.length < 8) throw new Error('Use a backup password with at least 8 characters.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await backupKey(password, salt), new TextEncoder().encode(JSON.stringify(backup)));
    return { format: 'interceptor-encrypted-backup', version: 1, salt: base64(salt), iv: base64(iv), data: base64(new Uint8Array(ciphertext)) };
  }
  async function decryptBackup(input, password) {
    if (input.format !== 'interceptor-encrypted-backup' || input.version !== 1) throw new Error('Unsupported encrypted backup.');
    const salt = unbase64(input.salt), iv = unbase64(input.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error('Invalid encrypted backup metadata.');
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await backupKey(password, salt), unbase64(input.data));
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch { throw new Error('Unable to unlock backup: wrong password or damaged file.'); }
  }
  const api = { parseAssertions, runAssertions, jsonPointer, passiveReview, withoutCredentials, importPostman, validateBackup, encryptBackup, decryptBackup };
  global.Lab = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
