'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { EventEmitter } = require('node:events');

// Exercise the production transport's unavailable-ownership path, without
// starting a provider or signalling a process. The acquired IPC channel is
// safe to retire even though unknown descendants cannot be declared exited.
for (const platform of ['linux', 'darwin', 'win32']) {
  test('unavailable ' + platform + ' ownership retires acquired IPC and retains failure, never claiming cleanup', async () => {
    const source = fs.readFileSync(require.resolve('../internal-model'), 'utf8');
    const start = source.indexOf('function workerOnce('), end = source.indexOf('\nmodule.exports', start);
    assert.ok(start >= 0 && end > start);
    const child = new EventEmitter(); child.pid = 10; child.connected = true;
    const sent = [], timers = new Map(); let next = 0;
    child.send = packet => sent.push(packet);
    child.disconnect = () => { child.connected = false; child.emit('close'); };
    const box = vm.createContext({
      process: { platform, execPath: '/owned/node' }, path, __dirname: '/owned/source', Buffer,
      spawn: () => child, stopped: () => new Error('cancelled'),
      createProcessOwner: () => ({ anchor() { throw new Error('ownership unavailable'); },
        capture() { throw new Error('ownership unavailable'); }, signal: () => false, alive: () => false }),
      setTimeout: (fn, delay) => { const id = ++next; timers.set(id, { fn, delay }); return id; },
      clearTimeout: id => timers.delete(id),
    });
    vm.runInContext(source.slice(start, end), box);
    const pending = box.workerOnce({ request: {}, cwd: '/owned/temp', env: {}, check() {}, timeoutMs: 120000 });
    pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    const remainedConnectedBeforeDeadline = child.connected;
    // Let the prior implementation settle too, so red evidence does not leave
    // an unobserved promise. This is a controlled timer, not a real wait.
    for (const { fn, delay } of [...timers.values()]) if (delay !== 120000) fn();
    await assert.rejects(pending, error => error.retainTemporaryState === true);
    assert.equal(remainedConnectedBeforeDeadline, false, 'unavailable ownership must not leave the supervisor IPC open');
    assert.deepEqual(sent, [], 'no provider prepare/invoke after unavailable ownership');
    assert.equal(child.connected, false);
  });
}
