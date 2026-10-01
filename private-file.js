'use strict';
// Key material is never written before the OS enforces owner-only access.
// Windows chmod does not set a DACL: use the actual NTFS security descriptor
// and read it back. Failure is fatal, never a permission exemption.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function windowsSecurity(file, protect) {
  const root = process.env.SystemRoot || process.env.windir;
  if (!root) throw new Error('Windows system directory unavailable; cannot establish key security');
  const script = "$ErrorActionPreference = 'Stop'; " +
    `$f = [System.IO.FileInfo]::new('${path.resolve(file).replace(/'/g, "''")}'); ` +
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ' +
    (protect ? '$acl = [System.Security.AccessControl.FileSecurity]::new(); ' +
      '$acl.SetAccessRuleProtection($true, $false); $acl.SetOwner($sid); ' +
      '$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)); ' +
      '$f.SetAccessControl($acl); ' : '') +
    '$a = $f.GetAccessControl(); $rules = @($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); ' +
    "if (!$a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { throw 'Key file is not owner-only' }; " +
    '$r = $rules[0]; ' +
    "if ($r.IdentityReference.Value -ne $sid.Value -or $r.IsInherited -or $r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $r.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected key access rule' }";
  execFileSync(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function regularFile(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.nlink !== 1) throw new Error('Key storage must be a singly linked regular file');
  return st;
}
function assertPrivateFileSync(file) {
  const st = regularFile(file);
  if (process.platform === 'win32') windowsSecurity(file, false);
  else if ((st.mode & 0o777) !== 0o600) throw new Error('Key storage must have mode 0600');
}
function ensurePrivateFileSync(file) {
  regularFile(file);
  if (process.platform === 'win32') windowsSecurity(file, true);
  else fs.chmodSync(file, 0o600);
  assertPrivateFileSync(file);
}
function writePrivateFileSync(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    // Never reuse a stale permissive .tmp file or follow its symlink.
    fd = fs.openSync(tmp, 'wx', 0o600);
    ensurePrivateFileSync(tmp);
    fs.writeFileSync(fd, bytes);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
    assertPrivateFileSync(file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}
module.exports = { assertPrivateFileSync, ensurePrivateFileSync, writePrivateFileSync };
