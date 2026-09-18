# Mermaid reading view in the focused editor — 2026-09-14

Operator asked why `contrib/aiconvo` did not show mermaid diagrams and then
stated the want directly: see diagrams and switch between diagram and code
*inside* aiconvo, without jumping to Obsidian.

## Observed cause

Mermaid is supported in exactly one surface: aiconvo's own `mdRender()` in
`app.html`, which turns a ` ```mermaid ` fence into `<div class="mmd">` and
lazily loads `/vendor/mermaid.min.js` (vendored 11.17.0). Consumers are the
conversation transcript, the note viewer, conversation-note bodies and the
files-browser README preview.

The **focused document editor is the gap**: `mountDocumentEditor()` uses
`mrmdDocument.createDocumentEditor()` from
`vendor/mrmd-document/0.11.0/mrmd-document.iife.min.js`, and that bundle
contains zero occurrences of `mermaid`. It also exports no block-widget or
renderer registration seam (exports: `createDocumentEditor`, `createCodeEditor`,
`fileLanguage`, `getTheme`, `getThemeNames`, `version`). Its source
(`mrmd-packages/mrmd-editor`, `src/document-entry.js`) is not on this
workstation, so a true inline per-fence widget cannot be built or vendored here.

Second, smaller defect in the supported path: a mermaid load/init failure was
swallowed by `catch { return; }`, so a reader could see diagram sources as code
with no explanation, and a rejected load promise stuck for the whole session.

## Change

Host-owned reading view; no vendor bundle change, so no `sw.js` cache bump.

- `app.html`: `mdRender(src, q, image)` gained an optional image resolver
  (transcript behavior unchanged; images render only when a resolver is given
  and never inside fenced code). New `docDiagramsOn`, `docDiagramText()`,
  `docAssetUrl()`, `docDiagramImage()`, `setDocDiagrams()`, `toggleDocDiagrams()`,
  `docDiagramsKey()`. `mountDocumentEditor()` resets the mode per mount, wires
  the ⋯ button and binds Ctrl+Shift+M on the editor and on the preview.
  `renderMermaids()` now reports a load failure per diagram host instead of
  silently leaving code.
- `filesmode.js`: the markdown body gains `<div id="docPreview" class="doc-preview" tabindex="-1" hidden>`.
- `live-file.js`: ⋯ menu gains the `docDiagrams` ("Reading view") button.
- CSS: `.doc-preview` reuses the `.md` reading column and the existing `.mmd` rules.
- `design/37-focused-live-editor.md`: the surface and the constraint are documented.

Behavior: the reading view renders the live editor text (unsaved draft included)
with diagrams inline; double-clicking a diagram reveals its code in place; the
button or Ctrl+Shift+M returns to the editor, which is re-measured. Relative
images resolve through `/api/doc/asset`, the same route as the editor's
`assetResolver`. It is a read-only mode: it never dispatches editor changes, so
autosave, drafts, undo and save-revision behavior are untouched.

## Verification

- `node --test test/mdrender.test.js test/doc-diagrams.test.js test/doc-diagrams-browser.test.js test/document-bundle.test.js test/editor-file-links.test.js test/unwrap.test.js test/conversation-app.test.js`: **58 tests, 58 pass**.
- New unit tests prove the mode switch, live-text source, image resolution rules,
  Ctrl+Shift+M, the missing-host guard, and the mermaid-fence/image behavior of
  `mdRender` (including that search highlighting keeps the fence as code).
- New headless-Chromium test (`test/doc-diagrams-browser.test.js`) boots the real
  server, opens a markdown file, switches to the reading view and requires an
  actual `<svg>` from `/vendor/mermaid.min.js` for a `flowchart LR` **and** a
  nested `stateDiagram-v2`, then checks double-click-to-source, Ctrl+Shift+M back
  to the editor, and zero uncaught page errors.
- Throwaway probe against the operator's real
  `_System/docs/project/flow-views.md`: **15/15 mermaid fences rendered an svg,
  0 errors, 0 pending, no page exceptions**. Probe scratch removed afterwards.

## Boundaries

No vendor bundle was rebuilt, no dependency installed, no service started, no
network fetch, no commit, no push, and nothing registered in AK (the operator
rejected AK registration for this contrib repo). Work left in the working tree of
the `local` branch; the pre-existing untracked link-shim files were not touched.

True Obsidian-style inline live preview (the diagram replacing the fence while
editing) still requires an editor-bundle widget, i.e. the
`mrmd-packages/mrmd-editor` source and `npm run build:document`, or an upstream
acceptance of that feature.
