# Better MD Diff

[简体中文](README.md) · **English**

Review Markdown changes against **Git HEAD (the latest commit)** in Obsidian, compare paired old/new lines, and safely restore individual change blocks.

[Community plugin page](https://community.obsidian.md/plugins/better-md-diff) · [Download the latest release](https://github.com/kamacheng/better-md-diff/releases/latest) · [Report an issue](https://github.com/kamacheng/better-md-diff/issues)

## Features

- **Diffs while editing:** Source mode and Live Preview display line backgrounds and `+` / `−` / `~` gutter markers for additions, deletions, and modifications, including unsaved edits.
- **Paired old/new lines:** The panel places corresponding red old lines and green new lines next to each other, with precise word-level highlights. Unpaired additions and deletions remain separate.
- **Two-way navigation:** Moving the source cursor locates both corresponding lines in the panel. Previous/next change buttons can also navigate the source. Each direction has its own switch.
- **Select and copy:** Copy raw Markdown without line numbers, diff signs, or visible-whitespace hints. The panel itself remains read-only.
- **Restore individual blocks:** Each change card has a confirmation-protected restore action that restores that block to HEAD while preserving other changes and editor undo history.
- **Configurable display and refresh:** Adjust font size, context lines, word highlights, whitespace hints, navigation, and refresh timing.
- **Clean Reading view:** Reading view has no inline diff decorations; the side panel remains available for review.

Changed spaces appear as `·` and tabs as `→`. These visual hints are never inserted into the document or copied text. Deleted content is not injected into the source editor.

## Requirements

- Desktop Obsidian **1.8.0+**. Mobile is not supported.
- Git installed locally, with the target Markdown file tracked by Git.
- The plugin interface currently uses **Simplified Chinese**. Documentation is available in Chinese and English.

Host testing has been performed on **Windows / Obsidian 1.13.7**. Other platforms and older versions have not been tested on-device. The Obsidian Git plugin is not required.

## Installation

### Community plugins (recommended)

1. In Obsidian, open **Settings → Community plugins → Browse**.
2. Search for **Better MD Diff**, select **Install**, then enable it.

Alternatively, visit the [official community page](https://community.obsidian.md/plugins/better-md-diff) and select **Add to Obsidian**. Future updates can be checked and installed from Obsidian's Community plugins settings.

### Manual installation (alternative)

1. Open the [latest release](https://github.com/kamacheng/better-md-diff/releases/latest) and download the attached `main.js`, `manifest.json`, and `styles.css`. GitHub's automatically generated Source code archives are not installation packages.
2. Create `plugins/better-md-diff/` inside your vault's configuration directory and place the three files there:

   ```text
   <vault>/.obsidian/plugins/better-md-diff/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```

3. Restart Obsidian and enable **Better MD Diff** under **Settings → Community plugins**.

If you use a custom configuration directory, replace `.obsidian` accordingly. To update, replace only those three files, keep your existing `data.json`, and reload the plugin or restart Obsidian.

## Usage

1. Open a tracked `.md` file and edit it in Source mode or Live Preview.
2. Click a gutter diff marker, the Git diff ribbon icon, or the Git status bar item. You can also run **Better MD Diff: 查看当前文档与 HEAD 的差异** (compare the current document with HEAD), or choose **查看 Git 差异** from a file's context menu.
3. Review the changes. The two line-number columns refer to HEAD and the current content. A pale-blue header identifies the current block; blue side bars and line numbers identify corresponding lines.
4. Use **上一处 / 下一处** (previous/next change), or click a block's title to return to its source location.

Cursor movement never opens the panel automatically or steals editor focus. A selection follows its active cursor end. Lines omitted from the diff navigate to the nearest change. Paired rows are shown together when they fit; very long pairs prioritize the current-side row.

### Copying and restoring

- **Reuse part of the old text:** Select text from a red old line and copy it. Multiline selections follow display order. Selecting both old and new rows copies both versions.
- **Restore a complete change:** Click **还原此处** (restore this block), review the affected line counts, and confirm. Nearby changes may be grouped in one card depending on the context-line setting.
- **Undo a restoration:** Press **Ctrl/Cmd+Z in the source editor**. Subsequent typing or formatting by another plugin may create additional undo steps.

Restoration requires the target document to be visible in Source mode or Live Preview; it does not open files or switch Reading view automatically. If the document, mode, or HEAD changes during confirmation, the operation is rejected. Cancelling the dialog or unloading the plugin aborts restoration that has not yet been applied.

**Restoration changes the editor buffer, not the Git index.** It does not stage, commit, reset, push, or delete files. Restoring a newly tracked file against an empty baseline can leave an empty document. Obsidian remains responsible for saving. Commit or back up important work first.

## Settings

Open **Settings → Better MD Diff**:

| Group | Option | Default / range |
| --- | --- | --- |
| Display | Source editor diff markers | On |
| Display | Panel font size | 13 px / 10–22 px |
| Display | Context lines | 3 / 0–10 lines |
| Display | Word highlights and visible-whitespace hints | Both on |
| Navigation | Source-to-panel and previous/next-to-source navigation | Both on; independent switches |
| Refresh | Delay after editing | 350 ms / 100–2000 ms |
| Refresh | Git polling interval | 5 seconds / 2–60 seconds |
| Git | Executable path | `git` |

The baseline is fixed to **HEAD**; selecting historical commits is not yet supported. Restoration confirmation and freshness checks cannot be disabled. Returning to the application or clicking Refresh also checks the baseline.

If Git cannot be found on Windows, specify a path such as `C:\Program Files\Git\cmd\git.exe`, without quotes or command-line arguments. Assign command shortcuts through Obsidian's Hotkeys settings.

## Comparison rules and limitations

- Compares **HEAD → current editor content**, including staged and unstaged changes. This is not an index-versus-working-tree comparison.
- Untracked files prompt you to run `git add` first. The plugin does not add files automatically.
- Tracked files absent from HEAD use an empty baseline, including repositories without an initial commit.
- CRLF/LF differences are normalized; other whitespace and final-newline changes are retained. Deletions navigate to the following line, or the end of the document.
- Renamed paths do not follow previous filenames. There is no deleted-file list, move detection, or independent scanning of embedded notes.
- Hidden properties, folded content, or empty documents may lack visible source markers; raw changes remain available in the panel.
- Each version is limited to **2 MiB / 20,000 lines**. Line diff calculation has a 200 ms timeout; each Git operation has an 8-second timeout.
- Large replacements or word-level refinement exceeding its time budget fall back to line-level highlighting without discarding changes.
- Missing Git, permission errors, unresolved conflicts, and unsupported objects show an explanation. Symlinks and binary files are not supported.

### Why do extra whitespace changes appear after saving?

Formatting plugins can change the actual text when saving or switching files. For example, Linter's **Two Spaces Between Lines with Content** rule adds two trailing spaces for Markdown hard line breaks.

These are real changes, displayed as `··`. Configure your formatter as needed. Better MD Diff does not modify other plugins' settings or silently ignore whitespace that can affect Markdown semantics.

## Privacy and file access

- No telemetry, ads, required accounts, or online services. The plugin does not install or update itself or its dependencies.
- Calls local Git to read HEAD, tracking status, and repository information. It does not run network synchronization commands.
- If the vault belongs to a larger Git repository or uses a Git worktree, Git may read **repository metadata and objects outside the vault directory** to locate the correct baseline.
- Reads note content through Obsidian APIs. Only a confirmed restoration modifies the target document through the editor API. The plugin does not upload notes.

## Development and releases

Use Node.js **22.12+ (22.x) or 24+**:

```bash
npm ci
npm run dev       # Watch and build
npm run check     # Tests, type checking, build, and release-file validation
```

Build output is written to root `main.js` and `dist/better-md-diff/`; both can be regenerated. Obsidian and CodeMirror are provided by the host rather than bundled as a second editor instance.

[GitHub Actions](https://github.com/kamacheng/better-md-diff/actions/workflows/ci.yml) runs `npm run check` on Windows, macOS, and Linux with both Node.js 22 and 24. Automated tests use temporary Git repositories, not real note repositories. Use a separate test vault for manual restoration, saving, and undo checks to avoid interference from other plugins' automatic formatting.

Before releasing, update `package.json`, `package-lock.json`, `manifest.json`, and `versions.json` consistently. The release tag must exactly match the manifest version, such as **`0.2.0`**, without a `v` prefix. Attach `main.js`, `manifest.json`, and `styles.css` to the release.

Keep the source project outside your vault. The installed plugin directory should contain only `main.js`, `manifest.json`, `styles.css`, and any existing `data.json`. Do not copy `src/`, `tests/`, or `node_modules/` into that directory.

Dependencies, user configuration, notes, temporary test vaults, and generated bundles are excluded from the source repository.

## License

[MIT](LICENSE). The bundled [jsdiff / diff](https://github.com/kpdecker/jsdiff) dependency uses BSD-3-Clause. Its full notice and this project's MIT license are retained in the generated `main.js`.
