import { assertTextSize, computeDiff, normalizeText, type DocumentDiff, type LineChange } from './diff';
import { DEFAULT_SETTINGS, type DocumentLimits } from './options';
import { LocalizedError } from './i18n';
import { prepareTextRevert, type RevertTarget } from './revert';

const staleMessage = '文档或认可内容已变化，请刷新后重新选择改动。';

export interface ReviewRecord {
  revision: number;
  content: string;
  undoContent: string | null;
}

export interface ReviewSnapshot {
  path: string;
  current: string;
  record: Readonly<ReviewRecord>;
  diff: DocumentDiff;
}

export function createReviewRecord(content: string, limits: DocumentLimits = DEFAULT_SETTINGS): ReviewRecord {
  assertTextSize(content, limits);
  return { revision: 0, content: normalizeText(content), undoContent: null };
}

export function parseReviewRecord(value: unknown, limits: DocumentLimits = DEFAULT_SETTINGS): ReviewRecord {
  if (!value || typeof value !== 'object' || !('revision' in value) || !('content' in value) || !('undoContent' in value)
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.content !== 'string' || (value.undoContent !== null && typeof value.undoContent !== 'string')) {
    throw new LocalizedError('认可记录损坏或不兼容，未自动初始化。');
  }
  assertTextSize(value.content, limits);
  if (value.undoContent !== null) assertTextSize(value.undoContent, limits);
  return { revision: value.revision, content: normalizeText(value.content), undoContent: value.undoContent === null ? null : normalizeText(value.undoContent) };
}

/** Owns acceptance decisions; source edits are delegated to the host's undoable transaction. */
export class ReviewDocument {
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private snapshots = new WeakSet<ReviewSnapshot>();

  constructor(
    private readonly path: string,
    private record: ReviewRecord,
    private readonly save: (record: ReviewRecord) => Promise<void>,
    private readonly limits: DocumentLimits = DEFAULT_SETTINGS,
  ) { this.record = Object.freeze(parseReviewRecord(record, limits)); this.limits = { ...limits }; }

  snapshot(current: string, contextLines = 3): ReviewSnapshot {
    const snapshot = { path: this.path, current: normalizeText(current), record: this.record, diff: computeDiff(this.record.content, current, contextLines, this.limits) };
    for (const hunk of snapshot.diff.hunks) {
      for (const row of hunk.rows) Object.freeze(row);
      Object.freeze(hunk.rows); Object.freeze(hunk);
    }
    for (const change of snapshot.diff.changes) { Object.freeze(change.rows); Object.freeze(change); }
    Object.freeze(snapshot.diff.changes); Object.freeze(snapshot.diff.hunks); Object.freeze(snapshot.diff);
    this.snapshots.add(snapshot);
    return Object.freeze(snapshot);
  }

  acceptAll(snapshot: ReviewSnapshot, readCurrent: () => string, signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      this.check(snapshot, readCurrent());
      if (snapshot.current !== this.record.content) await this.commit(snapshot.current, this.record.content, signal);
    }, signal);
  }

  undoAcceptance(snapshot: ReviewSnapshot, signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      this.check(snapshot);
      if (this.record.undoContent !== null) await this.commit(this.record.undoContent, null, signal);
    }, signal);
  }

  accept(snapshot: ReviewSnapshot, change: LineChange, readCurrent: () => string, signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      this.check(snapshot, readCurrent());
      const index = snapshot.diff.changes.indexOf(change);
      if (index < 0) throw new LocalizedError(staleMessage);
      const oldFrom = change.from + snapshot.diff.changes.slice(0, index).reduce((offset, item) => offset + item.deleted - item.added, 0);
      const lines = this.record.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const added = change.rows.filter((row) => row.kind === 'added').map((row) => row.text + (row.noNewline ? '' : '\n')).join('');
      const content = lines.slice(0, oldFrom).join('') + added + lines.slice(oldFrom + change.deleted).join('');
      await this.commit(content, this.record.content, signal);
    }, signal);
  }

  /** The host owns confirmation and editor-mode checks; apply must be one undoable transaction. */
  reject(snapshot: ReviewSnapshot, change: LineChange, target: RevertTarget, signal?: AbortSignal): Promise<void> {
    return this.run(() => {
      const current = target.getValue();
      this.check(snapshot, current);
      if (!snapshot.diff.changes.includes(change)) throw new LocalizedError(staleMessage);
      const edits = prepareTextRevert(change, current, this.record.content, staleMessage);
      signal?.throwIfAborted();
      target.apply(edits);
      return Promise.resolve();
    }, signal);
  }

  private check(snapshot: ReviewSnapshot, current?: string): void {
    if (this.disposed) throw new LocalizedError('审阅文档已关闭，请重新打开。');
    if (!this.snapshots.has(snapshot) || snapshot.record !== this.record || (current !== undefined && normalizeText(current) !== snapshot.current)) throw new LocalizedError(staleMessage);
  }

  dispose(): void { this.disposed = true; }

  private run(operation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const result = this.pending.then(() => {
      if (this.disposed) throw new LocalizedError('审阅文档已关闭，请重新打开。');
      signal?.throwIfAborted();
      return operation();
    });
    this.pending = result.catch(() => {});
    return result;
  }

  private async commit(content: string, undoContent: string | null, signal?: AbortSignal): Promise<void> {
    const next = Object.freeze(parseReviewRecord({ revision: this.record.revision + 1, content, undoContent }, this.limits));
    signal?.throwIfAborted();
    // Once persistence starts, finish publishing that exact decision; never re-read newer text.
    await this.save(next);
    this.record = next;
  }
}
