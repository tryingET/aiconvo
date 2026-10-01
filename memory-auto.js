'use strict';
const { createAutomation } = require('./memory-automation');
const { sourceSnapshot } = require('./memory-source');
const { observation } = require('./memory-observation');

// Text-only coordinator. The current server owns extraction, FunctAI, health,
// ACLs and publication; no alternate worker, provider or cache implementation.
function createMemoryAuto(hooks) {
  const policy = createAutomation({ file: hooks.file });
  const creations = new Map();
  let configuring = false, sweeping = false;
  const mode = () => hooks.settings().automaticMemory;
  const enabled = () => { const b = hooks.settings().backgroundAi; return !!b.decidedAt && b.memory; };
  const consentMode = () => enabled() ? mode() : 'off';
  const consistent = () => !configuring && policy.configurationAllowed(mode(), consentMode());
  return {
    status: () => policy.status(mode(), consentMode()),
    configuring: () => configuring,
    consistent,
    legacy: () => mode() === 'legacy' && consistent(),
    async configure(next, force = false) {
      if (!force && next.automaticMemory === mode()) return;
      if (configuring) throw new Error('Memory configuration already in progress');
      configuring = true;
      try {
        const baseline = {}, files = [];
        if (next.automaticMemory === 'changes-after-enable' && next.backgroundAi.decidedAt && next.backgroundAi.memory) {
          for await (const { key, file } of hooks.sources()) {
            if (Object.hasOwn(baseline, key)) throw new Error('Duplicate memory source');
            Object.defineProperty(baseline, key, { value: sourceSnapshot(file).revision, enumerable: true });
            files.push([key, file]);
          }
          for (const [key, file] of files) if (sourceSnapshot(file).revision !== baseline[key]) {
            throw new Error('Source changed during baseline; retry explicitly');
          }
        }
        policy.activate(next.backgroundAi.decidedAt && next.backgroundAi.memory ? next.automaticMemory : 'off', baseline);
        creations.clear();
      } finally { configuring = false; }
    },
    created(key, event) {
      const status = policy.status(mode());
      if (!configuring && enabled() && status.active && event?.kind === 'watch-create') creations.set(key, { ...event, epoch: status.epoch });
    },
    observe(key, snapshot) {
      if (!consistent() || !enabled() || mode() !== 'changes-after-enable') return;
      const current = sourceSnapshot(hooks.source(key));
      if (snapshot.revision !== current.revision) return;
      const status = policy.status(mode());
      policy.observe(key, snapshot.revision, { provenance: observation(snapshot, creations.get(key), status.epoch, status.activatedAt) });
      creations.delete(key);
    },
    async sweep(settleMs) {
      if (!consistent() || sweeping || !enabled() || mode() !== 'changes-after-enable') return;
      const key = policy.ready(settleMs).find(hooks.canRun);
      if (!key) return;
      sweeping = true;
      let ticket;
      try {
        ticket = policy.claim(key);
        const identity = hooks.identity(), project = hooks.project(key);
        const guard = () => {
          if (!consistent() || !enabled() || hooks.identity() !== identity || hooks.project(key) !== project) throw new Error('Memory configuration changed');
          hooks.authorize(key);
          policy.check(ticket, sourceSnapshot(hooks.source(key)).revision, mode());
        };
        guard();
        await hooks.run(key, ticket.revision, guard, stage => { guard(); policy.stage(ticket, stage); });
        guard(); policy.stage(ticket, 'leaf-and-documents'); policy.finish(ticket);
        return key;
      } catch (e) {
        if (ticket) policy.finish(ticket, e);
        hooks.error?.(key, e);
        return null;
      } finally { sweeping = false; }
    },
    discard: key => policy.discard(key),
  };
}
module.exports = { createMemoryAuto };
