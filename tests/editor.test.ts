// @vitest-environment jsdom
import { EditorState, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorDiffExtension } from '../src/editor';
import { DiffStore } from '../src/store';
import { installObsidianDom } from './helpers/obsidian-dom';

installObsidianDom(document);

let view: EditorView | undefined;
let store: DiffStore;
afterEach(() => { view?.destroy(); view = undefined; store?.dispose(); document.body.replaceChildren(); });

async function setup(before: string, after: string) {
  store = new DiffStore(async () => ({ content: before, head: 'abc', isNew: false }));
  await store.refresh('note.md', after);
  const open = vi.fn();
  const select = vi.fn();
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: after, extensions: [editorDiffExtension({ store, getPath: () => 'note.md', enabled: () => true, open, select })] }),
  });
  return { open, select };
}

describe('CodeMirror source and live-preview extension', () => {
  it('adds line decoration and accessible clickable gutter without changing text', async () => {
    const { open } = await setup('old\n', 'new\n');
    expect(document.querySelector('.bmd-line--modified')).not.toBeNull();
    const button = document.querySelector<HTMLButtonElement>('.bmd-gutter-marker');
    expect(button?.getAttribute('aria-label')).toContain('新增 1 行');
    button?.click();
    expect(open).toHaveBeenCalledWith('note.md', 0, false);
    expect(view?.state.doc.toString()).toBe('new\n');
  });

  it('clears stale decorations immediately on edits and restores on refresh', async () => {
    await setup('old\n', 'new\n');
    view!.dispatch({ changes: { from: 0, to: 3, insert: 'latest' } });
    expect(document.querySelector('.bmd-line--modified')).toBeNull();
    await store.refresh('note.md', 'latest\n');
    await Promise.resolve();
    expect(document.querySelector('.bmd-line--modified')).not.toBeNull();
  });

  it.each(['', 'keep\n'])('marks a deletion boundary with its count, without inserting content: %j', async (after) => {
    const { open } = await setup(`${after}old 1\nold 2\n`, after);
    expect(document.querySelector('.bmd-line--deleted')).toBeNull();
    expect(document.querySelectorAll('.bmd-deletion-anchor')).toHaveLength(1);
    const marker = document.querySelector<HTMLButtonElement>('.bmd-gutter-marker--deleted')!;
    expect(marker.textContent).toBe('−2');
    expect(marker.getAttribute('aria-label')).toContain('已删除 2 行');
    marker.click();
    expect(open).toHaveBeenCalledWith('note.md', after ? 1 : 0, true);
    expect(view?.state.doc.toString()).toBe(after);
  });

  it('marks the boundary before unchanged text rather than treating that text as deleted', async () => {
    await setup('before\nremoved\nfollowing\n', 'before\nfollowing\n');
    const anchor = document.querySelector('.bmd-deletion-anchor')!;
    expect(anchor.textContent).toBe('following');
    expect(anchor.classList.contains('bmd-line--deleted')).toBe(false);
    expect(view?.state.doc.toString()).toBe('before\nfollowing\n');
  });

  it('keeps a gutter marker for replaced Live Preview blocks', async () => {
    store = new DiffStore(async () => ({ content: '| A |\n| - |\n| old |\n', head: 'abc', isNew: false }));
    const after = '| A |\n| - |\n| new |\n';
    await store.refresh('note.md', after);
    class TableWidget extends WidgetType {
      toDOM(): HTMLElement { const el = document.createElement('div'); el.textContent = 'Rendered table'; return el; }
    }
    const block = StateField.define({
      create: () => Decoration.set([Decoration.replace({ widget: new TableWidget(), block: true }).range(0, after.length - 1)]),
      update: (value) => value,
      provide: (field) => EditorView.decorations.from(field),
    });
    view = new EditorView({ parent: document.body, state: EditorState.create({ doc: after, extensions: [block, editorDiffExtension({ store, getPath: () => 'note.md', enabled: () => true, open: vi.fn(), select: vi.fn() })] }) });
    expect(document.querySelector('.bmd-gutter-marker--modified')).not.toBeNull();
  });

  it('follows the selection head without opening the panel or mutating the document', async () => {
    const { open, select } = await setup('one\ntwo\nthree\n', 'one\nchanged\nthree\n');
    vi.spyOn(view!, 'hasFocus', 'get').mockReturnValue(true);
    view!.dispatch({ selection: { anchor: 0, head: view!.state.doc.line(3).from } });
    await Promise.resolve();
    expect(select).toHaveBeenLastCalledWith('note.md', 2);
    expect(open).not.toHaveBeenCalled();
    expect(view!.state.doc.toString()).toBe('one\nchanged\nthree\n');
    view!.dispatch({ selection: { anchor: view!.state.doc.line(3).from, head: 0 } });
    await Promise.resolve();
    expect(select).toHaveBeenLastCalledWith('note.md', 0);
  });

  it('ignores selection changes in unfocused editors', async () => {
    const { select } = await setup('one\ntwo\n', 'one\nchanged\n');
    vi.spyOn(view!, 'hasFocus', 'get').mockReturnValue(false);
    view!.dispatch({ selection: { anchor: view!.state.doc.line(2).from } });
    await Promise.resolve();
    expect(select).not.toHaveBeenCalled();
  });

  it('coalesces rapid selections to the newest cursor position', async () => {
    const { select } = await setup('one\ntwo\nthree\n', 'one\nchanged\nthree\n');
    vi.spyOn(view!, 'hasFocus', 'get').mockReturnValue(true);
    view!.dispatch({ selection: { anchor: view!.state.doc.line(2).from } });
    view!.dispatch({ selection: { anchor: view!.state.doc.line(3).from } });
    await Promise.resolve();
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenLastCalledWith('note.md', 2);
  });

  it('drops queued selection notifications after editor destruction', async () => {
    const { select } = await setup('one\ntwo\n', 'one\nchanged\n');
    vi.spyOn(view!, 'hasFocus', 'get').mockReturnValue(true);
    view!.dispatch({ selection: { anchor: view!.state.doc.line(2).from } });
    view!.destroy(); view = undefined;
    await Promise.resolve();
    expect(select).not.toHaveBeenCalled();
  });

  it('removes decorations when Git becomes unavailable', async () => {
    await setup('old\n', 'new\n');
    store.reportError('note.md', 'Git unavailable');
    await Promise.resolve();
    expect(document.querySelector('.bmd-line')).toBeNull();
  });
});
