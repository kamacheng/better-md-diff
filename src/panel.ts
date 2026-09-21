import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { DiffHunk, DiffRow } from './diff';
import type { DiffStore, ReadyDiffState } from './store';
import type { DiffSettings } from './options';
import { highlightRows, pairDiffRows, renderHighlightedText, type InlineHighlights } from './inline-diff';
import { findDiffLocation, revealDiffRow } from './diff-navigation';
import { selectedDiffText } from './diff-copy';

export const DIFF_VIEW = 'better-md-diff-view';

export interface DiffPanelHost {
  store: DiffStore;
  settings(): DiffSettings;
  currentPath(): string | undefined;
  refresh(path: string): void;
  navigate(path: string, line: number, focus?: boolean): void;
  revert(snapshot: ReadyDiffState, hunk: DiffHunk): void;
}

export class DiffPanel extends ItemView {
  private path?: string;
  private selected = 0;
  private hunks: HTMLElement[] = [];
  private rowElements = new Map<DiffRow, HTMLElement>();
  private rowPairs = new Map<DiffRow, DiffRow>();
  private followedLine?: number;
  private currentRow?: HTMLElement;
  private pairedRow?: HTMLElement;
  private summary!: HTMLElement;
  private body!: HTMLElement;
  private previous!: HTMLButtonElement;
  private next!: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private host: DiffPanelHost) { super(leaf); }
  getViewType(): string { return DIFF_VIEW; }
  getDisplayText(): string { return 'Git 差异'; }
  getIcon(): string { return 'git-compare-arrows'; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('bmd-panel');
    const toolbar = this.contentEl.createDiv({ cls: 'bmd-toolbar' });
    const refresh = toolbar.createEl('button', { text: '刷新', attr: { type: 'button', 'aria-label': '重新读取 HEAD 并刷新差异' } });
    refresh.addEventListener('click', () => { if (this.path) this.host.refresh(this.path); });
    this.previous = toolbar.createEl('button', { text: '上一处', attr: { type: 'button' } });
    this.next = toolbar.createEl('button', { text: '下一处', attr: { type: 'button' } });
    this.previous.addEventListener('click', () => this.select(this.selected - 1));
    this.next.addEventListener('click', () => this.select(this.selected + 1));
    this.summary = this.contentEl.createDiv({ cls: 'bmd-summary', attr: { 'aria-live': 'polite', role: 'status' } });
    this.body = this.contentEl.createDiv({ cls: 'bmd-diff-body' });
    this.registerDomEvent(this.contentEl.ownerDocument, 'copy', (event) => {
      const selection = this.contentEl.ownerDocument.getSelection();
      if (!selection?.rangeCount || !event.clipboardData) return;
      const text = selectedDiffText(this.body, selection.getRangeAt(0));
      if (text === undefined) return;
      event.clipboardData.clearData();
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    });
    this.register(this.host.store.subscribe((path) => { if (path === this.path) this.render(); }));
    this.setFile(this.host.currentPath());
  }

  setFile(path: string | undefined): void {
    if (this.path !== path) { this.selected = 0; this.followedLine = undefined; }
    this.path = path;
    if (this.body) this.render();
  }

  showLine(line: number): void {
    this.followedLine = line;
    if (!this.path) return;
    const state = this.host.store.get(this.path);
    if (state?.status !== 'ready') return;
    const location = findDiffLocation(state.diff, line);
    const data = location && state.diff.hunks[location.hunkIndex]?.rows[location.rowIndex];
    const row = data && this.rowElements.get(data);
    if (!location || !data || !row) return;
    this.selected = location.hunkIndex;
    this.hunks.forEach((hunk, i) => hunk.toggleClass('bmd-hunk--selected', i === this.selected));
    this.clearCurrentRow();
    this.currentRow = row;
    row.addClass('bmd-row--current');
    row.setAttribute('aria-current', 'location');
    const pair = this.rowPairs.get(data);
    this.pairedRow = pair && this.rowElements.get(pair);
    this.pairedRow?.addClass('bmd-row--paired');
    revealDiffRow(this.body, row, this.pairedRow);
  }

  private clearCurrentRow(): void {
    this.currentRow?.removeClass('bmd-row--current');
    this.currentRow?.removeAttribute('aria-current');
    this.currentRow = undefined;
    this.pairedRow?.removeClass('bmd-row--paired');
    this.pairedRow = undefined;
  }

  private select(index: number): void {
    if (!this.path || !this.hunks.length) return;
    const state = this.host.store.get(this.path);
    if (state?.status !== 'ready') return;
    const selected = (index + this.hunks.length) % this.hunks.length;
    const hunk = state.diff.hunks[selected];
    if (!hunk) return;
    this.showLine(hunk.line);
    if (this.host.settings().followNavigation) this.host.navigate(this.path, hunk.line, false);
  }

  private render(): void {
    const settings = this.host.settings();
    this.contentEl.style.setProperty('--bmd-font-size', `${settings.fontSize}px`);
    this.contentEl.toggleClass('bmd-no-inline-highlights', !settings.inlineHighlights);
    this.contentEl.toggleClass('bmd-hide-whitespace', !settings.showWhitespace);
    const scroll = this.body.scrollTop;
    this.summary.empty();
    this.body.empty();
    this.hunks = [];
    this.rowElements.clear();
    this.rowPairs = new Map();
    this.currentRow = undefined;
    this.pairedRow = undefined;
    this.previous.disabled = this.next.disabled = true;
    if (!this.path) { this.summary.setText('打开一个 Markdown 文档以查看 Git 差异。'); return; }
    this.summary.createDiv({ cls: 'bmd-file', text: this.path });
    const state = this.host.store.get(this.path);
    if (!state) { this.summary.createDiv({ text: '正在读取 Git…' }); return; }
    if (state.status === 'error') { this.summary.createDiv({ cls: 'bmd-message', text: state.message }); return; }
    const ref = state.baseline.head?.slice(0, 8) ?? '尚无提交';
    this.summary.createDiv({ cls: 'bmd-base', text: `HEAD (${ref}) → 当前内容${state.baseline.isNew ? ' · 新纳入文件' : ''}` });
    const stats = this.summary.createDiv({ cls: 'bmd-stats' });
    stats.createSpan({ cls: 'bmd-stat-added', text: `+${state.diff.added} 新增` });
    stats.createSpan({ cls: 'bmd-stat-deleted', text: `−${state.diff.deleted} 删除` });
    if (!state.diff.hunks.length) { this.body.createEl('p', { cls: 'bmd-empty', text: '此文档与 HEAD 一致。' }); return; }
    this.summary.createDiv({ cls: 'bmd-hint', text: `旧行与新行配对展示；两列行号依次为 HEAD、当前内容。${settings.inlineHighlights ? '深色突出变化字词；' : ''}${settings.showWhitespace ? '· 为空格，→ 为 Tab；' : ''}正文可选中复制。` });
    const highlights = highlightRows(state.diff.hunks.flatMap((hunk) => hunk.rows));
    this.rowPairs = highlights.pairs;
    if (highlights.limited) this.summary.createDiv({ cls: 'bmd-hint', text: '部分变更较大，已回退为整行高亮；完整增删内容仍保留。' });
    state.diff.hunks.forEach((hunk, index) => this.renderHunk(hunk, index, highlights, state));
    this.selected = Math.min(this.selected, this.hunks.length - 1);
    this.hunks[this.selected]?.addClass('bmd-hunk--selected');
    this.previous.disabled = this.next.disabled = this.hunks.length < 2;
    this.body.scrollTop = scroll;
    if (this.followedLine !== undefined) this.showLine(this.followedLine);
  }

  private renderHunk(hunk: DiffHunk, index: number, highlights: InlineHighlights, snapshot: ReadyDiffState): void {
    const section = this.body.createEl('section', { cls: 'bmd-hunk', attr: { 'aria-label': `第 ${index + 1} 处差异` } });
    this.hunks.push(section);
    const header = section.createDiv({ cls: 'bmd-hunk-header' });
    const jump = header.createEl('button', { cls: 'bmd-hunk-title', text: `变更 ${index + 1} · 当前第 ${hunk.line + 1} 行`, attr: { type: 'button' } });
    jump.addEventListener('click', () => { if (this.path) this.host.navigate(this.path, hunk.line); });
    const revert = header.createEl('button', { cls: 'bmd-revert', text: '还原此处', attr: { type: 'button', 'aria-label': `将变更 ${index + 1} 还原到 HEAD` } });
    revert.addEventListener('click', () => this.host.revert(snapshot, hunk));
    const lines = section.createDiv({ cls: 'bmd-lines' });
    for (const row of pairDiffRows(hunk.rows, highlights.pairs)) {
      const line = lines.createDiv({ cls: `bmd-row bmd-row--${row.kind}`, attr: { 'data-old-line': row.oldLine?.toString() ?? '', 'data-new-line': row.newLine?.toString() ?? '' } });
      this.rowElements.set(row, line);
      line.createSpan({ cls: 'bmd-line-number', text: row.oldLine?.toString() ?? '', attr: { 'aria-hidden': 'true' } });
      line.createSpan({ cls: 'bmd-line-number', text: row.newLine?.toString() ?? '', attr: { 'aria-hidden': 'true' } });
      line.createSpan({ cls: 'bmd-sign', text: row.kind === 'added' ? '+' : row.kind === 'deleted' ? '−' : ' ' });
      // Deliberately render source as text, not HTML/Markdown; don't execute note content.
      const text = line.createEl('code', { cls: 'bmd-row-text' });
      renderHighlightedText(text, row, highlights.segments.get(row)!);
      if (row.noNewline) text.createSpan({ cls: 'bmd-no-newline', text: ' ⏎ 无末尾换行' });
    }
  }
}
