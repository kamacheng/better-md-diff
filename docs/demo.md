# Obsidian demo

![Better MD Diff in Obsidian: edit, inspect a deletion, restore one change, and undo](images/obsidian-demo.gif)

[Static preview](images/obsidian-demo.png) · [GIF file](images/obsidian-demo.gif)

This English-only GIF records the **real plugin in desktop Obsidian**, not a browser imitation. There is no separate interactive demo page. The recording uses a newly generated vault, an independent app profile, and a real local Git repository. It does not use personal notes or an existing Obsidian profile.

## What it shows

1. Replace **universally** with **widely** in the editor. The panel identifies the precise text change.
2. Click the red **−1** deletion marker to locate **“Mr. Bennet replied that he had not.”** in the old text.
3. Review the native confirmation dialog and restore only that deletion. The word edit and added reading note remain.
4. Press **Ctrl+Z** in the editor to undo the restoration. Git HEAD and the index remain unchanged.

The omitted sentence and added note are prepared before capture. The word edit, deletion navigation, confirmation, restoration and native undo happen during the continuous recording. The source editor, diff panel and confirmation dialog are unmodified production UI; only supported display settings and the test workspace size are adjusted.

## Text and attribution

**Jane Austen, _Pride and Prejudice_ (1813), Chapter I.**

- [Source text, Chapter I](https://www.gutenberg.org/files/1342/1342-h/1342-h.htm#Chapter_I)
- [Bibliographic and public-domain status](https://www.gutenberg.org/ebooks/1342)
- [The excerpt used in the recording](../scripts/fixtures/pride-and-prejudice.md)

Project Gutenberg identifies this work as public domain in the USA. Only Austen’s opening text is used, not the edition’s illustrations or editorial material. A Markdown heading and line breaks are added for display, and the opening small-cap “IT” is normalized to “It”.

The **HEAD version contains the original wording** of the excerpt. “Widely”, the omitted reply, and the blockquoted reading note are deliberate demonstration edits, not Austen’s original text or a claim to improve it.

## Reproduce

Tested on Windows. Requirements: Node.js/Git and the project dependencies, an installed desktop Obsidian executable, Python 3.10+ with **Playwright** and **Pillow 10.1+**, and **FFmpeg**. Playwright connects to the owned Obsidian process; no separate Chromium download is needed.

```bash
npm ci
npm run build
python -m pip install playwright "Pillow>=10.1"
python scripts/record-demo.py --executable "C:/Users/YOU/AppData/Local/Obsidian/Obsidian.exe"
```

FFmpeg is resolved from `PATH`, or supplied with `--ffmpeg "/path/to/ffmpeg"`. The script always creates a fresh `.test-vault/demo-*/` directory and checks its vault identity before accessing note content. It commits only the generated excerpt in that temporary repository; it never commits or pushes this project. The owned app process is stopped on completion or failure.

Outputs:

- `docs/images/obsidian-demo.gif` — approximately 23 seconds, 1120 × 848, 8 fps, approximately 0.6 MiB; exact size/timing can vary between runs.
- `docs/images/obsidian-demo.png` — static preview from the same capture.
- `.test-vault/demo-*/report.json` — assertions, baseline identity, build hashes and media dimensions.
- `.test-vault/demo-*/raw/` and `frames.json` — original host frames and capture timestamps.
- `.test-vault/demo-*/captioned/` — the frames with English captions and click indicators.

The host is captured continuously at approximately eight frames per second, preserving elapsed time; these are not independently staged before/after screenshots. Captions and brief click rings are composited onto those frames. No note text, diff result or app control is painted into the recording. Source frames and timing evidence remain available for inspection. The script uses no external content in the scene, although Obsidian itself may perform its normal startup update checks.

Generation checks real editor content after each operation and confirms that HEAD and the Git index are unchanged. Existing published media is replaced only after the recording checks and GIF encoding pass. This demonstrates the current local build, not proof that it has been published to the community plugin catalog.

## Live Preview layout regression

The personal branch also has a geometry regression test. It creates an isolated Live Preview vault and samples the real editor on animation frames during typing, an external file update, and cursor navigation. It requires Python 3.10+ and Playwright, but not Pillow or FFmpeg.

```bash
npm run build
python scripts/check-editor-stability.py --executable "C:/Users/YOU/AppData/Local/Obsidian/Obsidian.exe"
python scripts/check-editor-stability.py --executable "C:/Users/YOU/AppData/Local/Obsidian/Obsidian.exe" --long-document
python scripts/check-editor-stability.py --executable "C:/Users/YOU/AppData/Local/Obsidian/Obsidian.exe" --deletion-count 1000
```

Before the fix, even a four-line baseline reproduced a **14px** change in source width and left edge when typing: the gutter occupied 18px without a deletion badge and 32px with one. Controls with `--condition no-markers` or `--condition disabled` measured 0px; `--condition no-follow` still measured 14px. The long-document fixture reproduced the same width change. These measurements did not reproduce a vertical cursor jump.

The gutter now reserves 32px throughout refreshes. Badge widths are bounded; large counts can be visually ellipsized, while their full count remains in the existing tooltip and accessible name. This avoids resizing the source without retaining stale interactive markers, delaying updates, or overriding native scrolling.

The regression checks source width/left-edge stability within 1px, plus current-row stability for the short-text input and external replacement. Cursor navigation deliberately allows vertical movement. It also waits for the diff to match the editor, verifies the intended text changes, and checks the full deletion label. External updates occur after an awaited editor save, so this is not a simultaneous unsaved-edit/AI-write conflict test.

The short, long, and 1000-line-deletion fixtures measured 0px source-width/left-edge changes after the fix. Real-host English and Chinese smoke tests also passed, including restoration, native undo, deletion navigation, and light/dark narrow-panel layouts. This does **not** establish that all Live Preview height changes are fixed: tables, lists, folds, images, other themes/plugins, and structural edits may need separate reproduction.

Evidence is written to ignored `.test-vault/stability-*/report.json`, `before.png`, and `after.png`. The script commits only its generated baseline in the temporary Git repository, never this project, and cleans up its owned host process. It does not install into a real vault or replace the published demo media.

## Personal compact-panel checks

The personal branch now groups navigation as **↑ 1 / 2 ↓**, puts statistics beside the filename, and moves the reading guide to a `?` button opening a native Obsidian dialog. The summary has a single divider rather than a framed card. Diff lines have softer backgrounds and more line spacing; existing font-size preferences, changed-word emphasis, source copying and restoration safeguards remain intact. No changes are filtered or automatically folded. The tab, ribbon and file-menu entry share the built-in `file-diff` document-plus/minus icon.

```bash
npm run check
PYTHONIOENCODING=utf-8 python scripts/host-smoke.py --executable "C:/Users/YOU/AppData/Local/Obsidian/Obsidian.exe" --language en
PYTHONIOENCODING=utf-8 python scripts/host-smoke.py --executable "C:/Users/YOU/AppData/Local/Obsidian/Obsidian.exe" --language zh
```

Latest local evidence: **217 automated tests**, **36 host checks per language**, **36 Chromium whitespace-layout cases**, and the long-document Live Preview stability regression passed. Reports are in `.test-vault/host-wnserqf1/` (English), `.test-vault/host-zvxtmovc/` (Chinese), `.test-vault/whitespace-3i3h8w2n/`, and `.test-vault/stability-ywhntwl2/`. These are generated fixtures, not personal notes.

The smoke test verifies all three icon placements, keyboard order and visible focus, guide close/Escape/focus return, pane cleanup, source copying, restoration/cancel/undo, and 280/440px layouts in both default themes. The ordinary change fixture has a 117.5px header; long names retain their full path in the tooltip, and scrolling the diff leaves the header in place. The stability fixture again measured 0px source-width/left-edge changes during typing and an external update. Larger font settings, custom themes and other plugins are not covered by this layout measurement.

### Block boundaries and active navigation

Each display block now has a complete 1px border, a 6px corner radius, a separate heading bar and a 20px gap from the next block. The heading identifies its context range (current lines, or HEAD lines for deletion-only content); the selected block uses the theme accent. These are reading groups, not new action scopes: seven independent changes remain seven actions even when two share one of six display blocks. Nothing is folded or filtered, and copying across headings still produces only source rows.

Previous/next navigation centers the selected **change**, including its old/new rows when they fit. Oversized changes reveal their beginning with an 8px inset; first/last changes use natural scroll limits without added padding. Source centering follows the existing navigation preference and preserves source/Live Preview/reading mode. Disabling that preference leaves the source scroll position unchanged, and navigation retains button focus. Passive cursor following, input and refresh do not request centering.

Block headings are native keyboard-accessible buttons: clicking a heading selects its first change, while clicking a change's line-number button selects that specific item. Both share the previous/next centering path, respect source linkage and preserve button focus. Body clicks and text selections do not activate navigation. Stale headings and line-number controls are disabled while a selected snapshot awaits refresh; cached headings use updated line coordinates. The settings label and reading guide describe these navigation controls. Pure additions now place their jump button on the visible current-side line number rather than the empty HEAD column.

The real-host fixture covers heading clicks and keyboard activation, line-number clicks, body double-click selection, nearby changes, pure deletion, first/last changes, repeated clicks, source-link toggling, oversized changes and cross-block copying. Diff/source-editor center errors were at most 0.5px in the regular fixture; reading-mode positions use the host's source-line boundary, with a measured maximum paragraph-center deviation of about 19.1px for the deletion anchor.

Reading-mode checks wait for native preview layout readiness: `setViewState` can resolve before the host computes/restores that layout. Earlier immediate mode-switch runs showed displaced scroll positions and are not counted as passes. Final checks establish navigation after rendering, not a guarantee for navigation concurrent with mode switching. Private renderer fields are inspected only by the test harness; the plugin uses the host navigation API without forced recentering timers or renderer patches.

Popout help is checked with an explicit window `focus` event: CDP foregrounding alone did not activate Obsidian's target window. The test does not overwrite `activeWindow` or modify plugin behavior to force the result. Popout checks run last because closing the CDP window mid-run produced stale host leaves/IPC errors and a timeout; final process cleanup owns both test windows. This verifies help in an activated popout, not native OS window-manager focus or close behavior. Failed/timed-out exploratory runs are not counted as passes.

### Whitespace decoration overflow

Long changed space runs previously used one absolutely positioned pseudo-element containing all their dots. That overlay wrapped independently of the source, allowing columns of dots to extend below their row/block. Preventing overlay wrapping alone merely changed this into horizontal overflow. This was reproduced using the real renderer and stylesheet in standalone Chromium, without an Obsidian theme or formatting plugin.

Spaces now paint dots on their own inline fragments; changed whitespace uses `break-spaces` so long runs wrap within the row. Tabs retain a single, non-wrapping arrow. No source characters are removed, no content is clipped/filtered, and toggling whitespace markers does not change row geometry. Original spaces/tabs remain intact in copied Markdown. This fixes decoration layout, not the previously withdrawn table-formatting classification problem.

```bash
PYTHONIOENCODING=utf-8 python scripts/check-whitespace-layout.py
```

This regression requires Python Playwright with Chromium installed. It bundles the actual renderer with the existing test-only DOM shim, loads the project stylesheet, and checks real pseudo-element/inline-fragment geometry across 280/440/480px widths, 13/18px fonts, Chinese text, tabs and up to 50,000 consecutive spaces. The host smoke test additionally checks generated table padding, exact source copying and the bottom of the final block; screenshots are saved as `whitespace-end.png`.

The published GIF above predates this personal layout and has not been regenerated. No real vault installation, version bump or publication was performed. The user subsequently authorized a checkpoint commit and push of the personal branch, not a main-branch merge, tag or release.
