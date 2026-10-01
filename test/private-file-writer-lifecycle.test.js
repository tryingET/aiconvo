'use strict';
// Diagnostic only: pair unmodified public Write with an observed public Write.
// Identical canonical destination, payload and reset state; no ABI repair.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { nativeRequest } = require('./private-file-bootstrap-helper');

const observer = String.raw`
public static class WriterObserver {
    public static readonly System.Collections.Generic.List<string> Events = new System.Collections.Generic.List<string>();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, System.Text.StringBuilder path, uint size, uint flags);
    public static void Record(string phase, FileStream stream, string destination, string temporary) {
        try {
            string acquired = "closed";
            if (stream != null) {
                var name = new System.Text.StringBuilder(32768);
                uint length = GetFinalPathNameByHandleW(stream.SafeFileHandle, name, (uint)name.Capacity, 0);
                if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (length >= name.Capacity) throw new IOException("Observer pathname exceeds buffer");
                acquired = name.ToString();
            }
            // Pathname existence during exclusive acquisition is diagnostic,
            // not the publication assertion. That runs after Write returns.
            Events.Add(phase + "|" + acquired + "|target=" + File.Exists(destination) + "|temporary=" + File.Exists(temporary));
        } catch (Exception error) {
            // Observation must not replace a production exception/control flow.
            Events.Add("OBSERVER-ERROR|" + phase + "|" + error.ToString());
        }
    }
}`;
function observedSource(production) {
  const hooks = [
    ['var stream = Open(tmp, true);', 'var stream = Open(tmp, true);\n        WriterObserver.Record("acquired", stream, destination, tmp);'],
    ['Rename(stream, destination); // publish the acquired object itself', 'WriterObserver.Record("before-rename", stream, destination, tmp);\n            Rename(stream, destination); // publish the acquired object itself\n            WriterObserver.Record("after-rename", stream, destination, tmp);'],
    ['primary = error;\n            throw;', 'WriterObserver.Record("caught", stream, destination, tmp);\n            primary = error;\n            throw;'],
    ['if (!published) erase(stream); // also handle-bound', 'if (!published) {\n                    WriterObserver.Record("before-erase", stream, destination, tmp);\n                    erase(stream); // also handle-bound\n                    WriterObserver.Record("after-erase", stream, destination, tmp);\n                }'],
    ['try { stream.Dispose(); }', 'try {\n                    WriterObserver.Record("before-dispose", stream, destination, tmp);\n                    stream.Dispose();\n                    WriterObserver.Record("after-dispose", null, destination, tmp);\n                }'],
  ];
  let source = production;
  for (const [oldText, newText] of hooks) {
    assert.equal(source.split(oldText).length, 2, 'unique production lifecycle hook');
    source = source.replace(oldText, newText);
  }
  return source + observer;
}

test('Given production writer source, When diagnostic hooks are prepared, Then each lifecycle boundary is unique and the rename allocation remains unchanged', () => {
  const production = fs.readFileSync(path.join(__dirname, '..', 'private-file-windows.cs'), 'utf8');
  const source = observedSource(production);
  assert.equal(source.split('WriterObserver.Record(').length - 1, 8);
  assert.ok(source.includes('int size = checked(nameOffset + name.Length + 2);'));
});

// Compile/execute only on Windows. Linux parsing is NOT native evidence.
if (process.platform === 'win32') {
  test('Given the real public Windows writer, When identical publication states are paired with lifecycle observation, Then returned success means exact destination bytes remain visible after return', t => {
    const callerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-lifecycle-'));
    const dir = fs.realpathSync.native(callerDir);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const production = fs.readFileSync(path.join(__dirname, '..', 'private-file-windows.cs'), 'utf8');
    const observed = observedSource(production), results = [];
    // Both spellings designate the same owned directory. Keep spelling fixed
    // WITHIN each pair; separately expose any caller/canonical path dependency.
    const cases = [['caller', callerDir], ['canonical', dir]].flatMap(([spelling, parent]) =>
      ['create', 'replace', 'empty'].map(mode => ({ spelling, parent, mode })));
    for (const { spelling, parent, mode } of cases) {
      const file = path.join(parent, `${mode}-é-key`), payload = mode === 'empty' ? '' : 'new synthetic bytes';
      for (const variant of ['public-unmodified', 'public-observed']) {
        const result = { spelling, mode, variant, file, canonicalFile: path.join(dir, path.basename(file)), correct: false };
        try {
          for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
          if (mode === 'replace') fs.writeFileSync(file, 'old synthetic bytes');
          const request = nativeRequest(file, String.raw`
            $result = @{ writeReturned = $false; error = $null; nativeError = $null; events = @(); destinationRead = $null; readError = $null };
            try {
              [ChatteringPrivateFile]::Write($file, [System.Text.Encoding]::UTF8.GetBytes($request.payload));
              $result.writeReturned = $true;
            } catch {
              $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException };
              $result.error = $e.ToString();
              if ($e -is [System.ComponentModel.Win32Exception]) { $result.nativeError = $e.NativeErrorCode }
            }
            if ($request.observed) { $result.events = [WriterObserver]::Events.ToArray() }
            try { $result.destinationRead = [ChatteringPrivateFile]::ReadEncoded($file) }
            catch { $result.readError = $_.Exception.ToString() }
            [Console]::Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json.Serialize($result))));`,
          { source: Buffer.from(variant === 'public-unmodified' ? production : observed).toString('base64'),
            payload, observed: variant === 'public-observed' });
          Object.assign(result, JSON.parse(Buffer.from(execFileSync(request.exe, request.args, request.options).trim(), 'base64').toString('utf8')));
          result.hostExists = fs.existsSync(file);
          result.hostBytes = result.hostExists ? fs.readFileSync(file, 'utf8') : null;
          result.residue = fs.readdirSync(dir).filter(name => name !== path.basename(file));
          result.correct = result.writeReturned && result.error === null && result.readError === null &&
            result.destinationRead === 'DATA:' + Buffer.from(payload).toString('base64') &&
            result.hostExists && result.hostBytes === payload && result.residue.length === 0;
        } catch (error) {
          result.observationError = { message: error.message, status: error.status ?? null,
            stderr: String(error.stderr || '').slice(0, 3000) };
        } finally {
          results.push(result);
          console.log('NATIVE-PUBLIC-WRITER ' + JSON.stringify(result));
        }
      }
    }
    // Retain every case before asserting: failure is evidence, not an excuse
    // to skip subsequent setup/compiler/publication observations.
    assert.deepEqual(results.filter(r => r.observationError), [], 'all native cases interpretable');
    assert.deepEqual(results.filter(r => r.events.some(event => event.startsWith('OBSERVER-ERROR|'))), [], 'observer succeeded');
    for (let i = 0; i < results.length; i += 2) {
      const a = results[i], b = results[i + 1];
      const outcome = r => [r.writeReturned, r.nativeError, r.error?.split(':')[0] ?? null,
        r.readError?.split(':')[0] ?? null, r.destinationRead, r.hostBytes,
        r.residue.map(name => name.replace(/\.[0-9a-f]{32}\.tmp$/i, '.<temp>.tmp')), r.correct];
      assert.deepEqual(outcome(b), outcome(a), 'observation must not change public outcome or failure classification');
    }
    assert.deepEqual(results.filter(r => !r.correct), [], 'public Write success must publish the acquired object with exact post-return bytes');
  });
}
