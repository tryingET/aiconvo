'use strict';
// Preload only in a fixture's separately created POSIX group. A file-runner
// timeout can kill its owner without running after hooks; lose the IPC lease
// and end this private group rather than orphan its ordinary descendants.
const P = require('../../processes');
const born = P.identity(process.pid);
if (process.platform === 'win32' || !process.connected || !born || born.pgrp !== process.pid)
  throw Error('private fixture group and owner IPC are required');
process.on('disconnect', () => {
  // This executing process still owns its startup-verified session/group
  // leader PID: it cannot have been reused while we execute this handler.
  // Do not introduce a blocking observer between owner loss and self-stop.
  process.kill(-process.pid, 'SIGKILL');
});
