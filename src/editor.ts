import { StateEffect, type Extension, type Range } from '@codemirror/state';
import { BlockType, Decoration, type DecorationSet, EditorView, gutter, GutterMarker, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { changeAnchor, changeLabel, normalizeText, type ChangeKind, type LineChange } from './diff';
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

class DiffMarker extends GutterMarker {
  constructor(private kind: ChangeKind, private label: string, private deleted: number, private open: () => void) { super(); }
  toDOM(view: EditorView): HTMLElement {
    const button = view.dom.ownerDocument.adoptNode(createEl('button'));
    button.className = `bmd-gutter-marker bmd-gutter-marker--${this.kind}`;
    button.type = 'button';
    button.textContent = this.kind === 'added' ? '+' : this.kind === 'deleted' ? `−${this.deleted}` : '~';
    button.title = this.label;
    button.setAttribute('aria-label', this.label);
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => { event.stopPropagation(); this.open(); });
    return button;
  }
}

export function editorDiffExtension(host: EditorDiffHost): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    markers = new Map<number, GutterMarker>();
    private positions: number[] = [];
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
      this.markers.clear();
      this.positions = [];
      this.decorations = Decoration.none;
      if (!this.path || !host.enabled()) return;
      const state = host.store.get(this.path);
      if (state?.status !== 'ready' || state.current !== normalizeText(this.view.state.doc.toString())) return;
      const lines = new Map<number, LineChange[]>();
      for (const change of state.diff.changes) {
        const start = changeAnchor(change, this.view.state.doc.lines);
        const end = Math.max(start + 1, Math.min(change.to, this.view.state.doc.lines));
        for (let line = start; line < end; line++) {
          const existing = lines.get(line) ?? [];
          existing.push(change);
          lines.set(line, existing);
        }
      }
      const decorations: Range<Decoration>[] = [];
      for (const [number, changes] of [...lines].sort(([a], [b]) => a - b)) {
        const from = this.view.state.doc.line(number + 1).from;
        const kind = changes.length > 1 ? 'modified' : changes[0]!.kind;
        const deleted = changes.reduce((sum, change) => sum + change.deleted, 0);
        const label = kind === 'deleted' ? t('已删除 {count} 行，查看对应改动', { count: deleted }) : changeLabel(changes);
        // The rule marks a deletion boundary, not deleted current text. Never tint its anchor line.
        const className = kind === 'deleted' ? 'bmd-deletion-anchor' : `bmd-line bmd-line--${kind}`;
        decorations.push(Decoration.line({ attributes: { class: className, title: label } }).range(from));
        const path = this.path;
        this.positions.push(from);
        this.markers.set(from, new DiffMarker(kind, label, deleted, () => host.open(path, number, kind === 'deleted')));
      }
      this.decorations = Decoration.set(decorations);
    }

    markerForRange(from: number, to: number): GutterMarker | null {
      // Live Preview replaces tables/callouts with block widgets spanning multiple source lines.
      let low = 0, high = this.positions.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.positions[middle]! < from) low = middle + 1;
        else high = middle;
      }
      const position = this.positions[low];
      return position !== undefined && position <= to ? this.markers.get(position) ?? null : null;
    }

    destroy(): void { this.destroyed = true; this.unsubscribe(); }
  }, { decorations: (value) => value.decorations });

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
    widgetMarker: (view, _widget, block) => view.plugin(plugin)?.markerForRange(block.from, block.to) ?? null,
    lineMarkerChange: (update) => update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshDiff))),
  })];
}
