# Source-image admission

## Why

Transcripts already carry images — a pasted screenshot, a diagram, a browser
screenshot returned inside a tool result. The parser records *where* they are,
but nothing can currently read one. Before anything can be done with them, there
has to be a layer that decides which bytes are safe to hand onward and which are
not, and that decision has to be a pure function: no network, no model, no
process, no writes.

That is all this adds. Nothing calls it yet.

## What it does

`memory-images.js` and `memory-jpeg.js` take a transcript file and produce
attributed message rows with their images attached, or they fail. There is no
partial success — an image that cannot be accounted for fails the whole bundle
rather than being silently dropped.

**Snapshot.** `sourceSnapshot(file)` reads at most the admitted size plus one
byte (a writer that keeps appending cannot make it allocate an unbounded
buffer), then re-checks inode, device, size, mtime and ctime. A source edited
during the read fails. Invalid UTF-8 fails. It returns the text, a sha256
revision of the exact bytes, and the stat.

`parseFile` in `server.js` gains an optional `sourceText` argument so it can
parse that captured text rather than re-reading the file. Passing `null` — every
existing caller — keeps the current streaming read unchanged.

**Admission.** `decodeImage` accepts static PNG and browser-produced JPEG.

- PNG: signature, chunk CRCs, header sanity, palette rules, bounded zlib output
  with an exact expected length, and a scanline filter-byte walk. Grayscale,
  palette, alpha, 1–16-bit depths and Adam7 interlacing are supported. Animated
  PNG (`acTL`/`fcTL`/`fdAT`) fails.
- JPEG: marker, segment, table and scan framing for baseline, extended
  sequential and progressive modes, frame dimensions, table presence and a
  terminal EOI.
- Both: canonical base64 only (a re-encode must reproduce the input byte for
  byte), and per-image, per-session and per-call budgets.

**These are structural validators, not codecs.** The JPEG path does not decode
Huffman or entropy data, so it does not certify every compressed pixel. Nothing
is resized or transcoded; source bytes pass through untouched and are identified
by their own sha256. WebP, GIF, animation and URL sources fail explicitly — there
is no fetching of any kind.

**Hydration.** `hydrate(snapshot, parsed)` binds each attachment to its message
by entry id, block path, message index and content identity, and resolves the
preceding assistant message by walking entry ancestry rather than file order —
so an off-branch user message gets the answer that actually preceded *it*.
Cycles, duplicate entry ids, missing or ambiguous references, a MIME that
changed, and any image the parser skipped all fail.

**Packing.** `packRows` groups rows under a token budget with a conservative
16,384-token reservation per image, keeping images with their message and
emitting an ordered attachment manifest. A single message that cannot fit fails
rather than being sent without its attachments.

## Limits

Source snapshot 128 MiB; 8 MiB per decoded image; 32 MiB and 32 images per
session; 4 images per call; 2048×2048 and about 4M pixels. These are admission
estimates, not provider-specific token or billing accounting.

## Coverage

- `test/memory-images.test.js` — PNG variants and every structural rejection;
  malformed, ambiguous, unsupported and URL images; hydration of direct and
  tool-result-nested attachments, image-only turns and both branches with the
  correct ancestor; reference, budget and JSONL failures; snapshot drift and
  invalid UTF-8.
- `test/memory-jpeg-acceptance.test.js` — Given/When/Then over ~40 malformed
  JPEG structures, each rejected by name.
