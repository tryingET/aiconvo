'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Execute the unmodified public helper, controlling only resource boundaries.
function boundary({ opening, failedStops = [], closeThrows = false } = {}) {
  const filename = path.join(__dirname, 'helpers/viewer-browser.js');
  let after, socket, port = 31000, spawnCount = 0, evaluateCount = 0;
  const stops = [], sent = [], held = [], children = [];
  const failure = new Error('controlled transport error');
  const stopErrors = [new Error('browser join uncertain'), new Error('server join uncertain')];
  class Socket {
    constructor() {
      socket = this; this.readyState = 0;
      queueMicrotask(() => {
        if (opening === 'error') this.onerror?.({ error: failure });
        else if (opening === 'close') { this.readyState = 3; this.onclose?.({ code: 1006, reason: 'opening disconnected' }); }
        else { this.readyState = 1; this.onopen(); }
      });
    }
    send(text) {
      if (this.throwSend) throw failure;
      const message = JSON.parse(text); sent.push(message);
      if (this.hold) { held.push(message); return; }
      let result = {};
      if (message.method === 'Target.createTarget') result = { targetId: 'target' };
      if (message.method === 'Target.attachToTarget') result = { sessionId: 'session' };
      if (message.method === 'Runtime.evaluate') {
        evaluateCount++;
        if (this.navigationErrors-- > 0) return this.reply(message.id, { error: { code: -32000, message: 'Execution context was destroyed.' } });
        if (this.scriptError) return this.reply(message.id, { result: { exceptionDetails: { text: 'original script exception' } } });
        result = { result: { value: true } };
      }
      this.reply(message.id, { result });
    }
    reply(id, body) { queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id, ...body }) })); }
    close() {
      if (closeThrows) throw failure;
      this.readyState = 3; this.onclose?.({ code: 1006, reason: 'controlled disconnect' });
    }
  }
  const modules = {
    'node:assert/strict': assert, 'node:path': path, 'node:os': { tmpdir: () => '/owned-scratch' },
    'node:fs': { realpathSync: { native: p => p }, mkdtempSync: p => p + 'home', mkdirSync() {}, writeFileSync() {} },
    'node:net': { createServer() {
      const s = new EventEmitter(), assigned = ++port;
      s.listen = (p, host, done) => queueMicrotask(done);
      s.address = () => ({ port: assigned }); s.close = done => queueMicrotask(done); return s;
    } },
    'node:child_process': { spawn() {
      const index = spawnCount++, child = Object.assign(new EventEmitter(), {
        exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
      }); children.push(child);
      if (index === 1) queueMicrotask(() => child.stderr.emit('data', 'DevTools listening on ws://controlled'));
      return child;
    } },
    './chromium.js': { chromiumBinary: () => 'controlled', CHROMIUM_TEST_FLAGS: [] },
    './first-run.js': { answerFirstRun() {} }, './home-env.js': { homeEnv: () => ({}) },
    './cleanup.js': { async stopAndRemove(child, home) {
      const name = home ? 'home' : child === children[1] ? 'browser' : 'server'; stops.push(name);
      if (failedStops.includes(name)) throw stopErrors[name === 'browser' ? 0 : 1];
    } },
  };
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(filename),
    require(name) { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; },
    process: { execPath: process.execPath, env: {}, stderr: { write() {} } },
    WebSocket: Socket, setTimeout, clearTimeout,
    fetch: async () => ({ json: async () => [{ key: 'pi:fixture/media.jsonl' }] }),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return {
    start: () => sandbox.module.exports.viewerBrowser({ after(fn) { after = fn; } }),
    cleanup: () => after(), socket: () => socket, sent, held, stops, failure, stopErrors,
    evaluateCount: () => evaluateCount,
  };
}

// A test watchdog, not a fixture/request deadline; always handles both outcomes.
async function promptly(promise, ms = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('request did not settle after transport failure')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));

for (const event of ['close', 'error', 'send']) {
  test(`Given pending public CDP calls, When transport ${event} fails, Then all reject and until stops retrying`, async t => {
    const b = boundary(); t.after(() => b.cleanup());
    const api = await b.start(), ws = b.socket(); ws.hold = true;
    const replies = [outcome(api.command('Page.getFrameTree')), outcome(api.evaluate('1')), outcome(api.until('false'))];
    // Deliberately ignored command: transport rejection must not be unhandled.
    api.command('Page.getFrameTree');
    if (event === 'close') ws.close();
    if (event === 'error') ws.onerror?.({ error: b.failure });
    if (event === 'send') { ws.throwSend = true; replies.push(outcome(api.command('Page.enable'))); }
    const settled = await promptly(Promise.all(replies));
    for (const row of settled) assert.ok(row.error, 'outstanding call must reject');
    if (event !== 'close') for (const row of settled) assert.equal(row.error, b.failure);
    else for (const row of settled) assert.match(row.error.message, /CDP.*closed.*1006.*controlled disconnect/i);
    const count = b.sent.length;
    const next = await promptly(outcome(api.until('true')));
    assert.equal(next.error, settled[0].error, 'retain original terminal transport error');
    assert.equal(b.sent.length, count, 'do not send/retry on a permanently failed transport');
    for (const message of b.held) ws.reply(message.id, { result: {} }); // late replies are harmless
  });
}

for (const event of ['close', 'error']) {
  test(`Given a connecting WebSocket, When it ${event}s, Then helper setup rejects and cleanup still runs`, async () => {
    const b = boundary({ opening: event });
    try {
      const result = await promptly(outcome(b.start()));
      assert.ok(result.error);
      if (event === 'error') assert.equal(result.error, b.failure);
      else assert.match(result.error.message, /CDP.*closed/i);
    } finally { await b.cleanup(); }
    assert.deepEqual(b.stops, ['browser', 'server', 'home']);
  });
}

test('Given a live CDP session, When context navigation briefly fails, Then until retries without changing exception assertions', async t => {
  const b = boundary(); t.after(() => b.cleanup()); const api = await b.start();
  b.socket().navigationErrors = 2; const before = b.evaluateCount();
  await api.until('true'); assert.equal(b.evaluateCount() - before, 3);
  b.socket().reply(99999, { result: {} });
  b.socket().scriptError = true;
  await assert.rejects(api.evaluate('throw Error()'), /original script exception/);
});

for (const failedStops of [[], ['browser'], ['server'], ['browser', 'server']]) {
  test(`Given owned resources, When stops fail for ${failedStops.join('+') || 'none'}, Then all joins run and uncertain writers retain home`, async () => {
    const b = boundary({ failedStops }); await b.start();
    const result = await outcome(b.cleanup());
    assert.deepEqual(b.stops, failedStops.length ? ['browser', 'server'] : ['browser', 'server', 'home']);
    if (!failedStops.length) assert.equal(result.error, undefined);
    else if (failedStops.length === 1) assert.equal(result.error, b.stopErrors[failedStops[0] === 'browser' ? 0 : 1]);
    else assert.deepEqual(Array.from(result.error.errors), b.stopErrors);
  });
}

test('Given a socket close exception, When teardown runs, Then both children still join and the original error is reported', async () => {
  const b = boundary({ closeThrows: true }); await b.start();
  const result = await outcome(b.cleanup());
  assert.deepEqual(b.stops, ['browser', 'server', 'home']); assert.equal(result.error, b.failure);
});

test('Given a real browser with pending evaluations, When its CDP socket disconnects, Then calls fail promptly without hiding original assertions', { timeout: 60000 }, async t => {
  const { viewerBrowser } = require('./helpers/viewer-browser');
  // Capture a real WebSocket at the helper's public dependency boundary.
  // Closing just the socket leaves Chromium alive, avoiding target-shutdown
  // protocol replies which are deliberately still asserted by evaluate.
  const OriginalWebSocket = global.WebSocket; let socket, api;
  global.WebSocket = class extends OriginalWebSocket {
    constructor(...args) { super(...args); socket = this; }
  };
  try { api = await viewerBrowser(t); }
  finally { global.WebSocket = OriginalWebSocket; }
  const badCommand = await api.command('NotARealDomain.method');
  assert.ok(badCommand.error, 'protocol error envelope is unchanged');
  await assert.rejects(api.evaluate('1', 2147483647), /Cannot find context/);
  await assert.rejects(api.evaluate('(()=>{throw new Error("original evaluation exception")})()'), /original evaluation exception/);
  const evaluation = outcome(api.evaluate('window.disconnectEvaluationStarted=true; new Promise(()=>{})'));
  await api.until('window.disconnectEvaluationStarted');
  const waiter = outcome(api.until('false'));
  api.command('Runtime.evaluate', { expression: 'new Promise(()=>{})', awaitPromise: true }); // intentionally ignored
  socket.close();
  const rows = await promptly(Promise.all([evaluation, waiter]), 5000);
  // Chromium may abort the socket with an error before its close event.
  // Keep that original error, including Undici's message-less TypeError.
  for (const row of rows) assert.ok(row.error instanceof Error, 'pending evaluation must reject');
  assert.equal(rows[1].error, rows[0].error, 'one terminal transport error rejects all waiters');
  const next = await promptly(outcome(api.command('Page.getFrameTree')));
  assert.equal(next.error, rows[0].error);
});
