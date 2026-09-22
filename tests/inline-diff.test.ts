// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { computeDiff, type DiffRow } from '../src/diff';
import { highlightHunks, highlightRows, pairDiffRows, renderHighlightedText } from '../src/inline-diff';
import { installObsidianDom } from './helpers/obsidian-dom';

installObsidianDom(document);

function compare(before: string, after: string) {
  const rows = computeDiff(before, after).hunks.flatMap((hunk) => hunk.rows);
  const result = highlightRows(rows);
  const changed = (kind: DiffRow['kind']) => rows.filter((row) => row.kind === kind)
    .map((row) => result.segments.get(row)!.filter((segment) => segment.changed).map((segment) => segment.text).join(''));
  return { rows, result, changed };
}

describe('intraline highlights in the diff panel', () => {
  it('never pairs independent hunks when zero context hides their separator', () => {
    const diff = computeDiff('alpha old\nkeep 1\nkeep 2\nbeta old\n', 'keep 1\nkeep 2\nalpha new\nbeta old\n', 0);
    expect(diff.hunks).toHaveLength(2);
    const result = highlightHunks(diff.hunks);
    expect(result.pairs.size).toBe(0);
    for (const hunk of diff.hunks) {
      for (const row of hunk.rows) expect(result.segments.get(row)).toEqual([{ text: row.text, changed: true }]);
    }
  });

  it('highlights only a removed Chinese phrase, not the rest of the line', () => {
    const { changed } = compare('仅为验证对照组，不是备选方案。\n', '仅为验证对照组。\n');
    expect(changed('deleted')).toEqual(['，不是备选方案']);
    expect(changed('added')).toEqual(['']);
  });

  it('highlights insertions and replacements in Chinese and code', () => {
    const text = compare('奖励 100 金币。\n', '奖励 200 金币和宝石。\n');
    expect(text.changed('deleted')).toEqual(['1']);
    expect(text.changed('added')).toEqual(['2和宝石']);
    const code = compare('greet("World");\n', 'greet("World", 3); // Hello!\n');
    expect(code.changed('deleted')).toEqual(['']);
    expect(code.changed('added')).toEqual([', 3 // Hello!']);
  });

  it('isolates the two trailing spaces added by save-time formatting', () => {
    const { rows, result, changed } = compare('- 原来的正文\n  连续正文\n  最后一行\n', '- 原来的正文  \n  连续正文  \n  最后一行\n');
    expect(changed('deleted')).toEqual(['', '']);
    expect(changed('added')).toEqual(['  ', '  ']);
    expect(rows.filter((row) => row.kind === 'context').every((row) => result.segments.get(row)!.every((segment) => !segment.changed))).toBe(true);
  });

  it('does not mis-pair subsequent lines when a replacement adds a line', () => {
    const { changed } = compare('alpha old\nbeta old\n', 'alpha new\ninserted line\nbeta new\n');
    expect(changed('deleted')).toEqual(['old', 'old']);
    expect(changed('added')).toEqual(['new', 'inserted line', 'new']);
  });

  it('keeps separate change blocks independent', () => {
    const { changed } = compare('first old\nunchanged\nlast old\n', 'first new\nunchanged\nlast new\n');
    expect(changed('deleted')).toEqual(['old', 'old']);
    expect(changed('added')).toEqual(['new', 'new']);
  });

  it('highlights whole added/deleted lines and preserves blank lines', () => {
    expect(compare('', '新增一行\n\n').changed('added')).toEqual(['新增一行', '']);
    expect(compare('删除一行\n', '').changed('deleted')).toEqual(['删除一行']);
  });

  it('does not split emoji sequences or combining characters', () => {
    const { changed } = compare('状态 👩‍💻 café\n', '状态 👨‍💻 cafè\n');
    expect(changed('deleted')).toEqual(['👩‍💻é']);
    expect(changed('added')).toEqual(['👨‍💻è']);
  });

  it('preserves every source character and leaves final-newline metadata intact', () => {
    const { rows, result } = compare('a\nline\n', 'a\nline');
    for (const row of rows) expect(result.segments.get(row)!.map((segment) => segment.text).join('')).toBe(row.text);
    expect(rows.find((row) => row.kind === 'added')?.noNewline).toBe(true);
    expect(rows.filter((row) => row.kind !== 'context').every((row) => result.segments.get(row)!.every((segment) => !segment.changed))).toBe(true);
  });

  it('bounds expensive intraline work, retaining correct line-level changes', () => {
    const before = 'a'.repeat(21_000);
    const after = 'b'.repeat(21_000);
    const { rows, result } = compare(before, after);
    expect(result.limited).toBe(true);
    for (const row of rows) expect(result.segments.get(row)).toEqual([{ text: row.text, changed: true }]);
  });

  it('displays corresponding old and new rows next to each other without mutating the diff', () => {
    const { rows, result } = compare('alpha old\nbeta old\n', 'alpha new\nbeta new\n');
    const original = [...rows];
    const display = pairDiffRows(rows, result.pairs);
    expect(display.map((row) => row.text)).toEqual(['alpha old', 'alpha new', 'beta old', 'beta new']);
    expect(display.map((row) => row.kind)).toEqual(['deleted', 'added', 'deleted', 'added']);
    expect(rows).toEqual(original);
    expect(new Set(display)).toEqual(new Set(rows));
    expect(result.pairs.get(display[0]!)).toBe(display[1]);
    expect(result.pairs.get(display[1]!)).toBe(display[0]);
  });

  it('keeps independent inserted rows in their current-side order between pairs', () => {
    const { rows, result } = compare('alpha old\nbeta old\n', 'alpha new\ninserted line\nbeta new\n');
    expect(pairDiffRows(rows, result.pairs).map((row) => row.text)).toEqual(['alpha old', 'alpha new', 'inserted line', 'beta old', 'beta new']);
  });

  it('still pairs large replacements when intraline highlighting falls back', () => {
    const { rows, result } = compare('a'.repeat(21_000), 'b'.repeat(21_000));
    expect(result.limited).toBe(true);
    expect(result.pairs.get(rows[0]!)).toBe(rows[1]);
    expect(pairDiffRows(rows, result.pairs)).toEqual(rows);
  });

  it('renders deeper highlights and visible whitespace without changing copied text', () => {
    const { rows, result } = compare('正文\n', '正文 \t \n');
    const row = rows.find((candidate) => candidate.kind === 'added')!;
    const code = document.createElement('code');
    renderHighlightedText(code, row, result.segments.get(row)!);
    expect(code.textContent).toBe(row.text);
    expect(code.querySelector('.bmd-inline-added')?.textContent).toBe(' \t ');
    expect(Array.from(code.querySelectorAll('.bmd-inline-whitespace')).map((el) => el.getAttribute('data-symbol'))).toEqual(['·', '→', '·']);
  });

  it('renders a long run of spaces with one marker node and preserves all source spaces', () => {
    const { rows, result } = compare('', ' '.repeat(50_000));
    const code = document.createElement('code');
    renderHighlightedText(code, rows[0]!, result.segments.get(rows[0]!)!);
    expect(code.textContent).toBe(' '.repeat(50_000));
    expect(code.querySelectorAll('.bmd-inline-whitespace')).toHaveLength(1);
    expect(code.querySelector('.bmd-inline-whitespace')?.getAttribute('data-symbol')).toBe('·'.repeat(50_000));
  });

  it('uses text nodes instead of executing note HTML', () => {
    const { rows, result } = compare('', '<img src=x onerror="alert(1)">\n');
    const row = rows[0]!;
    const code = document.createElement('code');
    renderHighlightedText(code, row, result.segments.get(row)!);
    expect(code.querySelector('img')).toBeNull();
    expect(code.textContent).toBe(row.text);
    expect(code.querySelector('.bmd-inline-added')).not.toBeNull();
  });
});
