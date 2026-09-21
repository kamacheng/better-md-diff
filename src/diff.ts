import { diffLines } from 'diff';

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_LINES = 20_000;
export type ChangeKind = 'added' | 'deleted' | 'modified';

export interface DiffRow {
  kind: 'context' | 'added' | 'deleted';
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noNewline: boolean;
}

export interface LineChange {
  kind: ChangeKind;
  /** Zero-based, end-exclusive range in the current document; deletions have an empty range. */
  from: number;
  to: number;
  added: number;
  deleted: number;
}

export interface DiffHunk {
  rows: DiffRow[];
  /** Zero-based navigation target in the current document. */
  line: number;
}

export interface DocumentDiff {
  changes: LineChange[];
  hunks: DiffHunk[];
  added: number;
  deleted: number;
  lineCount: number;
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function assertTextSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES || text.split('\n').length > MAX_LINES) {
    throw new Error('文档过大：首版支持不超过 2 MiB、20,000 行的 Markdown。');
  }
  if (text.includes('\0')) throw new Error('该文件包含二进制内容，无法作为 Markdown 比较。');
}

export function computeDiff(before: string, after: string, contextLines = 3): DocumentDiff {
  assertTextSize(before);
  assertTextSize(after);
  before = normalizeText(before);
  after = normalizeText(after);
  const parts = diffLines(before, after, { timeout: 200 });
  if (!parts) throw new Error('差异计算超时，请缩小文档或变更范围后重试。');

  const rows: DiffRow[] = [];
  const changes: LineChange[] = [];
  let oldLine = 1;
  let newLine = 1;
  let added = 0;
  let deleted = 0;
  let pending: LineChange | undefined;
  const flush = () => {
    if (!pending) return;
    pending.kind = pending.added && pending.deleted ? 'modified' : pending.added ? 'added' : 'deleted';
    changes.push(pending);
    pending = undefined;
  };

  for (const part of parts) {
    if (!part.added && !part.removed) flush();
    else pending ??= { kind: 'added', from: newLine - 1, to: newLine - 1, added: 0, deleted: 0 };
    const lines = part.value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    for (const line of lines) {
      const kind = part.added ? 'added' : part.removed ? 'deleted' : 'context';
      rows.push({
        kind,
        text: line.endsWith('\n') ? line.slice(0, -1) : line,
        oldLine: part.added ? null : oldLine++,
        newLine: part.removed ? null : newLine++,
        noNewline: !line.endsWith('\n'),
      });
      if (part.added) { added++; pending!.added++; pending!.to++; }
      if (part.removed) { deleted++; pending!.deleted++; }
    }
  }
  flush();

  const ranges: { from: number; to: number }[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'context') return;
    const from = Math.max(0, index - contextLines);
    const to = Math.min(rows.length, index + contextLines + 1);
    const last = ranges.at(-1);
    if (last && from <= last.to) last.to = to;
    else ranges.push({ from, to });
  });
  const lineCount = after.split('\n').length;
  const followingLines = new Array<number>(rows.length);
  let following = lineCount - 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.newLine !== null) following = rows[i]!.newLine! - 1;
    followingLines[i] = following;
  }
  const hunks = ranges.map(({ from, to }) => {
    const hunkRows = rows.slice(from, to);
    const firstChanged = hunkRows.findIndex((row) => row.kind !== 'context');
    return { rows: hunkRows, line: followingLines[from + firstChanged]! };
  });
  return { changes, hunks, added, deleted, lineCount };
}

/** Pure deletions anchor to the following line, or the last line at EOF. */
export function changeAnchor(change: LineChange, lineCount: number): number {
  return Math.min(change.from, Math.max(0, lineCount - 1));
}

export function changeLabel(changes: LineChange[]): string {
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const deleted = changes.reduce((sum, change) => sum + change.deleted, 0);
  return `相对 HEAD：新增 ${added} 行，删除 ${deleted} 行。查看差异`;
}
