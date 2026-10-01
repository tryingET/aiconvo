'use strict';
// Native diagnostic, not a repair or a POSIX substitute. Compare the shipped
// counted buffer with an otherwise identical NUL-terminated allocation.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { nativeRequest } = require('./private-file-bootstrap-helper');

if (process.platform === 'win32') {
  test('Given real Windows publication, When counted and terminated rename buffers are compared, Then the shipped buffer publishes the acquired object and exact bytes', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-abi-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const production = fs.readFileSync(path.join(__dirname, '..', 'private-file-windows.cs'), 'utf8');
    const allocation = 'int size = checked(nameOffset + name.Length);';
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
    const observations = [];
    for (const variant of ['shipped', 'terminated-experiment']) {
      const source = (variant === 'shipped' ? production : production.replace(allocation,
        'int size = checked(nameOffset + name.Length + 2);')) + observer;
      for (const mode of ['create', 'replace', 'empty']) {
        const file = path.join(dir, `${variant}-${mode}-é-key`);
        if (mode === 'replace') fs.writeFileSync(file, 'old synthetic bytes');
        const bytes = mode === 'empty' ? '' : 'new synthetic bytes';
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
          [Console]::Write($json.Serialize($result));`, { source: Buffer.from(source).toString('base64'), payload: bytes });
        const observed = JSON.parse(execFileSync(request.exe, request.args, request.options).trim());
        const expectedPath = '\\\\?\\' + path.resolve(file);
        const correct = observed.error === null && observed.exists && observed.protected &&
          observed.afterPath.toLowerCase() === expectedPath.toLowerCase() &&
          observed.handleBytes === bytes && observed.destinationBytes === 'DATA:' + Buffer.from(bytes).toString('base64') &&
          observed.readError === null && !observed.stagingExists;
        observations.push({ variant, mode, correct, ...observed });
      }
    }
    // Only synthetic paths/bytes: retain both results even when production RED.
    console.log('NATIVE-RENAME-ABI ' + JSON.stringify(observations));
    assert.deepEqual(observations.filter(o => o.variant === 'shipped' && !o.correct), [],
      'API return alone is not destination/object/bytes publication');
  });
}
