# Cold model-only worker and grounded memory

## Why

Memory work is not a conversation. Distillation, leaf extraction and epic
evidence want exactly one thing: send this evidence to this model, get one reply
back. Today they go through the same `pi` agent path as everything else — a full
agent session with tools, retries, ambient extensions and continuation. That is
more machinery than the job needs, and it is the reason images cannot be sent at
all: there is no way to hand a provider an actual `image` block through it.

So memory calls get their own transport, and only memory calls. With
`memoryImages: true`, a session's images and their attributed text go to the
model together, and one analysis produces both the visible note and the memory
leaf. With it off (the default) nothing changes anywhere.

## The transport

`internal-model.js` spawns a worker that uses installed Pi's `ModelRuntime` —
not an `AgentSession`, not the RPC agent loop, not a warm web worker.

1. Copy **only the selected provider's** `models.json` / `auth.json` entries into
   an owner-only temporary agent directory under `TMPDIR`. Credentials and
   settings are never written back to the configured agent.
2. Canonicalize the trusted entrypoint paths from `providerExtensions` and check
   they are readable regular files (symlinks to such files are fine). Load only
   those. Ambient extensions, context files, skills, templates and themes are
   suppressed; only the selected provider's registrations are kept.
3. Reject loader errors, missing SDK capabilities, fuzzy or unresolved model ids,
   and models that do not declare image input while image mode is on. No catalog
   network refresh.
4. The parent re-checks authorization, then builds one user message and a fixed
   evidence-only system message with `tools: []`, and calls `streamSimple` once
   with `maxRetries: 0`.
5. Provider errors, truncated responses and tool requests are rejected. There is
   no agent continuation, no compaction, no tool executor.
6. `internal-model-supervisor.js` anchors the owned process-group id so it
   survives the worker exiting. SIGTERM is followed by a bounded group SIGKILL
   while that anchor exists, then the direct child is awaited and Linux `/proc`
   is checked for live group members before temporary state is removed. A
   retired PGID is never signalled. Unverifiable cleanup fails and **keeps** the
   temporary state rather than reporting success.

### What this does not promise

Trusted extension code is not sandboxed. It can have its own side effects, and
factory code runs before the post-load hook check — that check cannot undo them.
An extension registering lifecycle, input or payload hooks is rejected, so a
provider that only discovers models dynamically needs a usable static definition
first. The no-network test boundary is a test boundary, not a deployment sandbox.
An already transmitted request may still finish remotely after local
cancellation. Whole-group exit verification requires Linux. Compatibility with
any particular native or custom provider, its auth and its image support is
unverified; no package was added to bridge this.

## Grounded memory

`multimodal-memory.js` runs one analysis per attributed section and returns the
visible note and the memory leaf together. It validates the output schema and
restores the user text and ancestry **from the source**, rather than trusting
quotes the model produced. A malformed reply gets at most one correction retry
with byte-identical input and attachments.

A resumed conversation is analyzed as its current whole revision, including
older context and off-branch alternatives. This is not delta extraction.

With `memoryImages: false` in this path, images are stripped from the text and
replaced with explicit uninspected markers — and those markers are never
promoted into verbatim user quotes. Notes report *images supplied*, not a claim
that anything was understood.

Intent evidence (`memory-intent-evidence.js`) carries force, situation, quote,
branch, entry and ancestor ids and image identities through weighing and
rendering, and its identity hashes all of that — so editing a quote or its
ancestry forces re-synthesis instead of reusing an old tier.

Existing project, area and epic rollups consume already-grounded leaves as text.
They do not get a second copy of the images. Default text-only distillation keeps
its existing pipeline untouched.

## Cache identity

An image-bearing fingerprint binds the raw source bytes, the image mode and the
internal-model configuration. Changing image bytes alone invalidates it. Old
text caches cannot claim freshness for an image-bearing leaf, and a mode or
cache re-index is not by itself a source change. Historical leaves are retained,
not retroactively relabelled as visually grounded.

## Routing

`memory-feature.js` is the seam. Image mode reroutes memory document helpers
only — review, naming and other text helpers keep the existing `pi` transport.
A call's explicit metadata survives the switch in both directions.

## Coverage

- `test/internal-model.test.js`, `test/internal-static-model.test.js` — real
  fake-provider image blocks, order, model and `tools: []`; no hidden tool
  continuation or retry; unsupported hooks and configuration failures; temporary
  cleanup; static `models.json` routing without a dummy extension.
- `test/model-process-group.test.js` — owned-group termination with a live
  descendant (Linux only; skips elsewhere).
- `test/multimodal-memory.test.js` — correction retries preserve the exact
  attachment mapping; note and leaf come from one analysis; source drift during
  the call is never published; routing leaves unrelated text helpers alone.
- `test/memory-cache.test.js` — leaf freshness binds raw source, image mode and
  model identity; a re-index is not a content change.
- `test/memory-epic-acceptance.test.js` — Given/When/Then: source or model drift
  at each epic stage (evidence retry, synthesis, chapter, each temp file,
  directory sync) stops every later stage and guarded publication.
- `test/memory-browser-images.test.js` — images produced by real Chromium canvas
  JPEG encoding at the app's quality setting keep byte identity through
  hydration and actual provider delivery (skips without chromium).
