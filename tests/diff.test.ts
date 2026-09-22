import { describe, expect, it } from 'vitest';
import { assertTextSize, changeAnchor, computeDiff } from '../src/diff';
import { DEFAULT_SETTINGS } from '../src/options';
const MAX_BYTES = DEFAULT_SETTINGS.maxFileMiB * 1024 * 1024;
const MAX_LINES = DEFAULT_SETTINGS.maxLines;

describe('Markdown line diff', () => {
  it('leaves identical and empty documents unchanged', () => {
    expect(computeDiff('', '').changes).toEqual([]);
    expect(computeDiff('# 标题\n正文\n', '# 标题\n正文\n').hunks).toEqual([]);
  });

  it('normalizes CRLF without ignoring whitespace changes', () => {
    expect(computeDiff('a\r\nb\r\n', 'a\nb\n').changes).toEqual([]);
    expect(computeDiff('a \n', 'a\n').changes[0]?.kind).toBe('modified');
  });

  it('groups adjacent additions and removals as modifications', () => {
    const diff = computeDiff('标题\n旧内容\n尾部\n', '标题\n新内容\n第二行\n尾部\n');
    expect(diff.changes).toMatchObject([{ kind: 'modified', from: 1, to: 3, added: 2, deleted: 1 }]);
    expect(diff.added).toBe(2);
    expect(diff.deleted).toBe(1);
    expect(diff.hunks[0]?.line).toBe(1);
    expect(diff.hunks[0]?.rows.map((row) => [row.oldLine, row.newLine])).toEqual([[1, 1], [2, null], [null, 2], [null, 3], [3, 4]]);
  });

  it('marks insertions at the beginning and end', () => {
    const diff = computeDiff('a\n', 'first\na\nlast\n');
    expect(diff.changes.map((change) => [change.kind, change.from, change.to])).toEqual([['added', 0, 1], ['added', 2, 3]]);
  });

  it('anchors pure deletions at the following line', () => {
    const diff = computeDiff('a\nremove\nb\n', 'a\nb\n');
    expect(diff.changes).toMatchObject([{ kind: 'deleted', from: 1, to: 1, added: 0, deleted: 1 }]);
    expect(changeAnchor(diff.changes[0]!, diff.lineCount)).toBe(1);
  });

  it('keeps EOF and entire-document deletions navigable', () => {
    const diff = computeDiff('a\nb\n', 'a\n');
    expect(changeAnchor(diff.changes[0]!, diff.lineCount)).toBe(1);
    expect(diff.hunks[0]?.line).toBe(1);
    const empty = computeDiff('a\nb\n', '');
    expect(empty.hunks[0]?.line).toBe(0);
    expect(changeAnchor(empty.changes[0]!, empty.lineCount)).toBe(0);
  });

  it('does not hide changes to the final newline', () => {
    const diff = computeDiff('a\n', 'a');
    expect(diff.changes[0]?.kind).toBe('modified');
    expect(diff.hunks[0]?.rows.find((row) => row.kind === 'added')?.noNewline).toBe(true);
  });

  it('splits distant hunks and keeps three lines of context', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\n`);
    const changed = [...lines];
    changed[2] = 'changed 2\n';
    changed[25] = 'changed 25\n';
    const diff = computeDiff(lines.join(''), changed.join(''));
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks.map((hunk) => hunk.line)).toEqual([2, 25]);
    expect(diff.hunks[1]?.rows[0]?.newLine).toBe(23);
    expect(diff.hunks[1]?.rows.at(-1)?.newLine).toBe(29);
  });

  it('supports zero context without losing the navigation anchor of pure deletions', () => {
    const before = 'keep 0\nkeep 1\ndeleted\nkeep 2\nkeep 3\n';
    const diff = computeDiff(before, before.replace('deleted\n', ''), 0);
    expect(diff.hunks[0]?.rows.map((row) => row.kind)).toEqual(['deleted']);
    expect(diff.hunks[0]?.line).toBe(2);
    expect(computeDiff('a\nb\n', 'a\n', 0).hunks[0]?.line).toBe(1);
  });

  it('uses configurable byte and line limits for both versions, including UTF-8 bytes', () => {
    const limits = { maxFileMiB: 3, maxLines: 30_000 };
    const text = '中文'.repeat(400_000);
    expect(() => assertTextSize(text)).toThrow('过大');
    expect(() => assertTextSize(text, limits)).not.toThrow();
    expect(() => assertTextSize('中'.repeat(1024 * 1024 + 1), limits)).toThrow('3 MiB');
    const lines = 'same\n'.repeat(25_000);
    expect(computeDiff(lines, `new\n${lines}`, 0, limits).added).toBe(1);
    expect(() => computeDiff(lines, '', 0)).toThrow('20000');
    expect(() => assertTextSize('a\0b', limits)).toThrow('二进制');
  });

  it('rejects oversized and binary inputs', () => {
    expect(() => computeDiff('', 'x'.repeat(MAX_BYTES + 1))).toThrow('过大');
    expect(() => computeDiff('', '\n'.repeat(MAX_LINES))).toThrow('过大');
    expect(() => computeDiff('a\0b', '')).toThrow('二进制');
  });

  it('handles Obsidian syntax as text without losing content', () => {
    const after = '---\naliases: [中文]\n---\n![[图片.png]]\n> [!note]\n> 修改\n| A | B |\n| - | - |\n```js\nalert(1)\n```\n';
    const diff = computeDiff('', after);
    expect(diff.hunks.flatMap((hunk) => hunk.rows).map((row) => row.text).join('\n') + '\n').toBe(after);
  });
});
