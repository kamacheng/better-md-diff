import { normalizeText, type DiffHunk } from './diff';
import type { GitBaseline } from './git';
import type { ReadyDiffState } from './store';

export interface RevertEdit {
  from: number;
  to: number;
  text: string;
}

const staleMessage = '文档或 HEAD 已变化，请刷新差异后重新选择要还原的区块。';

/** Build edits against the original buffer; context lines and all other hunks are untouched. */
export function prepareHunkRevert(snapshot: ReadyDiffState, hunk: DiffHunk, current: string, baseline: GitBaseline): RevertEdit[] {
  if (!snapshot.diff.hunks.includes(hunk)
    || normalizeText(current) !== snapshot.current
    || baseline.head !== snapshot.baseline.head
    || baseline.isNew !== snapshot.baseline.isNew
    || normalizeText(baseline.content) !== normalizeText(snapshot.baseline.content)) {
    throw new Error(staleMessage);
  }
  const currentLines = current.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const oldLines = baseline.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const offsets = [0];
  for (const line of currentLines) offsets.push(offsets.at(-1)! + line.length);
  const rows = hunk.rows;
  const followingLines = new Array<number>(rows.length + 1);
  let following = rows.every((row) => row.newLine === null) ? hunk.line : currentLines.length;
  followingLines[rows.length] = following;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.newLine !== null) following = rows[i]!.newLine! - 1;
    followingLines[i] = following;
  }
  const edits: RevertEdit[] = [];
  for (let start = 0; start < rows.length;) {
    if (rows[start]!.kind === 'context') { start++; continue; }
    let end = start;
    while (end < rows.length && rows[end]!.kind !== 'context') end++;
    const block = rows.slice(start, end);
    const added = block.filter((row) => row.kind === 'added');
    const removed = block.filter((row) => row.kind === 'deleted');
    const fromLine = added.length ? added[0]!.newLine! - 1 : followingLines[end]!;
    const from = offsets[fromLine];
    const to = offsets[fromLine + added.length];
    const expected = added.map((row) => row.text + (row.noNewline ? '' : '\n')).join('');
    if (from === undefined || to === undefined || normalizeText(current.slice(from, to)) !== expected) throw new Error(staleMessage);
    const nearby = currentLines[fromLine] ?? currentLines[fromLine - 1] ?? '';
    const eol = nearby.match(/\r?\n$/)?.[0] ?? current.match(/\r?\n/)?.[0] ?? baseline.content.match(/\r?\n/)?.[0] ?? '\n';
    const text = removed.map((row) => {
      const original = oldLines[row.oldLine! - 1];
      if (original === undefined) throw new Error(staleMessage);
      return original.replace(/\r?\n/g, eol);
    }).join('');
    edits.push({ from, to, text });
    start = end;
  }
  return edits;
}

export interface RevertTarget {
  getValue(): string;
  apply(edits: readonly RevertEdit[]): void;
}

/** The only write occurs synchronously after the final cancellation and freshness checks. */
export async function executeHunkRevert(
  snapshot: ReadyDiffState,
  hunk: DiffHunk,
  readBaseline: () => Promise<GitBaseline>,
  target: RevertTarget,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const baseline = await readBaseline();
  signal.throwIfAborted();
  const edits = prepareHunkRevert(snapshot, hunk, target.getValue(), baseline);
  signal.throwIfAborted();
  if (!edits.length) throw new Error('此区块已没有可还原的改动。');
  target.apply(edits);
}
