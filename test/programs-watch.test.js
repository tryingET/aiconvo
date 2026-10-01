'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');

function registration({ exists = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const first = source.indexOf('function programLogWatchStart() {');
  const last = source.indexOf('\nfunction programLogWatchStop()', first);
  assert.ok(first >= 0 && last > first, 'the real registration body is available');
  const folder = 'C:\\Users\\RUNNER~1\\Temp\\functai\\calls';
  const native = p => p.replace('RUNNER~1', 'runneradmin');
  const watched = [], handles = [], changes = [];
  let days = ['2026-09-29', '2026-09-30', '2026-10-01'];
  const fakeFS = {
    existsSync: p => exists || p === path.win32.dirname(folder),
    readdirSync: () => days,
    realpathSync: { native },
    watch(p, options, callback) {
      assert.equal(options.persistent, false);
      watched.push(p);
      const h = new EventEmitter(); h.close = () => h.closed = true; h.callback = callback;
      handles.push(h); return h;
    },
  };
  const box = vm.createContext({ fs: fakeFS, path: path.win32, platform: { functaiCallsDir: () => folder },
    programLogWatch: null, programLogChanged: () => changes.push('changed'),
    setInterval: () => ({ unref() {} }) });
  vm.runInContext(source.slice(first, last), box);
  box.programLogWatchStart();
  return { folder, native, watched, handles, changes, box,
    present: () => exists = true, days: value => days = value };
}

test('Given a short Windows call-log spelling, When Programs registers its folder and two newest days, Then native watch arguments use canonical paths while logical keys are unchanged', () => {
  const f = registration();
  const logical = [f.folder, path.win32.join(f.folder, '2026-09-30'), path.win32.join(f.folder, '2026-10-01')];
  assert.deepEqual(f.watched, logical.map(f.native));
  assert.deepEqual(Array.from(f.box.programLogWatch.handles.keys()), logical);
});

test('Given a missing short-spelled call folder, When its existing ancestor reports creation, Then rearming closes the ancestor and canonically watches the new folder without changing follower notification', () => {
  const f = registration({ exists: false });
  assert.deepEqual(f.watched, [f.native(path.win32.dirname(f.folder))]);
  f.present(); f.handles[0].callback();
  assert.equal(f.handles[0].closed, true);
  assert.equal(f.box.programLogWatch.handles.has(f.folder), true);
  assert.deepEqual(f.watched.slice(1), [f.folder, path.win32.join(f.folder, '2026-09-30'), path.win32.join(f.folder, '2026-10-01')].map(f.native));
  assert.deepEqual(f.changes, ['changed']);
});

test('Given an already followed call log, When a new day arrives, Then only the oldest watch closes and the new canonical day joins the same logical lifecycle', () => {
  const f = registration();
  f.days(['2026-09-30', '2026-10-01', '2026-10-02']);
  f.box.programLogWatch.arm();
  assert.equal(f.handles[1].closed, true);
  assert.notEqual(f.handles[0].closed, true);
  assert.notEqual(f.handles[2].closed, true);
  assert.equal(f.watched.at(-1), f.native(path.win32.join(f.folder, '2026-10-02')));
  assert.equal(f.box.programLogWatch.handles.size, 3);
});
