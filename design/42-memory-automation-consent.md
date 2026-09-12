# Automatic memory: an explicit consent boundary

## Why

Automatic memory work starts itself. A settled conversation triggers a leaf
extraction; that triggers project document regeneration; that triggers epic
refreshes. On a fresh install with existing transcripts, enabling anything can
mean a long unattended batch over old material — provider calls the operator did
not ask for, on conversations they may not want read.

There is no way to say "from here on, but not backwards". `automaticMemory` is
that boundary.

| Mode | Meaning |
| --- | --- |
| `legacy` (default) | Today's behavior, unchanged: existing triggers and the historical retry queue. **Legacy is not a no-backfill policy.** |
| `off` | No automatic memory work. Manually requested operations still run. |
| `changes-after-enable` | Baselines everything present at activation without inference, then works only on what genuinely changes afterwards. |

These knobs do not stand in for each other. Turning memory automation off does
not stop AI titles; turning titles off does not stop manual memory work. And
`automatic: true` on a call is **not** memory consent — an unattended call is
checked against the live policy before invocation and again before publication.

## State

`~/.config/aiconvo/memory-automation.json`, outside disposable caches, because
consent is user data and not a cache. Atomic replacement fsyncs the file and its
directory. Activation scans raw revisions without inference and acknowledges
only after persistence. A fresh upstream install keeps legacy behavior; a
configured new-policy install with missing, corrupt, inconsistent or externally
modified state **fails closed**.

Every enable/disable transition gets a new epoch. The active record holds
baseline hashes and pending records with revision, epoch, status and stage.
Non-done records from retired epochs are kept for audit and can never become
eligible again in a new epoch; in-flight retired work is marked interrupted. The
on-disk state is re-read before claims and acknowledgments, so losing state
during a call cannot silently recreate consent when it completes.

## What counts as a change

Deliberately conservative:

- An indexed file already in the baseline must acquire a **different observed
  raw revision**.
- An unfamiliar file qualifies immediately only when the running controller saw
  its live creation, the same inode/device/birth time still holds, and both the
  filesystem birth time and a parseable session-origin timestamp fall after
  activation and no later than observation. The creation event, origin, birth
  time and observation provenance are all persisted. This covers genuine new
  one-shot sessions.
- First discovery after a restart, or during initial watcher enumeration, is
  **not** a creation event. Old imported logs, missing metadata and
  future/clock-anomalous timestamps are baselined instead. A later real revision
  change to those files qualifies normally.
- A late stale parse cannot replace the activation baseline.
- Cache version changes, cache deletion and re-indexing authorize nothing.
- Source-format and metadata byte changes count as revisions. This is byte-level
  change detection, not semantic-delta detection.

Creation qualification assumes filesystem birth-time support, observable watch
events and producer/host clock agreement. Origin time comes from Pi's session
header or Claude's first UUID-bearing record. **This is not cryptographic
provenance**: rewritten origin metadata, or a recently created imported log that
satisfies every bound, can look like live creation. Equally, missing watch roots
or a conservative clock check can baseline a genuinely new file. Creation is
never inferred from mtime or cache recreation alone.

## The pipeline

The existing ten-minute settle interval and two-minute sweep drive a separate
serial pipeline: claim one revision, build the summary and leaf, publish both,
refresh the already-built affected project/area/epic documents, acknowledge that
exact revision. Provider subcalls inside the concurrent legacy rollup helpers
are serialized within the ticket. Unbuilt memory collections are **not**
bootstrapped by a hidden backfill.

Queued unclaimed revisions survive a restart. Running records become interrupted
with no automatic replay. Model and transport failures stay errors rather than
joining the old model-health retry queue. Malformed output gets at most one
correction with identical input, guarded again before the call. Discard is
explicit and performs no inference. A new epoch requires a fresh baseline, never
adoption of old manual or backfill retries.

Guards run before each subcall, retry, stage and guarded publication. An old
completion cannot acknowledge newer pending work.

## Limits

- One aiconvo controller/writer is assumed. There is no cross-process lease.
- Source files are not locked. Guards check revisions at publication boundaries;
  they are not a transaction with external transcript writers.
- The note, leaf, documents and manifest are separate atomic files, **not one
  transaction**. An interruption can leave a published note or some documents
  with an interrupted or error phase. Already published output is not deleted on
  disable. Recovery means inspecting partial results, not silently replaying.
- Deleting cache locations does not delete consent or authorize reconstructing
  historical results with inference.

## Settings UI

`memory-settings.js` renders the three modes and the image opt-in in the model
pane, with activation confirmation, status, per-item errors and an explicit
discard. `changes-after-enable` requires an explicit internal provider/model, not
Pi's default. Partial settings updates preserve omitted fields.

## Coverage

- `test/memory-automation.test.js` — epochs, baselines, pending lifecycle,
  durable replacement, fail-closed on corrupt or externally changed state.
- `test/memory-observation.test.js` — live creation plus origin qualifies a
  one-shot; imports, missing/future origins and restart discovery baseline
  instead; a later change to a baselined file qualifies.
- `test/source-watcher.test.js` — creation events versus enumeration.
- `test/memory-feature.test.js` — one eligible revision produces both note and
  memory without consulting historical retries; activation races serialize;
  disable/re-enable during an outstanding call prevents stale publication;
  document subcalls and concurrent sweeps are serial and guarded; a late
  pre-activation parse cannot make a baseline revision eligible.
- `test/memory-acceptance.test.js` — Given/When/Then over the epoch, no-backfill
  and revocation boundaries.
- `test/memory-api.test.js`, `test/memory-settings.test.js` — isolated server
  activation, import and cache-rebuild behavior; settings controls and discard.
