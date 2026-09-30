'use strict';
// Run in a disposable child: a blocking FIFO open must not hang the test runner.
const fs = require('node:fs');
const { sourceSnapshot } = require('../../memory-images');
const file = process.argv[2], replacement = process.argv[3];
const open = fs.openSync, close = fs.closeSync;
let opened = 0, closed = 0;
fs.openSync = function (name, flags, ...rest) {
  if (name === file && replacement) fs.renameSync(replacement, file);
  const fd = open.call(this, name, flags, ...rest); opened++; return fd;
};
fs.closeSync = function (...args) { closed++; return close.apply(this, args); };
try { sourceSnapshot(file); process.exitCode = 1; console.log(JSON.stringify({ accepted: true })); }
catch (e) { console.log(JSON.stringify({ code: e.code, message: e.message, opened, closed })); }
