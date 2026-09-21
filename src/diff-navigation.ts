import type { DocumentDiff } from './diff';

export interface DiffLocation {
  hunkIndex: number;
  rowIndex: number;
}

/** Source lines are zero-based; prefer the exact current-side row, including context. */
export function findDiffLocation(diff: DocumentDiff, line: number): DiffLocation | undefined {
  let closest: DiffLocation | undefined;
  let distance = Infinity;
  let closestHasCurrentLine = false;
  for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
    const rows = diff.hunks[hunkIndex]!.rows;
    let nextLine = rows.every((row) => row.newLine === null) ? diff.hunks[hunkIndex]!.line : diff.lineCount - 1;
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
      const row = rows[rowIndex]!;
      if (row.newLine !== null) {
        nextLine = row.newLine - 1;
        if (nextLine === line) return { hunkIndex, rowIndex };
      }
      if (row.kind === 'context') continue;
      // Deleted rows anchor to the next current line, or EOF if no current row follows.
      const nextDistance = Math.abs(nextLine - line);
      const hasCurrentLine = row.newLine !== null;
      const preferredTie = nextDistance === distance && (
        (hasCurrentLine && !closestHasCurrentLine)
        || (hasCurrentLine === closestHasCurrentLine && closest?.hunkIndex === hunkIndex && rowIndex < closest.rowIndex)
      );
      if (nextDistance < distance || preferredTie) {
        closest = { hunkIndex, rowIndex };
        distance = nextDistance;
        closestHasCurrentLine = hasCurrentLine;
      }
    }
  }
  return closest;
}

/** Scroll only the diff body, never the outer workspace or the focused editor. */
export function revealDiffRow(body: HTMLElement, row: HTMLElement, companion?: HTMLElement): void {
  const viewport = body.getBoundingClientRect();
  let target: Pick<DOMRect, 'top' | 'bottom' | 'height'> = row.getBoundingClientRect();
  const top = viewport.top + 8;
  const bottom = viewport.bottom - 8;
  if (companion) {
    const other = companion.getBoundingClientRect();
    const pairTop = Math.min(target.top, other.top);
    const pairBottom = Math.max(target.bottom, other.bottom);
    if (pairBottom - pairTop <= bottom - top) target = { top: pairTop, bottom: pairBottom, height: pairBottom - pairTop };
  }
  if (target.top < top || target.height > bottom - top) body.scrollTop += target.top - top;
  else if (target.bottom > bottom) body.scrollTop += target.bottom - bottom;
}
