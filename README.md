# Better MD Diff

[简体中文](README.zh-CN.md)

Compare Markdown with **Git HEAD (the latest commit)** in Obsidian, highlight changed text, and restore individual changes after confirmation.

![Obsidian demo: edit, inspect a deletion, restore one change, and undo](docs/images/obsidian-demo.gif)

Recorded in Obsidian using a public-domain excerpt from *Pride and Prejudice* with demonstration edits.

## Installation

Requires desktop **Obsidian 1.8.0+** and a local **Git** installation.

Open **Settings → Community plugins → Browse**, search for **Better MD Diff**, install it, and enable it.

## Usage

1. Edit a Git-tracked Markdown note in Source mode or Live Preview.
2. Click a gutter marker or the Git diff ribbon icon to review changes: **red is old text, green is added text**.
3. Click a restore arrow and confirm the preview. Press **Ctrl/Cmd+Z** in the source editor to undo.

A contiguous multi-line replacement is one change. The plugin never stages, commits, or pushes. Back up important notes first.

## License

[MIT](LICENSE). The jsdiff dependency uses BSD-3-Clause; its full license is included in the build.
