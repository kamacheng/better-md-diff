// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { DiffPanel } from '../src/panel';
import { DiffStore } from '../src/store';
import { DEFAULT_SETTINGS } from '../src/options';
import { installObsidianDom } from './helpers/obsidian-dom';
import { LocalizedError, setLanguage } from '../src/i18n';
import { prepareChangeRevert } from '../src/revert';

installObsidianDom(document);
let panel: DiffPanel;
let store: DiffStore;
afterEach(() => { panel?.unload(); store?.dispose(); setLanguage('zh-CN'); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });
const before = Array.from({ length: 24 }, (_, i) => `line ${i}\n`).join('');
const current = before.replace('line 1\n', 'first change\n').replace('line 20\n', 'last change\n');
async function setup(refresh = async () => {}) {
  store = new DiffStore(async () => ({ content: before, head: 'abc', isNew: false }));
  await store.refresh('note.md', current);
  const settings = { ...DEFAULT_SETTINGS };
  const navigate = vi.fn(), revert = vi.fn();
  panel = new DiffPanel({} as WorkspaceLeaf, { store, settings: () => settings, currentPath: () => 'note.md', refresh, navigate, revert });
  document.body.append(panel.contentEl);
  await panel.onOpen();
  return { settings, navigate, revert };
}

describe('diff panel integration', () => {
  it('provides independent actions and navigation inside one context region', async () => {
    const { revert } = await setup();
    const old = 'a\nkeep\nb\n\nremove\nkeep again\nc\n';
    const text = 'A\nkeep\nB\n\nkeep again\nC\n';
    await store.refresh('nearby.md', text, true, async () => ({ content: old, head: 'abc', isNew: false }));
    panel.setFile('nearby.md');
    expect(document.querySelectorAll('.bmd-diff-region')).toHaveLength(1);
    expect(document.querySelectorAll('.bmd-hunk')).toHaveLength(0);
    expect(document.querySelectorAll('.bmd-change')).toHaveLength(4);
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('第 1 / 4 处');
    panel.move(1);
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('第 2 / 4 处');
    document.querySelectorAll<HTMLButtonElement>('.bmd-revert')[1]!.click();
    const [state, change] = revert.mock.calls[0]!;
    const edits = prepareChangeRevert(state, change, text, state.baseline);
    expect(edits).toHaveLength(1);
    const edit = edits[0]!;
    expect(text.slice(0, edit.from) + edit.text + text.slice(edit.to)).toBe('A\nkeep\nb\n\nkeep again\nC\n');
    panel.move(1);
    expect(document.querySelector('.bmd-row--current')?.getAttribute('data-old-line')).toBe('5');
    expect(document.querySelector('.bmd-row--current')?.classList.contains('bmd-row--deleted')).toBe(true);
  });

  it('keeps old/new rows adjacent without action headings and makes the line number navigable', async () => {
    const { navigate } = await setup();
    const item = document.querySelector('.bmd-change')!;
    expect(item.querySelector('.bmd-change-actions')).toBeNull();
    const rows = Array.from(item.querySelectorAll('.bmd-row'));
    expect(rows.map((row) => row.getAttribute('data-old-line'))).toEqual(['2', '']);
    expect(rows.map((row) => row.getAttribute('data-new-line'))).toEqual(['', '2']);
    const jump = item.querySelector<HTMLButtonElement>('.bmd-change-title')!;
    expect(jump.closest('.bmd-row')).toBe(rows[0]);
    expect(jump.textContent).toBe('2');
    expect(jump.getAttribute('aria-label')).toContain('定位第 1 项');
    jump.click();
    expect(navigate).toHaveBeenCalledWith('note.md', 1);
    const revert = item.querySelector<HTMLButtonElement>('.bmd-revert')!;
    expect(revert.textContent).toBe('');
    expect(revert.title).toBe('还原第 1 项：当前第 2 行');
    expect(revert.querySelector('[aria-hidden="true"]')?.getAttribute('data-icon')).toBe('undo-2');
  });

  it('targets deleted text instead of the following context when opened from its gutter marker', async () => {
    await setup();
    await store.refresh('deleted.md', 'one\ntwo\n', true, async () => ({ content: 'one\nremoved\ntwo\n', head: 'abc', isNew: false }));
    panel.setFile('deleted.md');
    panel.showLine(1, true, true);
    const selected = document.querySelector('.bmd-row--current')!;
    expect(selected.classList.contains('bmd-row--deleted')).toBe(true);
    expect(selected.querySelector('.bmd-row-text')?.textContent).toBe('removed');
  });

  it('separates the note name and directory and keeps the full path available', async () => {
    await setup();
    const path = '策划/修订/2026-09-18/赛季与段位-修订.md';
    await store.refresh(path, current);
    panel.setFile(path);
    expect(document.querySelector('.bmd-file')?.textContent).toBe('赛季与段位-修订.md');
    expect(document.querySelector('.bmd-directory')?.textContent).toBe('策划 / 修订 / 2026-09-18');
    expect(document.querySelector('.bmd-file-info')?.getAttribute('title')).toBe(path);
    expect(document.querySelector('.bmd-ref')?.textContent).toBe('abc');
    const help = document.querySelector<HTMLDetailsElement>('.bmd-help')!;
    expect(help.open).toBe(false);
    help.open = true;
    await store.refresh(path, current + 'one more line\n');
    expect(document.querySelector<HTMLDetailsElement>('.bmd-help')?.open).toBe(true);
  });

  it('shows a localized clean state without zero-count badges', async () => {
    await setup();
    await store.refresh('note.md', before);
    expect(document.querySelector('.bmd-stats')).toBeNull();
    expect(document.querySelector('.bmd-empty-title')?.textContent).toBe('与 HEAD 一致');
    expect(document.querySelector('.bmd-empty-description')?.textContent).toContain('继续编辑');
    expect(document.querySelector('.bmd-empty-icon')?.getAttribute('aria-hidden')).toBe('true');
    setLanguage('en');
    expect(document.querySelector('.bmd-empty-title')?.textContent).toBe('Matches HEAD');
    expect(document.querySelectorAll('.bmd-empty')).toHaveLength(1);
    expect(document.querySelector<HTMLButtonElement>('.bmd-next')?.disabled).toBe(true);
  });

  it('switches an open panel to English without replacing source nodes or the selection', async () => {
    await setup();
    const code = document.querySelector('.bmd-row--added .bmd-row-text')!;
    const range = document.createRange(); range.selectNodeContents(code);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    setLanguage('en');
    expect(document.querySelector('.bmd-next')?.textContent).toBe('Next');
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('Change 1 / 2');
    expect(document.querySelector('.bmd-revert')?.getAttribute('aria-label')).toBe('Restore change 1: Current line 2');
    expect(document.querySelector('.bmd-revert')?.getAttribute('title')).toBe('Restore change 1: Current line 2');
    expect(document.querySelector('.bmd-row--added .bmd-row-text')).toBe(code);
    expect(code.querySelector('mark')?.title).toBe('Added text');
    expect(document.getSelection()!.toString()).toBe('first change');
  });

  it('translates an already cached error without another Git read', async () => {
    await setup();
    await store.refresh('note.md', current, true, async () => { throw new LocalizedError('读取 Git 失败，请刷新重试。'); });
    setLanguage('en');
    expect(document.querySelector('.bmd-message')?.textContent).toBe('Failed to read Git. Refresh and try again.');
  });

  it('preserves source nodes, selection and focus on presentation-only updates', async () => {
    const { settings } = await setup();
    const code = document.querySelector('.bmd-row-text')!;
    const button = document.querySelector<HTMLButtonElement>('.bmd-revert')!;
    button.focus();
    const range = document.createRange(); range.selectNodeContents(code);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    expect(document.getSelection()!.toString()).toBe('line 0');
    settings.fontSize = 18; store.updatePresentation(3);
    expect(document.querySelector('.bmd-row-text')).toBe(code);
    expect(document.activeElement).toBe(button);
    expect(document.getSelection()!.toString()).toBe('line 0');
  });

  it('retains unchanged cards and refreshes their revert snapshot after another card changes', async () => {
    const { revert } = await setup();
    const card = document.querySelectorAll('.bmd-change')[1]!;
    const button = card.querySelector<HTMLButtonElement>('.bmd-revert')!;
    button.focus();
    await store.refresh('note.md', current.replace('first change', 'earlier edit'));
    expect(document.querySelectorAll('.bmd-change')[1]).toBe(card);
    expect(document.activeElement).toBe(button);
    button.click();
    expect(revert.mock.calls[0]?.[0].current).toContain('earlier edit');
  });

  it('shows progress and navigates without taking source focus', async () => {
    const { navigate } = await setup();
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('第 1 / 2 处');
    document.querySelector<HTMLButtonElement>('.bmd-next')!.click();
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('第 2 / 2 处');
    expect(navigate).toHaveBeenLastCalledWith('note.md', 20, false);
    expect(panel.move(1)).toBe(true);
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('第 1 / 2 处');
  });

  it('defers changed content while copying, then renders after the selection collapses', async () => {
    await setup();
    const code = document.querySelector('.bmd-row--added .bmd-row-text')!;
    const range = document.createRange(); range.selectNodeContents(code);
    document.getSelection()!.addRange(range);
    await store.refresh('note.md', current.replace('first change', 'typed later'));
    expect(code.isConnected).toBe(true);
    expect(document.getSelection()!.toString()).toBe('first change');
    document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
    expect(document.querySelector('.bmd-row--added .bmd-row-text')?.textContent).toBe('typed later');
  });

  it('shows refresh activity, coalesces clicks, and clears it when the request completes', async () => {
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    await setup(refresh);
    const button = document.querySelector<HTMLButtonElement>('.bmd-refresh')!;
    button.click(); button.click();
    expect(button.textContent).toBe('刷新中…');
    expect(button.disabled).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    resolve(); await Promise.resolve(); await Promise.resolve();
    expect(button.textContent).toBe('刷新');
    expect(button.disabled).toBe(false);
  });
});
