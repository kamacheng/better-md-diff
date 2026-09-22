import { diffLines } from 'diff';
import { LocalizedError, t } from './i18n';

import { DEFAULT_SETTINGS, type DocumentLimits } from './options';
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
  /** One contiguous edit, independent of the context used to display hunks. */
  rows: DiffRow[];
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

export function assertTextSize(text: string, limits: DocumentLimits = DEFAULT_SETTINGS): void {
  let lines = 1;
  // Count without allocating an array containing every line of a large document.
  for (let i = 0; i < text.length && lines <= limits.maxLines; i++) if (text.charCodeAt(i) === 10) lines++;
  if (Buffer.byteLength(text, 'utf8') > limits.maxFileMiB * 1024 * 1024 || lines > limits.maxLines) {
    throw new LocalizedError('文档过大：当前上限为 {size} MiB、{lines} 行，可在插件设置中调整。', { size: limits.maxFileMiB, lines: limits.maxLines });
  }
  if (text.includes('\0')) throw new LocalizedError('该文件包含二进制内容，无法作为 Markdown 比较。');
}

export function computeDiff(before: string, after: string, contextLines = 3, limits: DocumentLimits = DEFAULT_SETTINGS): DocumentDiff {
  assertTextSize(before, limits);
  assertTextSize(after, limits);
  before = normalizeText(before);
  after = normalizeText(after);
  const parts = diffLines(before, after, { timeout: 200 });
  if (!parts) throw new LocalizedError('差异计算超时，请缩小文档或变更范围后重试。');

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
    else pending ??= { kind: 'added', from: newLine - 1, to: newLine - 1, added: 0, deleted: 0, rows: [] };
    const lines = part.value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    for (const line of lines) {
      const kind = part.added ? 'added' : part.removed ? 'deleted' : 'context';
      const row: DiffRow = {
        kind,
        text: line.endsWith('\n') ? line.slice(0, -1) : line,
        oldLine: part.added ? null : oldLine++,
        newLine: part.removed ? null : newLine++,
        noNewline: !line.endsWith('\n'),
      };
      rows.push(row);
      if (kind !== 'context') pending!.rows.push(row);
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

/** Human-readable operation scope, not the first line of a context group. */
export function changeRange(change: LineChange): string {
  if (change.kind === 'deleted') {
    const from = change.rows[0]!.oldLine!;
    const to = change.rows[change.rows.length - 1]!.oldLine!;
    return from === to ? t('恢复 HEAD 第 {from} 行', { from }) : t('恢复 HEAD 第 {from}–{to} 行', { from, to });
  }
  const from = change.from + 1, to = change.to;
  return from === to ? t('当前第 {from} 行', { from }) : t('当前第 {from}–{to} 行', { from, to });
}

export function changeLabel(changes: LineChange[]): string {
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const deleted = changes.reduce((sum, change) => sum + change.deleted, 0);
  return t('相对 HEAD：新增 {added} 行，删除 {deleted} 行。查看差异', { added, deleted });
}
