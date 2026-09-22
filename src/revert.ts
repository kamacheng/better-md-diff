import { normalizeText, type LineChange } from './diff';
import type { GitBaseline } from './git';
import type { ReadyDiffState } from './store';
import { LocalizedError } from './i18n';

export interface RevertEdit { from: number; to: number; text: string }
const staleMessage = '文档或 HEAD 已变化，请刷新差异后重新选择要还原的区块。';

/** Only an original, contiguous change is a write target; display hunks are never accepted. */
export function prepareChangeRevert(snapshot: ReadyDiffState, change: LineChange, current: string, baseline: GitBaseline): RevertEdit[] {
  if (!snapshot.diff.changes.includes(change)
    || normalizeText(current) !== snapshot.current
    || baseline.head !== snapshot.baseline.head
    || baseline.isNew !== snapshot.baseline.isNew
    || normalizeText(baseline.content) !== normalizeText(snapshot.baseline.content)) {
    throw new LocalizedError(staleMessage);
  }
  const currentLines = current.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const oldLines = baseline.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const offsets = [0];
  for (const line of currentLines) offsets.push(offsets.at(-1)! + line.length);
  const from = offsets[change.from], to = offsets[change.to];
  const added = change.rows.filter((row) => row.kind === 'added');
  const removed = change.rows.filter((row) => row.kind === 'deleted');
  const expected = added.map((row) => row.text + (row.noNewline ? '' : '\n')).join('');
  if (from === undefined || to === undefined || normalizeText(current.slice(from, to)) !== expected) throw new LocalizedError(staleMessage);
  const nearby = currentLines[change.from] ?? currentLines[change.from - 1] ?? '';
  const eol = nearby.match(/\r?\n$/)?.[0] ?? current.match(/\r?\n/)?.[0] ?? baseline.content.match(/\r?\n/)?.[0] ?? '\n';
  const text = removed.map((row) => {
    const original = oldLines[row.oldLine! - 1];
    if (original === undefined) throw new LocalizedError(staleMessage);
    return original.replace(/\r?\n/g, eol);
  }).join('');
  return [{ from, to, text }];
}

export interface RevertTarget { getValue(): string; apply(edits: readonly RevertEdit[]): void }

/** The only write occurs synchronously after the final cancellation and freshness checks. */
export async function executeChangeRevert(
  snapshot: ReadyDiffState,
  change: LineChange,
  readBaseline: () => Promise<GitBaseline>,
  target: RevertTarget,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const baseline = await readBaseline();
  signal.throwIfAborted();
  const edits = prepareChangeRevert(snapshot, change, target.getValue(), baseline);
  signal.throwIfAborted();
  target.apply(edits);
}
