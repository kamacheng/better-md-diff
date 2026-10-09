import type { MarkdownView, WorkspaceLeaf } from 'obsidian';

/** Use host navigation, preserving the view's mode and the navigation button's focus. */
export function revealSourceLine(leaf: WorkspaceLeaf, view: MarkdownView, line: number, center = false): void {
  const content = view.getViewData();
  const lines = content.split('\n');
  const target = Math.max(0, Math.min(line, lines.length - 1));
  if (center && view.getMode() === 'preview') {
    // The host centers match locations in rendered Markdown; line-only navigation aligns the top.
    // An empty match identifies the source boundary without selecting or replacing any text.
    const offset = target ? lines.slice(0, target).join('\n').length + 1 : 0;
    leaf.setEphemeralState({ match: { content, matches: [[offset, offset]] } });
  } else {
    leaf.setEphemeralState({ line: target });
    if (center) {
      const position = { line: target, ch: 0 };
      view.editor.scrollIntoView({ from: position, to: position }, true);
    }
  }
}
