'use strict';
const fs = require('node:fs');
const { revision } = require('./memory-automation');

// Exact bytes from a bounded regular descriptor, not a derived transcript hash.
function sourceSnapshot(file, maxBytes = 128 * 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('Memory source is not a bounded regular file');
    const buffer = Buffer.alloc(before.size + 1); let length = 0, n;
    while (length < buffer.length && (n = fs.readSync(fd, buffer, length, buffer.length - length, length))) length += n;
    const after = fs.fstatSync(fd), current = fs.statSync(file);
    if (length !== before.size || !current.isFile() || before.ino !== current.ino || before.dev !== current.dev ||
        before.size !== after.size || before.size !== current.size || before.mtimeMs !== after.mtimeMs ||
        before.mtimeMs !== current.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ctimeMs !== current.ctimeMs) {
      throw new Error('Memory source changed while reading');
    }
    const bytes = buffer.subarray(0, length);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), revision: revision(bytes), stat: after };
  } finally { fs.closeSync(fd); }
}
module.exports = { sourceSnapshot };
