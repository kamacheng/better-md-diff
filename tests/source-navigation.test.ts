import { describe, expect, it, vi } from 'vitest';
import type { MarkdownView, WorkspaceLeaf } from 'obsidian';
import { revealSourceLine } from '../src/source-navigation';

function setup(mode: 'source' | 'preview', content = 'first\n第二行\nlast\n') {
  const setEphemeralState = vi.fn(), scrollIntoView = vi.fn();
  const leaf = { setEphemeralState } as unknown as WorkspaceLeaf;
  const view = { getMode: () => mode, getViewData: () => content, editor: { scrollIntoView } } as unknown as MarkdownView;
  return { leaf, view, setEphemeralState, scrollIntoView };
}

describe('source navigation through host APIs', () => {
  it('centers the editor anchor without requesting focus or writing content', () => {
    const { leaf, view, setEphemeralState, scrollIntoView } = setup('source');
    revealSourceLine(leaf, view, 1, true);
    expect(setEphemeralState).toHaveBeenCalledWith({ line: 1 });
    expect(scrollIntoView).toHaveBeenCalledWith({ from: { line: 1, ch: 0 }, to: { line: 1, ch: 0 } }, true);
  });

  it('uses host match navigation to center rendered Markdown without switching modes', () => {
    const content = '😀 first\r\n第二行\r\nlast';
    const { leaf, view, setEphemeralState, scrollIntoView } = setup('preview', content);
    revealSourceLine(leaf, view, 1, true);
    const offset = content.indexOf('第二行');
    expect(setEphemeralState).toHaveBeenCalledWith({ match: { content, matches: [[offset, offset]] } });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it.each(['source', 'preview'] as const)('retains ordinary line navigation in %s', mode => {
    const { leaf, view, setEphemeralState, scrollIntoView } = setup(mode);
    revealSourceLine(leaf, view, 1);
    expect(setEphemeralState).toHaveBeenCalledWith({ line: 1 });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([['', 20, 0], ['one\ntwo', 20, 4], ['one\ntwo', -1, 0]])('clamps deletion anchors at document bounds', (content, line, offset) => {
    const { leaf, view, setEphemeralState } = setup('preview', content);
    revealSourceLine(leaf, view, line, true);
    expect(setEphemeralState).toHaveBeenCalledWith({ match: { content, matches: [[offset, offset]] } });
  });
});
