'use strict';

// Synthetic fixture diagnostics only. No retries, timeout changes, transport
// changes or production hooks; never record authentication headers.
function createFixtureDiagnostics({ fetch, secrets = [], report = () => {} }) {
  const requests = [], events = [], expected = new WeakSet();
  let child, stdout = '', stderr = '';
  const sanitize = value => {
    let text = String(value);
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/([?&](?:token|secret|credential|api_?key)=)[^&\s"']*/gi, '$1[redacted]');
  };
  function clean(value, key = '', depth = 0) {
    if (/token|secret|password|authorization|credential|api.?key/i.test(key)) return '[redacted]';
    if (typeof value === 'string') return sanitize(value).slice(-2048);
    if (value === null || typeof value !== 'object') return value;
    if (depth > 8) return '[depth limit]';
    if (Array.isArray(value)) return value.slice(0, 32).map(v => clean(v, '', depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([k, v]) => [k, clean(v, k, depth + 1)]));
  }
  function errorInfo(error, depth = 0) {
    if (!error || depth > 4) return null;
    return clean({ name: error.name, message: error.message, code: error.code,
      errno: error.errno, syscall: error.syscall, cause: errorInfo(error.cause, depth + 1) });
  }
  function remember(list, item) { list.push(item); if (list.length > 16) list.shift(); }
  const snapshot = () => ({ child: child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed } : null,
    requests: clean(requests), events: clean(events), stdout: sanitize(stdout), stderr: sanitize(stderr) });
  function enhance(error, phase = 'fixture') {
    const result = new Error(`${sanitize(error.message || error)}\nFixture diagnostics (${phase}): ${JSON.stringify(snapshot(), null, 2)}`, { cause: errorInfo(error) });
    result.name = error.name || 'Error';
    if (error.code) result.code = error.code;
    if (error.stack) result.stack += '\nOriginal failure:\n' + sanitize(error.stack);
    return result;
  }
  const api = {
    sanitize, snapshot, enhance,
    expectedExit: process => expected.add(process),
    watch(process) {
      child = process;
      let unexpectedExit;
      remember(events, { type: 'spawn', pid: process.pid });
      process.stdout?.on('data', b => { stdout = (stdout + sanitize(b)).slice(-12288); });
      process.stderr?.on('data', b => { stderr = (stderr + sanitize(b)).slice(-12288); });
      process.on('error', e => {
        remember(events, { type: 'child-error', pid: process.pid, error: errorInfo(e) });
        report(JSON.stringify(snapshot(), null, 2));
      });
      process.on('exit', (code, signal) => {
        unexpectedExit = !expected.has(process);
        remember(events, { type: 'exit', pid: process.pid, code, signal, unexpected: unexpectedExit });
        if (unexpectedExit) report(JSON.stringify(snapshot(), null, 2));
      });
      // close follows stdio closure: retain late stderr even if teardown starts
      // after an unexpected exit but before all pipe data has arrived.
      process.on('close', (code, signal) => {
        const unexpected = unexpectedExit ?? !expected.has(process);
        remember(events, { type: 'close', pid: process.pid, code, signal, unexpected });
        if (unexpected) report(JSON.stringify(snapshot(), null, 2));
      });
    },
    async request(url, options = {}) {
      let body = options.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
      const entry = { method: options.method || 'GET', url: sanitize(url), body: clean(body) };
      remember(requests, entry);
      const failed = async (error, phase) => {
        entry.error = errorInfo(error); entry.phase = phase;
        // Let already pending stderr/exit events drain; do not retry the request.
        await new Promise(resolve => setImmediate(resolve));
        return enhance(error, phase);
      };
      let response;
      try { response = await fetch(url, options); }
      catch (e) { throw await failed(e, 'request'); }
      entry.status = response.status;
      const json = response.json.bind(response);
      response.json = async () => { try { return await json(); } catch (e) { throw await failed(e, 'response body'); } };
      return response;
    },
  };
  return api;
}
module.exports = { createFixtureDiagnostics };
