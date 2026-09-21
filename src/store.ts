import { computeDiff, normalizeText, type DocumentDiff } from './diff';
import type { GitBaseline } from './git';

export type DiffState =
  | { status: 'ready'; path: string; current: string; baseline: GitBaseline; diff: DocumentDiff }
  | { status: 'error'; path: string; message: string };

export type ReadyDiffState = Extract<DiffState, { status: 'ready' }>;

type Listener = (path: string) => void;

export class DiffStore {
  private states = new Map<string, DiffState>();
  private baselines = new Map<string, GitBaseline>();
  private requests = new Map<string, Promise<GitBaseline>>();
  private revisions = new Map<string, number>();
  private listeners = new Set<Listener>();
  private disposed = false;
  private nextRevision = 0;

  constructor(private readonly readBaseline: (path: string) => Promise<GitBaseline>, private contextLines = 3) {}

  get(path: string): DiffState | undefined { return this.states.get(path); }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(path: string, current: string, force = false): Promise<void> {
    if (this.disposed) return;
    const revision = ++this.nextRevision;
    this.revisions.set(path, revision);
    try {
      let baseline = !force && !this.requests.has(path) ? this.baselines.get(path) : undefined;
      if (!baseline) {
        let request = this.requests.get(path);
        if (!request) {
          request = this.readBaseline(path);
          this.requests.set(path, request);
          // Observe both branches, and don't let a forgotten request restore stale cache entries.
          void request.then((result) => {
            if (this.requests.get(path) === request) {
              this.baselines.set(path, result);
              this.requests.delete(path);
            }
          }, () => {
            if (this.requests.get(path) === request) {
              this.baselines.delete(path);
              this.requests.delete(path);
            }
          });
        }
        baseline = await request;
      }
      if (this.disposed || this.revisions.get(path) !== revision) return;
      current = normalizeText(current);
      const previous = this.states.get(path);
      if (previous?.status === 'ready' && previous.current === current && previous.baseline.content === baseline.content && previous.baseline.head === baseline.head && previous.baseline.isNew === baseline.isNew) return;
      this.states.set(path, { status: 'ready', path, current, baseline, diff: computeDiff(baseline.content, current, this.contextLines) });
    } catch (error) {
      if (this.disposed || this.revisions.get(path) !== revision) return;
      this.states.set(path, { status: 'error', path, message: error instanceof Error ? error.message : '无法计算差异。' });
    }
    this.emit(path);
  }

  updatePresentation(contextLines: number): void {
    if (this.disposed) return;
    const changed = contextLines !== this.contextLines;
    this.contextLines = contextLines;
    for (const [path, state] of this.states) {
      if (changed && state.status === 'ready') {
        try {
          this.states.set(path, { ...state, diff: computeDiff(state.baseline.content, state.current, contextLines) });
        } catch (error) {
          this.states.set(path, { status: 'error', path, message: error instanceof Error ? error.message : '无法计算差异。' });
        }
      }
      this.emit(path);
    }
  }

  reportError(path: string, message: string): void {
    this.revisions.set(path, ++this.nextRevision);
    this.states.set(path, { status: 'error', path, message });
    this.emit(path);
  }

  private emit(path: string): void {
    for (const listener of this.listeners) listener(path);
  }

  forget(path: string): void {
    this.revisions.delete(path);
    this.requests.delete(path);
    this.baselines.delete(path);
    this.states.delete(path);
    this.emit(path);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.requests.clear();
    this.baselines.clear();
    this.states.clear();
    this.revisions.clear();
  }
}
