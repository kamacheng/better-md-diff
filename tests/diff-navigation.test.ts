// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { computeDiff } from '../src/diff';
import { findDiffLocation, revealDiffRow } from '../src/diff-navigation';

function separatedChanges() {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const changed = [...lines];
  changed[5] = 'changed five';
  changed[45] = 'changed forty-five';
  return computeDiff(lines.join('\n'), changed.join('\n'));
}

describe('source cursor to diff row mapping', () => {
  it('selects the exact current-side row inside a large hunk, not its header or deleted counterpart', () => {
    const before = Array.from({ length: 30 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 30 }, (_, i) => `new ${i}`).join('\n');
    const diff = computeDiff(before, after);
    const location = findDiffLocation(diff, 23)!;
    expect(location).toEqual({ hunkIndex: 0, rowIndex: 53 });
    expect(diff.hunks[location.hunkIndex]!.rows[location.rowIndex]).toMatchObject({ kind: 'added', newLine: 24 });
  });

  it('can locate unchanged context lines and other hunks', () => {
    const diff = separatedChanges();
    const location = findDiffLocation(diff, 44)!;
    expect(location.hunkIndex).toBe(1);
    expect(diff.hunks[location.hunkIndex]!.rows[location.rowIndex]).toMatchObject({ kind: 'context', newLine: 45 });
  });

  it('falls back to the nearest change when a source line is omitted from the diff', () => {
    const diff = separatedChanges();
    expect(findDiffLocation(diff, 18)?.hunkIndex).toBe(0);
    const location = findDiffLocation(diff, 35)!;
    expect(location.hunkIndex).toBe(1);
    expect(diff.hunks[location.hunkIndex]!.rows[location.rowIndex]!.kind).not.toBe('context');
  });

  it('anchors a deletion-only empty document to the first deleted row', () => {
    const diff = computeDiff('one\ntwo\nthree\n', '');
    expect(findDiffLocation(diff, 0)).toEqual({ hunkIndex: 0, rowIndex: 0 });
  });

  it('uses each deletion hunk anchor when context is hidden', () => {
    const diff = computeDiff('a\ngone 1\nb\nc\ngone 2\nd\n', 'a\nb\nc\nd\n', 0);
    expect(findDiffLocation(diff, 1)).toEqual({ hunkIndex: 0, rowIndex: 0 });
    expect(findDiffLocation(diff, 3)).toEqual({ hunkIndex: 1, rowIndex: 0 });
  });

  it('prefers the exact surviving line after a deletion', () => {
    const diff = computeDiff('one\nremoved\ntwo\n', 'one\ntwo\n');
    const location = findDiffLocation(diff, 1)!;
    expect(diff.hunks[location.hunkIndex]!.rows[location.rowIndex]).toMatchObject({ newLine: 2, text: 'two' });
  });

  it('has no navigation target when there are no differences', () => {
    expect(findDiffLocation(computeDiff('same\n', 'same\n'), 0)).toBeUndefined();
  });
});

describe('diff-only scrolling', () => {
  function elements(rowTop: number, rowHeight = 20) {
    const body = document.createElement('div');
    const row = document.createElement('div');
    body.append(row);
    body.scrollTop = 100;
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 200));
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, rowTop, 400, rowHeight));
    return { body, row };
  }

  it('does not move an already visible row', () => {
    const { body, row } = elements(150);
    revealDiffRow(body, row);
    expect(body.scrollTop).toBe(100);
  });

  it('reveals rows below and above the viewport', () => {
    const below = elements(350);
    revealDiffRow(below.body, below.row);
    expect(below.body.scrollTop).toBe(178);
    const above = elements(80);
    revealDiffRow(above.body, above.row);
    expect(above.body.scrollTop).toBe(72);
  });

  it('reveals the start of a wrapped row taller than the panel', () => {
    const { body, row } = elements(150, 500);
    revealDiffRow(body, row);
    expect(body.scrollTop).toBe(142);
  });

  it('keeps an adjacent old/new pair visible together when it fits', () => {
    const { body, row } = elements(110);
    const old = document.createElement('div');
    vi.spyOn(old, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 90, 400, 20));
    revealDiffRow(body, row, old);
    expect(body.scrollTop).toBe(82);
  });

  it('prioritizes the current row when an old/new pair is taller than the viewport', () => {
    const { body, row } = elements(400);
    const old = document.createElement('div');
    vi.spyOn(old, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 300));
    revealDiffRow(body, row, old);
    expect(body.scrollTop).toBe(228);
  });

  it('never changes focus or scrolls outer containers', () => {
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    const { body, row } = elements(350);
    const focus = vi.spyOn(row, 'focus');
    revealDiffRow(body, row);
    expect(document.activeElement).toBe(editor);
    expect(focus).not.toHaveBeenCalled();
    editor.remove();
  });
});
