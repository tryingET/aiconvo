'use strict';
// Native regression, not a POSIX substitute. Fixed and legacy variants use
// the same canonical destination and reset state; only allocation differs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { nativeRequest } = require('./private-file-bootstrap-helper');

if (process.platform === 'win32') {
  test('Given real Windows publication, When fixed and legacy rename buffers are compared, Then the shipped buffer publishes the acquired object and exact bytes', t => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rename-abi-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const production = fs.readFileSync(path.join(__dirname, '..', 'private-file-windows.cs'), 'utf8');
    const allocation = 'int size = checked(nameOffset + name.Length + 2);';
    assert.equal(production.split(allocation).length, 2, 'experiment must change exactly one allocation');
    const observer = String.raw`
public static class RenameObserver {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, System.Text.StringBuilder path, uint size, uint flags);
    public static string PathOf(FileStream stream) {
        var path = new System.Text.StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(stream.SafeFileHandle, path, (uint)path.Capacity, 0);
        if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (length >= path.Capacity) throw new IOException("Final pathname exceeds observation buffer");
        return path.ToString();
    }
}`;
    const normalize = value => value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase();
    const observations = [];
    for (const mode of ['create', 'replace', 'empty']) {
      // Identical name/content/UTF-16 length across the paired variants.
      const file = path.join(dir, `${mode}-é-key`);
      for (const variant of ['shipped', 'legacy-counted']) {
        const result = { variant, mode, correct: false };
        try {
          // The native child has exited; reset only this test's owned directory.
          for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
          if (mode === 'replace') fs.writeFileSync(file, 'old synthetic bytes');
          const bytes = mode === 'empty' ? '' : 'new synthetic bytes';
          const source = (variant === 'shipped' ? production : production.replace(allocation,
            'int size = checked(nameOffset + name.Length);')) + observer;
          const request = nativeRequest(file, String.raw`
            $result = @{ error = $null; nativeError = $null; beforePath = $null; afterPath = $null; handleBytes = $null; protected = $false };
            $s = [ChatteringPrivateFile]::Open($file + '.tmp', $true);
            try {
              [ChatteringPrivateFile]::Check($s);
              $result.beforePath = [RenameObserver]::PathOf($s);
              $bytes = [System.Text.Encoding]::UTF8.GetBytes($request.payload);
              $s.Write($bytes, 0, $bytes.Length); $s.Flush($true);
              $method = [ChatteringPrivateFile].GetMethod('Rename', [System.Reflection.BindingFlags]'NonPublic,Static');
              $arguments = [object[]]::new(2); $arguments[0] = $s; $arguments[1] = $file;
              try { [void]$method.Invoke($null, $arguments) }
              catch {
                $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException };
                $result.error = $e.Message;
                if ($e -is [System.ComponentModel.Win32Exception]) { $result.nativeError = $e.NativeErrorCode }
              }
              $result.afterPath = [RenameObserver]::PathOf($s);
              [ChatteringPrivateFile]::Check($s); $result.protected = $true;
              $s.Position = 0; $saved = [System.IO.MemoryStream]::new();
              try { $s.CopyTo($saved); $result.handleBytes = [System.Text.Encoding]::UTF8.GetString($saved.ToArray()) }
              finally { $saved.Dispose() }
              $type = [ChatteringPrivateFile].GetNestedType('RenameInformation', [System.Reflection.BindingFlags]'NonPublic');
              $result.nameOffset = [int][System.Runtime.InteropServices.Marshal]::OffsetOf($type, 'Name');
              $result.lengthOffset = [int][System.Runtime.InteropServices.Marshal]::OffsetOf($type, 'Length');
              $result.pointerSize = [IntPtr]::Size;
            } finally { $s.Dispose() }
            $result.exists = [System.IO.File]::Exists($file);
            $result.destinationBytes = $null; $result.readError = $null;
            try { $result.destinationBytes = [ChatteringPrivateFile]::ReadEncoded($file) }
            catch { $result.readError = $_.Exception.Message }
            $result.stagingExists = [System.IO.File]::Exists($file + '.tmp');
            [Console]::Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json.Serialize($result))));`,
            { source: Buffer.from(source).toString('base64'), payload: bytes });
          const observed = JSON.parse(Buffer.from(execFileSync(request.exe, request.args, request.options).trim(), 'base64').toString('utf8'));
          Object.assign(result, observed);
          result.hostExists = fs.existsSync(file);
          result.hostBytes = result.hostExists ? fs.readFileSync(file, 'utf8') : null;
          result.expectedPath = result.hostExists ? fs.realpathSync.native(file) : file;
          result.correct = observed.error === null && observed.exists && observed.protected && result.hostExists &&
            normalize(observed.afterPath) === normalize(result.expectedPath) && observed.handleBytes === bytes &&
            observed.destinationBytes === 'DATA:' + Buffer.from(bytes).toString('base64') && result.hostBytes === bytes &&
            observed.readError === null && !observed.stagingExists;
        } catch (error) {
          result.observationError = { message: error.message, status: error.status ?? null,
            stderr: String(error.stderr || '').slice(0, 3000) };
        } finally {
          // Per-case reporting preserves partial observations even on setup,
          // compiler or observer failure. TRACE makes the runner retain GREEN too.
          observations.push(result);
          console.log('NATIVE-RENAME-ABI ' + JSON.stringify(result));
        }
      }
    }
    assert.deepEqual(observations.filter(o => o.observationError), [], 'every native variant produced interpretable evidence');
    assert.deepEqual(observations.filter(o => o.variant === 'shipped' && !o.correct), [],
      'API return alone is not destination/object/bytes publication');
  });
}
