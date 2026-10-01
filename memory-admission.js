'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { revision } = require('./memory-identity');

// Source claims, not folder/project guesses, authorize derived memory. A read
// keeps the admitted claims across awaits; replacing a manifest cannot authorize
// bytes already read from the preceding generation. Canonical aliases share ACLs.
function createMemoryAdmission({ notesDir, cacheDir, privateDirs = [], entries, files, authorize, privileged }) {
  const canonical = file => {
    const suffix = [];
    let current = path.resolve(file);
    for (;;) {
      try { return path.join(fs.realpathSync.native(current), ...suffix); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e; // permission/IO/loop errors are not public paths
        const parent = path.dirname(current);
        if (parent === current) throw e;
        suffix.unshift(path.basename(current)); current = parent;
      }
    }
  };
  const parse = bytes => { try { return JSON.parse(bytes); } catch { throw Object.assign(new Error('Memory source claims invalid'), { status: 403 }); } };
  function admit(file, { requireSource = false } = {}) {
    const abs = canonical(file), all = entries();
    const keys = [], proofs = [];
    for (const [key, entry] of Object.entries(all)) {
      if (files(key, entry).filter(Boolean).some(p => canonical(p) === abs)) keys.push(key);
    }
    let dir = path.dirname(abs);
    while (dir !== path.dirname(dir) && dir.startsWith(canonical(notesDir) + path.sep)) {
      const manifestFile = path.join(dir, 'manifest.json');
      if (fs.existsSync(manifestFile)) {
        const bytes = fs.readFileSync(manifestFile), manifest = parse(bytes);
        proofs.push([manifestFile, revision(bytes)]);
        keys.push(...(manifest.sourceKeys || []));
        if (manifest.paths?.inputs) {
          const input = fs.readFileSync(manifest.paths.inputs), data = parse(input);
          proofs.push([manifest.paths.inputs, revision(input)]);
          keys.push(...(data.sourceKeys || []), ...(data.leaves || []).map(r => r.key));
        }
        break;
      }
      dir = path.dirname(dir);
    }
    const protectedPath = privateDirs.some(dir => abs === canonical(dir) || abs.startsWith(canonical(dir) + path.sep)) || abs.startsWith(canonical(cacheDir) + path.sep) ||
      abs.startsWith(path.join(canonical(notesDir), 'projects') + path.sep) ||
      /(?:^|[\\/])memory-[a-f0-9]{64}\.md$/.test(abs);
    const selected = [...new Set(keys)];
    const stamp = () => { try { const s = fs.statSync(abs); return JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]); } catch { return null; } };
    const admittedStamp = stamp();
    const check = () => {
      if (canonical(file) !== abs) throw Object.assign(new Error('Memory alias changed'), { status: 409 });
      for (const [p, hash] of proofs) if (revision(fs.readFileSync(p)) !== hash) throw Object.assign(new Error('Memory generation changed'), { status: 409 });
      if ((selected.length || proofs.length || protectedPath) && stamp() !== admittedStamp) throw Object.assign(new Error('Memory file changed'), { status: 409 });
      if (!selected.length && (protectedPath || requireSource) && !privileged()) throw Object.assign(new Error('Memory source claims unavailable'), { status: 403 });
      for (const key of selected) {
        if (!entries()[key]) { if (!privileged()) throw Object.assign(new Error('Memory source unavailable'), { status: 403 }); }
        else authorize(key);
      }
    };
    check(); return check;
  }
  return { admit };
}
module.exports = { createMemoryAdmission };
