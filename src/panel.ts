import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import { changeAnchor, changeRange, type DiffHunk, type DiffRow, type LineChange } from './diff';
import type { DiffStore, ReadyDiffState } from './store';
import type { DiffSettings } from './options';
import { highlightHunks, localizeHighlightedText, pairDiffRows, renderHighlightedText, type InlineHighlights } from './inline-diff';
import { onLanguageChange, t, type MessageKey } from './i18n';
import { findDiffLocation, revealDiffRow } from './diff-navigation';
import { selectedDiffText } from './diff-copy';

export const DIFF_VIEW = 'better-md-diff-view';
export interface DiffPanelHost {
  store: DiffStore;
  settings(): DiffSettings;
  currentPath(): string | undefined;
  refresh(path: string): Promise<void>;
  navigate(path: string, line: number, focus?: boolean): void;
  revert(snapshot: ReadyDiffState, change: LineChange): void;
}
interface ChangeItem {
  element: HTMLElement;
  jump: HTMLButtonElement;
  revert: HTMLButtonElement;
  rowIndex: number;
  change: LineChange;
  snapshot: ReadyDiffState;
}
/** A cached context region is only a rendering boundary, never a restoration target. */
interface HunkCard {
  key: string;
  element: HTMLElement;
  rows: HTMLElement[];
  pairs: Map<number, number>;
  limited: boolean;
  hunk: DiffHunk;
  items: ChangeItem[];
}

export class DiffPanel extends ItemView {
  private path?: string;
  private selected = 0;
  private cards: HunkCard[] = [];
  private items: ChangeItem[] = [];
  private rowElements = new Map<DiffRow, HTMLElement>();
  private rowPairs = new Map<DiffRow, DiffRow>();
  private rendered?: ReadyDiffState;
  private pendingRender = false;
  private followedLine?: number;
  private currentRow?: HTMLElement;
  private pairedRow?: HTMLElement;
  private summary!: HTMLElement;
  private body!: HTMLElement;
  private progress!: HTMLElement;
  private feedback!: HTMLElement;
  private previous!: HTMLButtonElement;
  private next!: HTMLButtonElement;
  private refreshButton!: HTMLButtonElement;
  private refreshRequest?: symbol;
  private summaryKey?: string;
  private feedbackKey?: MessageKey;

  constructor(leaf: WorkspaceLeaf, private host: DiffPanelHost) { super(leaf); }
  getViewType(): string { return DIFF_VIEW; }
  getDisplayText(): string { return t('Git 差异'); }
  getIcon(): string { return 'git-compare-arrows'; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('bmd-panel');
    const toolbar = this.contentEl.createDiv({ cls: 'bmd-toolbar' });
    this.refreshButton = toolbar.createEl('button', { cls: 'bmd-refresh', text: t('刷新'), attr: { type: 'button', 'aria-label': t('重新读取 HEAD 并刷新差异') } });
    this.refreshButton.addEventListener('click', () => { void this.refreshCurrent(); });
    this.previous = toolbar.createEl('button', { cls: 'bmd-previous', text: t('上一处'), attr: { type: 'button' } });
    this.next = toolbar.createEl('button', { cls: 'bmd-next', text: t('下一处'), attr: { type: 'button' } });
    this.previous.addEventListener('click', () => this.move(-1));
    this.next.addEventListener('click', () => this.move(1));
    this.progress = toolbar.createSpan({ cls: 'bmd-progress', attr: { 'aria-live': 'polite' } });
    this.feedback = this.contentEl.createDiv({ cls: 'bmd-feedback', attr: { role: 'status' } });
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
    this.registerDomEvent(this.contentEl.ownerDocument, 'selectionchange', () => {
      if (this.pendingRender && !this.hasTextSelection()) this.render();
    });
    this.register(this.host.store.subscribe((path) => { if (path === this.path) this.render(); }));
    this.register(onLanguageChange(() => {
      this.summaryKey = undefined;
      this.previous.setText(t('上一处')); this.next.setText(t('下一处'));
      this.refreshButton.setAttribute('aria-label', t('重新读取 HEAD 并刷新差异'));
      this.updateRefreshButton();
      if (this.feedbackKey) this.feedback.setText(t(this.feedbackKey));
      this.items.forEach((item, index) => this.localizeItem(item, index));
      this.cards.forEach((card) => {
        card.element.querySelector('.bmd-context-gap')?.setAttribute('aria-label', t('已省略未修改内容'));
        card.hunk.rows.forEach((row, i) => localizeHighlightedText(card.rows[i]!.querySelector<HTMLElement>('.bmd-row-text')!, row));
      });
      if (this.rendered && !this.cards.length) this.renderEmptyState();
      this.render();
    }));
    this.setFile(this.host.currentPath());
  }

  setFile(path: string | undefined): void {
    if (this.path !== path) {
      this.selected = 0; this.followedLine = undefined; this.rendered = undefined;
      this.refreshRequest = undefined; this.pendingRender = false;
      this.cards = []; this.items = []; this.body?.empty(); this.feedback?.empty(); this.feedbackKey = undefined; this.summaryKey = undefined;
    }
    this.path = path;
    if (this.body) { this.updateRefreshButton(); this.render(); }
  }

  private async refreshCurrent(): Promise<void> {
    if (!this.path || this.refreshRequest) return;
    const request = this.refreshRequest = Symbol();
    this.updateRefreshButton();
    this.setFeedback('正在检查 Git 基准…');
    try {
      await this.host.refresh(this.path);
      if (this.refreshRequest === request) this.setFeedback(this.pendingRender ? '内容已更新；结束文本选择后刷新展示。' : '已刷新 Git 基准。');
    } catch (error) {
      if (this.refreshRequest === request) {
        this.feedbackKey = undefined;
        this.feedback.setText(error instanceof Error ? error.message : t('刷新失败，请重试。'));
      }
    } finally {
      if (this.refreshRequest === request) { this.refreshRequest = undefined; this.updateRefreshButton(); }
    }
  }

  private setFeedback(key: MessageKey): void { this.feedbackKey = key; this.feedback.setText(t(key)); }

  private updateRefreshButton(): void {
    this.refreshButton.disabled = !this.path || !!this.refreshRequest;
    this.refreshButton.setText(t(this.refreshRequest ? '刷新中…' : '刷新'));
    this.refreshButton.setAttribute('aria-busy', String(!!this.refreshRequest));
  }

  showLine(line: number, reveal = true, preferDeletion = false): void {
    this.followedLine = line;
    if (!this.rendered || this.pendingRender) return;
    if (preferDeletion) {
      const index = this.items.findIndex((item) => item.change.kind === 'deleted' && changeAnchor(item.change, this.rendered!.diff.lineCount) === line);
      if (index >= 0) { this.showChange(index, reveal); return; }
    }
    const location = findDiffLocation(this.rendered.diff, line);
    const data = location && this.rendered.diff.hunks[location.hunkIndex]?.rows[location.rowIndex];
    if (!data) return;
    let distance = Infinity;
    this.items.forEach((item, index) => {
      const start = changeAnchor(item.change, this.rendered!.diff.lineCount);
      const next = Math.max(start - line, line - Math.max(start, item.change.to - 1), 0);
      if (next < distance) { distance = next; this.selected = index; }
    });
    this.updateProgress();
    this.highlightRow(data, reveal);
  }

  private showChange(index: number, reveal = true): void {
    const item = this.items[index]!;
    this.selected = index;
    this.followedLine = changeAnchor(item.change, item.snapshot.diff.lineCount);
    this.updateProgress();
    this.highlightRow(item.change.rows.find((row) => row.kind === 'added') ?? item.change.rows[0]!, reveal);
  }

  private highlightRow(data: DiffRow, reveal: boolean): void {
    const row = this.rowElements.get(data);
    if (!row) return;
    this.clearCurrentRow();
    this.currentRow = row;
    row.addClass('bmd-row--current'); row.setAttribute('aria-current', 'location');
    const pair = this.rowPairs.get(data);
    this.pairedRow = pair && this.rowElements.get(pair);
    this.pairedRow?.addClass('bmd-row--paired');
    if (reveal) revealDiffRow(this.body, row, this.pairedRow);
  }

  move(direction: -1 | 1): boolean {
    if (!this.path || !this.rendered || !this.items.length || this.pendingRender) return false;
    const index = (this.selected + direction + this.items.length) % this.items.length;
    this.showChange(index);
    if (this.host.settings().followNavigation) this.host.navigate(this.path, changeAnchor(this.items[index]!.change, this.rendered.diff.lineCount), false);
    return true;
  }

  private updateProgress(): void {
    this.progress.setText(this.items.length ? t('第 {index} / {total} 处', { index: this.selected + 1, total: this.items.length }) : t('0 处变更'));
    this.progress.hidden = this.items.length === 0;
    this.previous.disabled = this.next.disabled = this.items.length < 2 || this.pendingRender;
    this.items.forEach((item, i) => item.element.toggleClass('bmd-change--selected', i === this.selected));
  }

  private clearCurrentRow(): void {
    this.currentRow?.removeClass('bmd-row--current'); this.currentRow?.removeAttribute('aria-current'); this.currentRow = undefined;
    this.pairedRow?.removeClass('bmd-row--paired'); this.pairedRow = undefined;
  }

  private hasTextSelection(): boolean {
    const selection = this.contentEl.ownerDocument.getSelection();
    return !!selection && !selection.isCollapsed && !!selection.anchorNode && this.body.contains(selection.anchorNode);
  }

  private render(): void {
    const settings = this.host.settings();
    this.contentEl.style.setProperty('--bmd-font-size', `${settings.fontSize}px`);
    this.contentEl.toggleClass('bmd-no-inline-highlights', !settings.inlineHighlights);
    this.contentEl.toggleClass('bmd-hide-whitespace', !settings.showWhitespace);
    const state = this.path ? this.host.store.get(this.path) : undefined;
    if (state?.status === 'ready' && this.rendered && state !== this.rendered && this.hasTextSelection()) {
      this.pendingRender = true;
      this.setFeedback('内容已更新；结束文本选择后刷新展示。');
      for (const item of this.items) { item.revert.disabled = true; item.jump.disabled = true; }
      this.updateProgress(); return;
    }
    if (this.pendingRender) { this.pendingRender = false; this.feedback.empty(); this.feedbackKey = undefined; }
    if (state?.status !== 'ready') {
      this.cards = []; this.items = []; this.rendered = undefined; this.rowElements.clear(); this.rowPairs.clear(); this.clearCurrentRow();
      this.body.empty(); this.summaryKey = undefined;
      this.summary.empty();
      if (this.path) this.renderFileInfo(this.path);
      this.summary.createDiv({ cls: 'bmd-message', text: !this.path ? t('打开一个 Markdown 文档以查看 Git 差异。') : state?.status === 'error' ? state.message : t('正在读取 Git…') });
      this.updateProgress(); return;
    }
    const digits = String(Math.max(state.diff.lineCount, state.diff.lineCount - state.diff.added + state.diff.deleted)).length;
    this.contentEl.style.setProperty('--bmd-line-digits', `${Math.max(3, digits)}ch`);
    if (state !== this.rendered) this.reconcile(state);
    const summaryKey = JSON.stringify([this.path, state.baseline.head, state.baseline.isNew, state.diff.added, state.diff.deleted, settings.inlineHighlights, settings.showWhitespace, this.cards.some((card) => card.limited)]);
    if (summaryKey !== this.summaryKey) {
      const helpOpen = this.summary.querySelector<HTMLDetailsElement>('.bmd-help')?.open ?? false;
      this.summaryKey = summaryKey; this.summary.empty();
      this.renderFileInfo(state.path);
      const base = this.summary.createDiv({ cls: 'bmd-base' });
      const reference = base.createSpan({ cls: 'bmd-baseline-ref' });
      reference.createSpan({ text: 'HEAD' });
      reference.createEl('code', { cls: 'bmd-ref', text: state.baseline.head?.slice(0, 8) ?? t('尚无提交'), attr: { title: state.baseline.head ?? t('尚无提交') } });
      base.createSpan({ cls: 'bmd-base-arrow', text: '→', attr: { 'aria-hidden': 'true' } });
      base.createSpan({ text: t('当前内容') });
      if (state.baseline.isNew) base.createSpan({ cls: 'bmd-new-file', text: t('新纳入文件') });
      if (state.diff.added || state.diff.deleted) {
        const stats = this.summary.createDiv({ cls: 'bmd-stats' });
        if (state.diff.added) stats.createSpan({ cls: 'bmd-stat-added', text: t('+{count} 新增', { count: state.diff.added }) });
        if (state.diff.deleted) stats.createSpan({ cls: 'bmd-stat-deleted', text: t('−{count} 删除', { count: state.diff.deleted }) });
      }
      if (this.cards.length) {
        const help = this.summary.createEl('details', { cls: 'bmd-help' });
        help.open = helpOpen;
        help.createEl('summary', { text: t('阅读说明') });
        help.createDiv({ cls: 'bmd-hint', text: t('连续增删是一项改动；每项独立还原，上下文只用于阅读。') });
        help.createDiv({ cls: 'bmd-hint', text: t('旧行与新行配对展示；两列行号依次为 HEAD、当前内容。') + (settings.inlineHighlights ? t('深色突出变化字词；') : '') + (settings.showWhitespace ? t('· 为空格，→ 为 Tab；') : '') + t('正文可选中复制。') });
        help.createDiv({ cls: 'bmd-hint', text: t('点击改动行号定位原文，行尾箭头仅还原该项。') });
      }
      if (this.cards.some((card) => card.limited)) this.summary.createDiv({ cls: 'bmd-hint', text: t('部分变更较大，已回退为整行高亮；完整增删内容仍保留。') });
    }
    this.updateProgress();
  }

  private renderFileInfo(path: string): void {
    const parts = path.split('/');
    const name = parts.pop()!;
    const file = this.summary.createDiv({ cls: 'bmd-file-info', attr: { title: path } });
    file.createDiv({ cls: 'bmd-file', text: name });
    if (parts.length) file.createDiv({ cls: 'bmd-directory', text: parts.join(' / ') });
  }

  private renderEmptyState(): void {
    this.body.querySelector('.bmd-empty')?.remove();
    const empty = this.body.createDiv({ cls: 'bmd-empty', attr: { role: 'status' } });
    setIcon(empty.createSpan({ cls: 'bmd-empty-icon', attr: { 'aria-hidden': 'true' } }), 'check');
    const message = empty.createDiv();
    message.createEl('h3', { cls: 'bmd-empty-title', text: t('与 HEAD 一致') });
    message.createEl('p', { cls: 'bmd-empty-description', text: t('继续编辑此文档，差异会自动显示在这里。') });
  }

  private reconcile(state: ReadyDiffState): void {
    const scroll = this.body.scrollTop;
    const selectedItem = this.items[this.selected];
    const changesByRow = new Map<DiffRow, LineChange>();
    for (const change of state.diff.changes) for (const row of change.rows) changesByRow.set(row, change);
    const buckets = new Map<string, HunkCard[]>();
    for (const card of this.cards) { const list = buckets.get(card.key) ?? []; list.push(card); buckets.set(card.key, list); }
    const plans = state.diff.hunks.map((hunk) => {
      // Coordinates may change without changing the source text or its highlighting.
      const key = JSON.stringify(hunk.rows.map((row) => [row.kind, row.text, row.noNewline]));
      return { hunk, key, card: buckets.get(key)?.shift() };
    });
    const highlights = highlightHunks(plans.filter((plan) => !plan.card).map((plan) => plan.hunk));
    this.clearCurrentRow(); this.rowElements.clear(); this.rowPairs.clear();
    for (const unused of buckets.values()) for (const card of unused) card.element.remove();
    this.body.querySelector('.bmd-empty')?.remove();
    this.cards = plans.map(({ hunk, key, card }, index) => {
      card ??= this.createCard(hunk, key, highlights, state, changesByRow);
      card.hunk = hunk;
      for (const item of card.items) {
        item.change = changesByRow.get(hunk.rows[item.rowIndex]!)!;
        item.snapshot = state; item.revert.disabled = false; item.jump.disabled = false;
      }
      hunk.rows.forEach((row, i) => {
        const element = card.rows[i]!;
        element.setAttribute('data-old-line', row.oldLine?.toString() ?? ''); element.setAttribute('data-new-line', row.newLine?.toString() ?? '');
        element.children[0]!.textContent = row.oldLine?.toString() ?? ''; element.children[1]!.textContent = row.newLine?.toString() ?? '';
        this.rowElements.set(row, element);
        const pair = card.pairs.get(i);
        if (pair !== undefined) this.rowPairs.set(row, hunk.rows[pair]!);
      });
      if (this.body.children[index] !== card.element) this.body.insertBefore(card.element, this.body.children[index] ?? null);
      return card;
    });
    this.items = this.cards.flatMap((card) => card.items);
    this.items.forEach((item, index) => this.localizeItem(item, index));
    this.selected = Math.max(0, selectedItem && this.items.includes(selectedItem) ? this.items.indexOf(selectedItem) : Math.min(this.selected, this.items.length - 1));
    this.rendered = state;
    if (!this.cards.length) this.renderEmptyState();
    this.body.scrollTop = scroll;
    if (this.followedLine !== undefined) this.showLine(this.followedLine, false);
  }

  private localizeItem(item: ChangeItem, index: number): void {
    const range = changeRange(item.change);
    const label = t('改动 {index} · {range}', { index: index + 1, range });
    item.element.setAttribute('aria-label', label);
    item.jump.title = t('定位第 {index} 项改动：{range}', { index: index + 1, range });
    item.jump.setAttribute('aria-label', item.jump.title);
    item.revert.title = t('还原第 {index} 项：{range}', { index: index + 1, range });
    item.revert.setAttribute('aria-label', item.revert.title);
  }

  private createCard(hunk: DiffHunk, key: string, highlights: InlineHighlights, snapshot: ReadyDiffState, changesByRow: Map<DiffRow, LineChange>): HunkCard {
    const element = this.body.createDiv({ cls: 'bmd-diff-region' });
    element.createDiv({ cls: 'bmd-context-gap', text: '···', attr: { role: 'separator', 'aria-label': t('已省略未修改内容') } });
    const card: HunkCard = { key, element, rows: [], pairs: new Map(), limited: highlights.limited, hunk, items: [] };
    const itemsByChange = new Map<LineChange, ChangeItem>();
    const lines = element.createDiv({ cls: 'bmd-lines' });
    const positions = new Map(hunk.rows.map((row, i) => [row, i]));
    for (const row of pairDiffRows(hunk.rows, highlights.pairs)) {
      const index = positions.get(row)!;
      const change = changesByRow.get(row);
      let parent: HTMLElement = lines;
      if (change) {
        let item = itemsByChange.get(change);
        if (!item) {
          const element = lines.createEl('section', { cls: 'bmd-change' });
          const jump = element.createEl('button', { cls: 'bmd-line-number bmd-change-title', attr: { type: 'button' } });
          const revert = element.createEl('button', { cls: 'bmd-revert', attr: { type: 'button' } });
          setIcon(revert.createSpan({ attr: { 'aria-hidden': 'true' } }), 'undo-2');
          const entry: ChangeItem = { element, jump, revert, rowIndex: index, change, snapshot };
          jump.addEventListener('click', () => this.host.navigate(entry.snapshot.path, changeAnchor(entry.change, entry.snapshot.diff.lineCount)));
          revert.addEventListener('click', () => this.host.revert(entry.snapshot, entry.change));
          item = entry; itemsByChange.set(change, entry); card.items.push(entry);
        }
        parent = item.element;
      }
      const line = parent.createDiv({ cls: `bmd-row bmd-row--${row.kind}` });
      card.rows[index] = line;
      const pair = highlights.pairs.get(row);
      if (pair) card.pairs.set(index, positions.get(pair)!);
      const oldNumber = line.createSpan({ cls: 'bmd-line-number', attr: { 'aria-hidden': 'true' } });
      const newNumber = line.createSpan({ cls: 'bmd-line-number', attr: { 'aria-hidden': 'true' } });
      const item = change && itemsByChange.get(change);
      if (item?.rowIndex === index) (row.oldLine !== undefined ? oldNumber : newNumber).replaceWith(item.jump);
      line.createSpan({ cls: 'bmd-sign', text: row.kind === 'added' ? '+' : row.kind === 'deleted' ? '−' : ' ' });
      const text = line.createEl('code', { cls: 'bmd-row-text' });
      renderHighlightedText(text, row, highlights.segments.get(row)!);
      if (row.noNewline) text.createSpan({ cls: 'bmd-no-newline', text: t(' ⏎ 无末尾换行') });
    }
    return card;
  }
}
