'use strict';
require('./win-hide.js');
// Keep a live tree/group anchor until the parent terminates the owned unit.
const { fork } = require('node:child_process');
const processes = require('./processes');
process.on('SIGTERM', () => {});
const worker = fork(process.argv[2], [], { detached: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
let terminal = false;
const send = p => { if (process.connected) process.send(p, () => {}); };
worker.on('message', p => { if (p.type === 'result' || p.type === 'error') terminal = true; send(p); });
worker.on('error', () => { terminal = true; send({ type: 'error', error: 'Memory worker could not start' }); });
worker.on('exit', () => { if (!terminal) send({ type: 'error', error: 'Memory worker exited before completion' }); });
process.on('message', p => { if (worker.connected) worker.send(p, () => {}); });
process.on('disconnect', () => processes.stopTree(process.pid, 'SIGKILL'));
setInterval(() => {}, 60000);
