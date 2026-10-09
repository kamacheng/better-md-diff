// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { DiffPanel } from '../src/panel';
import { DiffStore } from '../src/store';
import { DEFAULT_SETTINGS } from '../src/options';
import { installObsidianDom } from './helpers/obsidian-dom';
import { LocalizedError, setLanguage } from '../src/i18n';
import { prepareChangeRevert } from '../src/revert';
import { selectedDiffText } from '../src/diff-copy';

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
  it('labels display blocks separately from independently actionable changes', async () => {
    await setup();
    expect(Array.from(document.querySelectorAll('.bmd-region-heading')).map(el => el.textContent)).toEqual(['区块 1 · 当前第 1–5 行', '区块 2 · 当前第 18–24 行']);
    expect(document.querySelectorAll('.bmd-diff-region--selected')).toHaveLength(1);
    const row = document.querySelectorAll('.bmd-row-text')[0];
    setLanguage('en');
    expect(document.querySelector('.bmd-region-heading')?.textContent).toBe('Block 1 · Current lines 1–5');
    expect(document.querySelectorAll('.bmd-row-text')[0]).toBe(row);
    const body = document.querySelector<HTMLElement>('.bmd-diff-body')!;
    const range = document.createRange(); range.selectNodeContents(body);
    expect(selectedDiffText(body, range)).not.toContain('Block');
    expect(selectedDiffText(body, range)).toContain('first change');
    panel.move(1);
    expect(document.querySelector('.bmd-diff-region--selected .bmd-region-heading')?.textContent).toContain('Block 2');
  });

  it('updates a cached block heading when its line numbers shift', async () => {
    const { navigate } = await setup();
    const block = document.querySelectorAll('.bmd-diff-region')[1]!;
    await store.refresh('note.md', 'inserted\n' + current);
    expect(document.querySelectorAll('.bmd-diff-region')[1]).toBe(block);
    expect(block.querySelector('.bmd-region-heading')?.textContent).toBe('区块 2 · 当前第 19–25 行');
    block.querySelector<HTMLButtonElement>('.bmd-region-jump')!.click();
    expect(navigate).toHaveBeenLastCalledWith('note.md', 21, false, true);
    setLanguage('en');
    expect(block.querySelector('.bmd-region-jump')?.getAttribute('aria-label')).toContain('Block 2');
  });

  it('uses HEAD line ranges for blocks containing only deleted rows', async () => {
    await setup();
    await store.refresh('deleted.md', '', true, async () => ({ content: 'one\ntwo\nthree\n', head: 'abc', isNew: false }));
    panel.setFile('deleted.md');
    expect(document.querySelector('.bmd-region-heading')?.textContent).toBe('区块 1 · HEAD 第 1–3 行');
    expect(document.querySelector('.bmd-region-heading button')?.getAttribute('type')).toBe('button');
    expect(document.querySelectorAll('.bmd-revert')).toHaveLength(1);
  });

  it.each([true, false])('centers button navigation, respects source following = %s and keeps button focus', async follow => {
    const { settings, navigate } = await setup();
    settings.followNavigation = follow;
    const body = document.querySelector<HTMLElement>('.bmd-diff-body')!;
    Object.defineProperties(body, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 200));
    vi.spyOn(document.querySelectorAll('.bmd-change')[1]!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 220, 400, 60));
    body.scrollTop = 100;
    const button = document.querySelector<HTMLButtonElement>('.bmd-next')!;
    button.focus(); button.click();
    expect(body.scrollTop).toBe(150);
    expect(document.activeElement).toBe(button);
    if (follow) expect(navigate).toHaveBeenCalledWith('note.md', 20, false, true);
    else expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['.bmd-region-jump', true], ['.bmd-region-jump', false],
    ['.bmd-change-title', true], ['.bmd-change-title', false],
  ] as const)('selects and centers %s with source following = %s without taking focus', async (selector, follow) => {
    const { settings, navigate, revert } = await setup();
    settings.followNavigation = follow;
    const state = store.get('note.md');
    const body = document.querySelector<HTMLElement>('.bmd-diff-body')!;
    Object.defineProperties(body, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 200));
    vi.spyOn(document.querySelectorAll('.bmd-change')[1]!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 220, 400, 60));
    body.scrollTop = 100;
    const button = document.querySelectorAll<HTMLButtonElement>(selector)[1]!;
    button.focus(); button.click();
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('2 / 2');
    expect(body.scrollTop).toBe(150);
    expect(document.activeElement).toBe(button);
    expect(document.querySelector('.bmd-diff-region--selected .bmd-region-jump')?.getAttribute('aria-current')).toBe('location');
    if (follow) expect(navigate).toHaveBeenCalledWith('note.md', 20, false, true);
    else expect(navigate).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
    expect(store.get('note.md')).toBe(state);
  });

  it('targets the first change in a shared block, not its context or last selected item', async () => {
    const { navigate } = await setup();
    await store.refresh('nearby.md', 'keep\nA\nkeep\nB\n', true, async () => ({ content: 'keep\na\nkeep\nb\n', head: 'abc', isNew: false }));
    panel.setFile('nearby.md');
    document.querySelectorAll<HTMLButtonElement>('.bmd-change-title')[1]!.click();
    expect(navigate).toHaveBeenLastCalledWith('nearby.md', 3, false, true);
    document.querySelector<HTMLButtonElement>('.bmd-region-jump')!.click();
    expect(navigate).toHaveBeenLastCalledWith('nearby.md', 1, false, true);
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('1 / 2');
  });

  it.each(['added', 'deleted'])('puts the %s-only change jump on its visible line number', async kind => {
    const { navigate } = await setup();
    const withLine = 'keep\nchanged\nend\n', withoutLine = 'keep\nend\n';
    await store.refresh('single.md', kind === 'added' ? withLine : withoutLine, true, async () => ({ content: kind === 'added' ? withoutLine : withLine, head: 'abc', isNew: false }));
    panel.setFile('single.md');
    const button = document.querySelector<HTMLButtonElement>('.bmd-change-title')!;
    expect(button.textContent).toBe('2');
    expect(button.closest('.bmd-row')!.children[kind === 'added' ? 1 : 0]).toBe(button);
    button.click();
    expect(navigate).toHaveBeenCalledWith('single.md', 1, false, true);
  });

  it('keeps body clicks and drag selections separate from navigation', async () => {
    const { navigate, revert } = await setup();
    const code = document.querySelectorAll<HTMLElement>('.bmd-change .bmd-row-text')[2]!;
    const range = document.createRange(); range.selectNodeContents(code);
    const selection = document.getSelection()!; selection.addRange(range);
    code.click();
    expect(selection.toString()).toBe(code.textContent);
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('1 / 2');
    expect(navigate).not.toHaveBeenCalled(); expect(revert).not.toHaveBeenCalled();
  });

  it('disables block and item navigation while a selected stale snapshot awaits refresh', async () => {
    const { navigate } = await setup();
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.bmd-row-text')!);
    document.getSelection()!.addRange(range);
    await store.refresh('note.md', current + 'later\n');
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.bmd-region-jump, .bmd-change-title'))) {
      expect(button.disabled).toBe(true);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    expect(navigate).not.toHaveBeenCalled();
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(document.querySelector<HTMLButtonElement>('.bmd-region-jump')!.disabled).toBe(false);
  });

  it('keeps passive cursor following and refreshes on nearest/no-scroll behavior', async () => {
    await setup();
    const body = document.querySelector<HTMLElement>('.bmd-diff-body')!;
    Object.defineProperties(body, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 200));
    document.querySelectorAll('.bmd-change')[1]!.querySelectorAll('.bmd-row').forEach((row, i) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 150 + i * 20, 400, 20));
    });
    body.scrollTop = 100;
    panel.showLine(20);
    expect(body.scrollTop).toBe(100);
    await store.refresh('note.md', current.replace('first change', 'earlier edit'));
    expect(body.scrollTop).toBe(100);
  });

  it('uses a document addition/deletion icon for the diff tab', async () => {
    await setup();
    expect(panel.getIcon()).toBe('file-diff');
  });

  it('groups compact progress between accessible previous/next icon buttons', async () => {
    await setup();
    const navigation = document.querySelector('.bmd-navigation');
    expect(navigation).not.toBeNull();
    expect(navigation!.getAttribute('role')).toBe('group');
    expect(navigation!.getAttribute('aria-label')).toBe('变更导航');
    expect(Array.from(navigation!.children).map(el => el.className)).toEqual(['bmd-previous bmd-icon-button', 'bmd-progress', 'bmd-next bmd-icon-button']);
    expect(navigation!.querySelector('.bmd-previous')?.getAttribute('aria-label')).toBe('上一处');
    expect(navigation!.querySelector('.bmd-next')?.getAttribute('aria-label')).toBe('下一处');
    expect(navigation!.querySelector('.bmd-progress')?.getAttribute('aria-label')).toBe('第 1 / 2 处');
    expect(navigation!.querySelector('.bmd-next [aria-hidden="true"]')?.getAttribute('data-icon')).toBe('arrow-down');
    expect(document.querySelector('.bmd-summary .bmd-help')).toBeNull();
  });

  it('opens one reading guide outside the sidebar and restores focus without touching the diff', async () => {
    const { navigate, revert } = await setup();
    const state = store.get('note.md');
    const row = document.querySelector('.bmd-row-text');
    const button = document.querySelector<HTMLButtonElement>('.bmd-help-button');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-haspopup')).toBe('dialog');
    button!.focus(); button!.click(); button!.click();
    expect(document.querySelectorAll('.bmd-reading-guide')).toHaveLength(1);
    expect(panel.contentEl.querySelector('.bmd-reading-guide')).toBeNull();
    expect(document.querySelector('.bmd-reading-guide')?.textContent).toContain('深色突出变化字词');
    expect(document.querySelector('.bmd-reading-guide')?.textContent).toContain('Tab');
    document.querySelector<HTMLButtonElement>('.bmd-guide-close')!.focus();
    setLanguage('en');
    expect(document.activeElement).toBe(document.querySelector('.bmd-guide-close'));
    expect(document.querySelector('.bmd-guide-title')?.textContent).toBe('Reading guide');
    expect(document.querySelector('.bmd-reading-guide')?.textContent).toContain('Click a block heading');
    expect(button!.getAttribute('aria-label')).toBe('Reading guide');
    document.querySelector<HTMLButtonElement>('.bmd-guide-close')!.click();
    expect(document.querySelector('.bmd-reading-guide')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(document.querySelector('.bmd-row-text')).toBe(row);
    expect(store.get('note.md')).toBe(state);
    expect(navigate).not.toHaveBeenCalled(); expect(revert).not.toHaveBeenCalled();
  });

  it('uses current display preferences in the guide and closes it on unload', async () => {
    const { settings } = await setup();
    settings.inlineHighlights = false; settings.showWhitespace = false;
    document.querySelector<HTMLButtonElement>('.bmd-help-button')!.click();
    const guide = document.querySelector('.bmd-reading-guide');
    expect(guide?.textContent).not.toContain('深色突出变化字词');
    expect(guide?.textContent).not.toContain('Tab');
    panel.unload();
    expect(document.querySelector('.bmd-reading-guide')).toBeNull();
    setLanguage('en');
    expect(guide?.textContent).toBe('');
  });

  it('provides independent actions and navigation inside one context region', async () => {
    const { revert } = await setup();
    const old = 'a\nkeep\nb\n\nremove\nkeep again\nc\n';
    const text = 'A\nkeep\nB\n\nkeep again\nC\n';
    await store.refresh('nearby.md', text, true, async () => ({ content: old, head: 'abc', isNew: false }));
    panel.setFile('nearby.md');
    expect(document.querySelectorAll('.bmd-diff-region')).toHaveLength(1);
    expect(document.querySelectorAll('.bmd-hunk')).toHaveLength(0);
    expect(document.querySelectorAll('.bmd-change')).toHaveLength(4);
    expect(document.querySelectorAll('.bmd-region-heading')).toHaveLength(1);
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('1 / 4');
    panel.move(1);
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('2 / 4');
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
    expect(navigate).toHaveBeenCalledWith('note.md', 1, false, true);
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
    expect(document.querySelector('.bmd-summary details')).toBeNull();
    expect(document.querySelector('.bmd-file-info')?.parentElement).toBe(document.querySelector('.bmd-summary-heading'));
    expect(document.querySelector('.bmd-stats')?.parentElement).toBe(document.querySelector('.bmd-summary-heading'));
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
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('0 / 0');
    expect(document.querySelector('.bmd-progress')?.getAttribute('aria-label')).toBe('No changes');
    expect(document.querySelector<HTMLButtonElement>('.bmd-next')?.disabled).toBe(true);
  });

  it('switches an open panel to English without replacing source nodes or the selection', async () => {
    await setup();
    const code = document.querySelector('.bmd-row--added .bmd-row-text')!;
    const range = document.createRange(); range.selectNodeContents(code);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    setLanguage('en');
    expect(document.querySelector('.bmd-next')?.getAttribute('aria-label')).toBe('Next');
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('1 / 2');
    expect(document.querySelector('.bmd-progress')?.getAttribute('aria-label')).toBe('Change 1 / 2');
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
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('1 / 2');
    document.querySelector<HTMLButtonElement>('.bmd-next')!.click();
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('2 / 2');
    expect(navigate).toHaveBeenLastCalledWith('note.md', 20, false, true);
    expect(panel.move(1)).toBe(true);
    expect(document.querySelector('.bmd-progress')?.textContent).toBe('1 / 2');
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
