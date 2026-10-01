'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { nativeRequest } = require('./private-file-bootstrap-helper');
const { stopAndRemove } = require('./helpers/cleanup');

// Only Windows has the 8.3/GetLongPathNameW watch-prefix behavior. No
// simulated Windows result is presented as a native observation elsewhere.
if (process.platform === 'win32') {
  test('Given short and long native spellings of one call-log directory, When a real append reaches the watcher, Then the old short registration aborts while the production boundary joins callbacks and normal exit', { timeout: 120000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'program-watch-native-'));
    const children = [];
    t.after(async () => {
      const failures = [];
      for (const child of children.reverse()) {
        try { await stopAndRemove(child, null); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'watch children did not join; retain their directory');
      await stopAndRemove(null, dir);
    });
    const source = fs.readFileSync(path.join(__dirname, '../private-file-windows.cs'), 'utf8') + String.raw`
public static class WatchPathAliases {
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern uint GetShortPathNameW(string path, System.Text.StringBuilder output, uint length);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern uint GetLongPathNameW(string path, System.Text.StringBuilder output, uint length);
    public static string Short(string path) {
        var b = new System.Text.StringBuilder(32768); uint n = GetShortPathNameW(path, b, (uint)b.Capacity);
        if (n == 0 || n >= b.Capacity) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        return b.ToString();
    }
    public static string Long(string path) {
        var b = new System.Text.StringBuilder(32768); uint n = GetLongPathNameW(path, b, (uint)b.Capacity);
        if (n == 0 || n >= b.Capacity) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        return b.ToString();
    }
}`;
    const request = nativeRequest(dir, String.raw`
      $paths = @{ short = [WatchPathAliases]::Short($file); long = [WatchPathAliases]::Long($file) };
      [Console]::Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json.Serialize($paths))));`,
    { source: Buffer.from(source).toString('base64') });
    const aliases = JSON.parse(Buffer.from(execFileSync(request.exe, request.args, request.options).trim(), 'base64').toString('utf8'));
    assert.equal(fs.realpathSync.native(aliases.short), fs.realpathSync.native(aliases.long), 'same physical owned directory');
    if (aliases.short.toLowerCase() === aliases.long.toLowerCase()) return t.skip('this filesystem supplies no distinct native short spelling; the 8.3 red control is unavailable');

    const script = String.raw`
      const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
      const [mode, folder, server] = process.argv.slice(1), paths = [];
      let handles = [], timer, nativeCallbacks = 0, settled = false;
      const stop = () => { for (const h of handles) h.close(); clearInterval(timer); };
      const disconnect = () => { stop(); process.removeListener('message', control); process.disconnect(); };
      const event = () => {
        // Polling calls programLogChanged too; it is not native delivery.
        if (!nativeCallbacks || settled) return;
        settled = true;
        process.send({ type: 'event', nativeCallbacks }, disconnect);
      };
      const control = m => { if (m === 'stop') disconnect(); };
      process.on('message', control);
      if (mode === 'raw') {
        handles.push(fs.watch(folder, { persistent: false }, () => { nativeCallbacks++; event(); }));
        paths.push(folder);
      } else {
        const source = fs.readFileSync(server, 'utf8');
        const a = source.indexOf('function programLogWatchStart() {'), b = source.indexOf('\nfunction programLogWatchStop()', a);
        if (a < 0 || b <= a) throw Error('production watch body unavailable');
        const observed = { ...fs, watch(p, options, callback) {
          paths.push(p);
          return fs.watch(p, options, (...args) => { nativeCallbacks++; callback(...args); });
        } };
        const box = vm.createContext({ fs: observed, path, platform: { functaiCallsDir: () => folder },
          programLogWatch: null, programLogChanged: event, setInterval });
        vm.runInContext(source.slice(a, b), box); box.programLogWatchStart();
        handles = Array.from(box.programLogWatch.handles.values()); timer = box.programLogWatch.timer;
        if (handles.length !== 1) throw Error('real production watch not acquired');
      }
      process.send({ type: 'ready', paths });`;
    async function probe(mode) {
      const child = spawn(process.execPath, ['-e', script, mode, aliases.short, path.join(__dirname, '../server.js')], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      let stdout = '', stderr = '', event = false, nativeCallbacks = 0, paths;
      child.on('error', error => { stderr += error.message; });
      child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
      const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, event, nativeCallbacks, paths })));
      const ready = new Promise(resolve => child.on('message', m => {
        if (m.type === 'event') { nativeCallbacks = m.nativeCallbacks; event = nativeCallbacks > 0; }
        if (m.type === 'ready') { paths = m.paths; resolve(); }
      }));
      await Promise.race([ready, closed.then(result => { throw Error('watch child exited before ready: ' + JSON.stringify(result)); })]);
      const file = path.join(aliases.short, mode + '.jsonl');
      fs.appendFileSync(file, '{"synthetic":true}\n');
      const result = await closed;
      assert.equal(fs.readFileSync(file, 'utf8'), '{"synthetic":true}\n', 'real producer bytes survive both registrations');
      return result;
    }
    const raw = await probe('raw');
    console.log('NATIVE-WATCH-SPELLING', JSON.stringify({ aliases, raw }));
    assert.notEqual(raw.code, 0, 'the short-path red control must reproduce native failure');
    assert.match(raw.stderr, /_wcsnicmp\(filename, dir, dirlen\)/, 'the original native prefix assertion is the failed mechanism');
    const repaired = await probe('production');
    console.log('NATIVE-WATCH-BOUNDARY', JSON.stringify(repaired));
    assert.equal(repaired.code, 0, JSON.stringify(repaired));
    assert.equal(repaired.signal, null);
    assert.equal(repaired.event, true, 'a genuine callback is delivered before natural exit');
    assert.ok(repaired.nativeCallbacks > 0, 'polling must not satisfy the native callback oracle');
    assert.deepEqual(repaired.paths, [fs.realpathSync.native(aliases.short)]);
  });
}
