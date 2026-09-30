'use strict';
const processes = require('./processes');
const same = (a, b) => !!(a && b && a.pid === b.pid && a.start === b.start && a.boot === b.boot);

// Platform-owned current identity/parent records, never a guessed PID or PGID.
// The injectable API is also used by portable tests; production uses processes.
function createProcessOwner(api = processes, kill = (pid, signal) => process.kill(pid, signal)) {
  const owned = [];
  const read = pid => {
    const record = api.ownership(pid), id = api.identity(pid);
    if (!id && !record) return null;
    if (!same(id, record) || !record.boot || record.boot === 'unknown' || !record.start || !Number.isSafeInteger(record.ppid))
      throw new Error('Current process identity unavailable');
    return record;
  };
  return {
    owned, read,
    anchor(pid) { const id = read(pid); if (id) owned.push(id); return id; },
    capture(anchor, deadline) {
      if (!api.reliable || !same(read(anchor?.pid), anchor)) throw new Error('Live supervisor ownership unavailable');
      const table = api.ownershipList();
      if (!table.some(p => p.pid === anchor.pid)) throw new Error('Supervisor missing from current table');
      const parents = new Map([[anchor.pid, anchor]]);
      for (const pid of api.descendantsOf(table, anchor.pid).reverse()) {
        if (Date.now() > deadline) throw new Error('Process capture deadline');
        if (pid === anchor.pid) continue;
        const id = read(pid); if (!id) continue;
        const ppid = table.find(p => p.pid === pid)?.ppid, parent = parents.get(ppid);
        if (id.ppid !== ppid || !same(read(ppid), parent)) throw new Error('Descendant ownership changed during capture');
        parents.set(pid, id); owned.unshift(id); // children signalled before parents
      }
    },
    signal(signal, deadline) {
      let ok = true;
      for (const id of owned) {
        try {
          if (Date.now() > deadline) throw new Error('Process signal deadline');
          if (!same(read(id.pid), id)) continue; // exited/reused: leave the replacement alone
          try { kill(id.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        } catch { ok = false; }
      }
      return ok;
    },
    alive(anchor) {
      if (owned.some(id => same(read(id.pid), id))) return true;
      return api.ownershipList().some(p => p.pgrp === anchor?.pid);
    },
  };
}
module.exports = { createProcessOwner };
