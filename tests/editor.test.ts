// @vitest-environment jsdom
import { EditorState, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorDiffExtension } from '../src/editor';
import { DiffStore } from '../src/store';
import { installObsidianDom } from './helpers/obsidian-dom';

installObsidianDom(document);

let view: EditorView | undefined;
let store: DiffStore;
afterEach(() => { view?.destroy(); view = undefined; store?.dispose(); document.body.replaceChildren(); });

async function setup(before: string, after: string, extensions: Extension[] = []) {
  store = new DiffStore(async () => ({ content: before, head: 'abc', isNew: false }));
  await store.refresh('note.md', after);
  const open = vi.fn();
  const select = vi.fn();
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: after, extensions: [...extensions, editorDiffExtension({ store, getPath: () => 'note.md', enabled: () => true, open, select })] }),
  });
  return { open, select };
}

describe('CodeMirror source and live-preview extension', () => {
  it('adds an accessible range flag without decorating or changing source text', async () => {
    const { open } = await setup('old\n', 'new\n');
    expect(document.querySelector('.cm-line.bmd-line--modified')).toBeNull();
    const button = document.querySelector<HTMLButtonElement>('.bmd-gutter-marker--modified');
    expect(button?.textContent).toBe('~1');
    expect(button?.getAttribute('aria-label')).toContain('修改当前 1 行');
    button?.click();
    expect(open).toHaveBeenCalledWith('note.md', 0, false);
    expect(view?.state.doc.toString()).toBe('new\n');
  });

  it('clears stale decorations immediately on edits and restores on refresh', async () => {
    await setup('old\n', 'new\n');
    view!.dispatch({ changes: { from: 0, to: 3, insert: 'latest' } });
    expect(document.querySelector('.bmd-gutter-range')).toBeNull();
    await store.refresh('note.md', 'latest\n');
    await Promise.resolve();
    expect(document.querySelector('.bmd-gutter-marker--modified')).not.toBeNull();
  });

  it.each(['', 'keep\n'])('marks a deletion boundary with its count, without inserting content: %j', async (after) => {
    const { open } = await setup(`${after}old 1\nold 2\n`, after);
    expect(document.querySelector('.bmd-line--deleted')).toBeNull();
    expect(document.querySelector('.cm-line.bmd-deletion-anchor')).toBeNull();
    expect(document.querySelectorAll('.bmd-gutter-range--deleted')).toHaveLength(1);
    const marker = document.querySelector<HTMLButtonElement>('.bmd-gutter-marker--deleted')!;
    expect(marker.textContent).toBe('−2');
    expect(marker.getAttribute('aria-label')).toContain('已删除 2 行');
    marker.click();
    expect(open).toHaveBeenCalledWith('note.md', after ? 1 : 0, true);
    expect(view?.state.doc.toString()).toBe(after);
  });

  it('marks the boundary before unchanged text rather than treating that text as deleted', async () => {
    await setup('before\nremoved\nfollowing\n', 'before\nfollowing\n');
    expect(document.querySelector('.cm-line.bmd-deletion-anchor')).toBeNull();
    expect(document.querySelector('.bmd-gutter-range--deleted .bmd-gutter-marker')?.textContent).toBe('−1');
    expect(view?.state.doc.toString()).toBe('before\nfollowing\n');
  });

  it('shows one counted flag and a connected range for consecutive added lines', async () => {
    const { open } = await setup('keep\nend\n', 'keep\nadd 1\nadd 2\nadd 3\nend\n');
    const flags = document.querySelectorAll<HTMLButtonElement>('.bmd-gutter-marker--added');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.textContent).toBe('+3');
    const range = Array.from(document.querySelectorAll('.bmd-gutter-range--added'));
    expect(range).toHaveLength(3);
    expect(range[0]!.classList.contains('bmd-gutter-range--start')).toBe(true);
    expect(range[1]!.querySelector('button')).toBeNull();
    expect(range[2]!.classList.contains('bmd-gutter-range--end')).toBe(true);
    flags[0]!.click();
    expect(open).toHaveBeenCalledWith('note.md', 1, false);
    expect(view!.state.doc.toString()).toBe('keep\nadd 1\nadd 2\nadd 3\nend\n');
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
    expect(document.querySelectorAll('.bmd-gutter-marker--modified')).toHaveLength(1);
    expect(document.querySelector('.bmd-gutter-range--block')?.textContent).toBe('~1');
  });

  it.each([
    { block: true, joinNext: true, labels: ['~1', '+1'], count: 2 },
    { block: false, joinNext: false, labels: ['~1', '+1'], count: 2 },
    { block: false, joinNext: true, labels: ['~1'], count: 3 },
  ])('labels rendered/folded changes without merging counts (block=$block, joinNext=$joinNext)', async ({ block, joinNext, labels, count }) => {
    const before = 'old first\nkeep\nold last\nlast keep\noutside\n';
    const after = 'new first\nkeep\nnew last\nlast keep\nadded\noutside\n';
    class Rendered extends WidgetType {
      toDOM(): HTMLElement { const el = document.createElement('span'); el.textContent = 'Rendered block'; return el; }
    }
    const replacement = StateField.define({
      create: () => Decoration.set([Decoration.replace({ widget: new Rendered(), block }).range(0, after.indexOf('added') - (joinNext ? 0 : 1))]),
      update: value => value,
      provide: field => EditorView.decorations.from(field),
    });
    const { open } = await setup(before, after, [replacement]);
    const flags = Array.from(document.querySelectorAll<HTMLButtonElement>('.bmd-gutter-marker'));
    expect(flags.map(flag => flag.textContent)).toEqual(labels);
    expect(flags[0]!.title).toContain(`包含 ${count} 项改动`);
    expect(document.querySelectorAll('.bmd-gutter-range--block')).toHaveLength(1);
    flags[0]!.click();
    expect(open).toHaveBeenLastCalledWith('note.md', 0, false);
    if (flags[1]) {
      flags[1].click();
      expect(open).toHaveBeenLastCalledWith('note.md', 4, false);
    }
    expect(view!.state.doc.toString()).toBe(after);
  });

  it('counts modified current lines rather than adding old and new line totals', async () => {
    await setup('keep\nold\nend\n', 'keep\nnew 1\nnew 2\nend\n');
    const flag = document.querySelector('.bmd-gutter-marker--modified')!;
    expect(flag.textContent).toBe('~2');
    expect(flag.getAttribute('aria-label')).toContain('修改当前 2 行（原 1 行）');
    expect(document.querySelectorAll('.bmd-gutter-marker')).toHaveLength(1);
    expect(document.querySelectorAll('.bmd-gutter-range--modified')).toHaveLength(2);
  });

  it('does not join independent additions through an unchanged line', async () => {
    const { open } = await setup('start\nkeep\nend\n', 'start\nfirst\nkeep\nsecond\nend\n');
    const flags = document.querySelectorAll<HTMLButtonElement>('.bmd-gutter-marker--added');
    expect(Array.from(flags, flag => flag.textContent)).toEqual(['+1', '+1']);
    expect(document.querySelectorAll('.bmd-gutter-range--start.bmd-gutter-range--end')).toHaveLength(2);
    flags[1]!.click();
    expect(open).toHaveBeenLastCalledWith('note.md', 3, false);
  });

  it('preserves a focused flag across selection-only editor updates', async () => {
    await setup('old\nkeep\n', 'new\nkeep\n');
    const flag = document.querySelector<HTMLButtonElement>('.bmd-gutter-marker')!;
    flag.focus();
    view!.dispatch({ selection: { anchor: view!.state.doc.line(2).from } });
    expect(document.querySelector('.bmd-gutter-marker')).toBe(flag);
    expect(document.activeElement).toBe(flag);
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
    expect(document.querySelector('.bmd-gutter-range')).toBeNull();
  });
});
