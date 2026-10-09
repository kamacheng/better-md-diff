import { StateEffect, type Extension } from '@codemirror/state';
import { BlockType, EditorView, gutter, GutterMarker, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { changeAnchor, normalizeText, type LineChange } from './diff';
import type { DiffStore } from './store';
import { t } from './i18n';

export interface EditorDiffHost {
  store: DiffStore;
  getPath(view: EditorView): string | undefined;
  enabled(): boolean;
  open(path: string, line: number, preferDeletion: boolean): void;
  select(path: string, line: number): void;
}

export const refreshDiff = StateEffect.define<null>();

interface ChangeSpan {
  change: LineChange;
  from: number;
  to: number;
  line: number;
}

class DiffMarker extends GutterMarker {
  private label: string;

  constructor(private span: ChangeSpan, private start: boolean, private end: boolean, private blockCount: number,
    private boundary: 'first' | 'before' | 'after', private lineHeight: number, private open: () => void) {
    super();
    const { kind, added, deleted } = span.change;
    this.label = kind === 'deleted' ? t('已删除 {count} 行，查看对应改动', { count: deleted })
      : kind === 'added' ? t('新增 {count} 行，查看对应改动', { count: added })
      : t('修改当前 {count} 行（原 {deleted} 行），查看对应改动', { count: added, deleted });
    if (blockCount) this.label += ' ' + t('此显示块包含 {count} 项改动，点击查看首项；具体范围见右侧。', { count: blockCount });
  }

  eq(other: DiffMarker): boolean {
    return this.span === other.span && this.start === other.start && this.end === other.end
      && this.blockCount === other.blockCount && this.boundary === other.boundary
      && this.lineHeight === other.lineHeight && this.label === other.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const { kind, added, deleted } = this.span.change;
    const element = view.dom.ownerDocument.adoptNode(createDiv());
    element.className = `bmd-gutter-range bmd-gutter-range--${kind}`;
    element.style.setProperty('--bmd-source-line-height', `${this.lineHeight}px`);
    if (this.start) element.classList.add('bmd-gutter-range--start');
    if (this.end) element.classList.add('bmd-gutter-range--end');
    if (this.blockCount) element.classList.add('bmd-gutter-range--block');
    if (kind === 'deleted') element.classList.add(`bmd-gutter-range--${this.boundary}`);
    if (!this.start && !this.blockCount) { element.setAttribute('aria-hidden', 'true'); return element; }
    const button = element.createEl('button', { cls: `bmd-gutter-marker bmd-gutter-marker--${kind}`, attr: { type: 'button' } });
    button.createSpan({ cls: 'bmd-gutter-label', text: kind === 'deleted' ? `−${deleted}` : `${kind === 'added' ? '+' : '~'}${added}` });
    button.title = this.label;
    button.setAttribute('aria-label', this.label);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => { event.stopPropagation(); this.open(); });
    return element;
  }
}

export function editorDiffExtension(host: EditorDiffHost): Extension {
  const plugin = ViewPlugin.fromClass(class {
    private spans: ChangeSpan[] = [];
    private path?: string;
    private unsubscribe: () => void;
    private destroyed = false;
    private selectionQueued = false;

    constructor(private view: EditorView) {
      this.build();
      this.unsubscribe = host.store.subscribe((path) => {
        if (path !== host.getPath(view)) return;
        // A store event can originate from an editor event; never dispatch during a CM update.
        queueMicrotask(() => {
          if (!this.destroyed) view.dispatch({ effects: refreshDiff.of(null) });
        });
      });
      this.queueSelection();
    }

    update(update: ViewUpdate): void {
      const pathChanged = host.getPath(this.view) !== this.path;
      if (update.docChanged || pathChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshDiff)))) this.build();
      if (update.selectionSet || update.focusChanged || update.docChanged || pathChanged) this.queueSelection();
    }

    private queueSelection(): void {
      if (this.selectionQueued) return;
      this.selectionQueued = true;
      // Defer layout reads until CM finishes updating; coalesce rapid selection changes.
      queueMicrotask(() => {
        this.selectionQueued = false;
        if (this.destroyed || !this.view.hasFocus) return;
        const path = host.getPath(this.view);
        if (path) host.select(path, this.view.state.doc.lineAt(this.view.state.selection.main.head).number - 1);
      });
    }

    private build(): void {
      this.path = host.getPath(this.view);
      this.spans = [];
      if (!this.path || !host.enabled()) return;
      const state = host.store.get(this.path);
      const doc = this.view.state.doc;
      if (state?.status !== 'ready' || state.current !== normalizeText(doc.toString())) return;
      this.spans = state.diff.changes.map((change) => {
        const line = changeAnchor(change, doc.lines);
        const last = Math.max(line, Math.min(change.to - 1, doc.lines - 1));
        return { change, line, from: doc.line(line + 1).from, to: doc.line(last + 1).to };
      });
    }

    markerForRange(from: number, to: number, widget = false): GutterMarker | null {
      // Widget ranges are end-exclusive. Insertion widgets must not duplicate a text-line flag.
      if (widget) { if (from === to) return null; to--; }
      let low = 0, high = this.spans.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.spans[middle]!.to < from) low = middle + 1;
        else high = middle;
      }
      const span = this.spans[low];
      if (!span || span.from > to || !this.path) return null;
      let count = 1;
      while (this.spans[low + count] && this.spans[low + count]!.from <= to) count++;
      const doc = this.view.state.doc;
      // A rendered/folded block has no reliable per-source-line geometry. Show its first
      // change with an explicit block label, not a misleading rail over unrelated content.
      const block = widget || count > 1 || doc.lineAt(from).number !== doc.lineAt(to).number;
      const boundary = span.change.from >= doc.lines ? 'after' : from === 0 ? 'first' : 'before';
      const path = this.path;
      return new DiffMarker(span, span.from >= from, span.to <= to, block ? count : 0, boundary, this.view.defaultLineHeight,
        () => host.open(path, span.line, span.change.kind === 'deleted'));
    }

    destroy(): void { this.destroyed = true; this.unsubscribe(); }
  });

  return [plugin, gutter({
    class: 'bmd-gutter',
    lineMarker: (view, line) => {
      const blocks = typeof line.type === 'number' ? [line] : line.type;
      for (const block of blocks) {
        if (block.type !== BlockType.Text) continue;
        const marker = view.plugin(plugin)?.markerForRange(block.from, block.to);
        if (marker) return marker;
      }
      return null;
    },
    widgetMarker: (view, _widget, block) => view.plugin(plugin)?.markerForRange(block.from, block.to, true) ?? null,
    lineMarkerChange: (update) => update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshDiff))),
  })];
}
