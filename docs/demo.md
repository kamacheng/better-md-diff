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
