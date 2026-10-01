'use strict';
// Windows uses one native handle for CREATE_NEW security, ACLs, identity,
// bytes and rename. POSIX uses the same acquired fd for stat/chmod/read/write.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const BUDGET = 1024 * 1024;

function windowsOperation(file, operation, bytes) {
  const root = process.env.SystemRoot || process.env.windir;
  if (!root) throw new Error('Windows system directory unavailable; cannot establish key security');
  const source = fs.readFileSync(path.join(__dirname, 'private-file-windows.cs'));
  const actions = {
    read: "[Console]::Write([ChatteringPrivateFile]::ReadEncoded($file))",
    assert: "if ([ChatteringPrivateFile]::Inspect($file, $false)) { [Console]::Write('OK') } else { [Console]::Write('ABSENT') }",
    ensure: "if ([ChatteringPrivateFile]::Inspect($file, $true)) { [Console]::Write('OK') } else { [Console]::Write('ABSENT') }",
    write: "[ChatteringPrivateFile]::Write($file, [Convert]::FromBase64String($request.bytes)); [Console]::Write('OK')",
  };
  // Pipe code, filename and bytes, not an oversized -EncodedCommand or secret argv.
  const script = "$ErrorActionPreference = 'Stop'; $request = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8).ReadToEnd() | ConvertFrom-Json; " +
    "Add-Type -TypeDefinition ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.source))); $file = $request.file; " + actions[operation];
  const input = JSON.stringify({ source: source.toString('base64'), file: path.resolve(file), bytes: bytes?.toString('base64') });
  const result = execFileSync(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 15000, windowsHide: true, input, encoding: 'utf8', maxBuffer: 2 * BUDGET, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  if (operation === 'read' && result.startsWith('DATA:')) return Buffer.from(result.slice(5), 'base64').toString('utf8');
  if (result === 'ABSENT' && operation === 'read') return null;
  if (result === 'ABSENT') throw Object.assign(new Error('Key storage absent'), { code: 'ENOENT' });
  if (result !== 'OK' || operation === 'read') throw new Error('Invalid native key-storage result');
}
function regularHandle(fd) {
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink !== 1) throw new Error('Key storage must be a singly linked regular file');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('Key storage has a foreign owner');
  return st;
}
function secureHandle(fd, protect) {
  regularHandle(fd);
  if (protect) fs.fchmodSync(fd, 0o600);
  const st = regularHandle(fd);
  if ((st.mode & 0o777) !== 0o600) throw new Error('Key storage must have mode 0600');
  return st;
}
function withHandle(file, protect, missing, use) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (e) { if (missing && e.code === 'ENOENT') return null; throw e; }
  try { return use(fd, secureHandle(fd, protect)); }
  finally { fs.closeSync(fd); }
}
function readPrivateFileSync(file) {
  if (process.platform === 'win32') return windowsOperation(file, 'read');
  return withHandle(file, true, true, (fd, st) => {
    if (st.size > BUDGET) throw new Error('Key storage exceeds budget');
    return fs.readFileSync(fd, 'utf8');
  });
}
function assertPrivateFileSync(file) {
  if (process.platform === 'win32') return windowsOperation(file, 'assert');
  withHandle(file, false, false, () => {});
}
function ensurePrivateFileSync(file) {
  if (process.platform === 'win32') return windowsOperation(file, 'ensure');
  withHandle(file, true, false, () => {});
}
function writePrivateFileSync(file, bytes) {
  bytes = Buffer.from(bytes);
  if (bytes.length > BUDGET) throw new Error('Key storage exceeds budget');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'win32') return windowsOperation(file, 'write', bytes);
  const tmp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const matches = st => { const own = fs.fstatSync(fd); return own.dev === st.dev && own.ino === st.ino; };
  try {
    secureHandle(fd, true);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    if (!matches(fs.lstatSync(tmp))) throw new Error('Key staging pathname was replaced');
    fs.renameSync(tmp, file);
    if (!matches(fs.lstatSync(file))) throw new Error('Published key pathname was replaced');
    secureHandle(fd, false);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}
module.exports = { assertPrivateFileSync, ensurePrivateFileSync, readPrivateFileSync, writePrivateFileSync };
