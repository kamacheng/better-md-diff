import { describe, expect, it, vi } from 'vitest';
import { computeDiff, normalizeText } from '../src/diff';
import { executeHunkRevert, prepareHunkRevert, type RevertEdit } from '../src/revert';
import type { GitBaseline } from '../src/git';
import type { ReadyDiffState } from '../src/store';

function snapshot(before: string, current: string): ReadyDiffState {
  return { status: 'ready', path: 'test.md', current: normalizeText(current), baseline: { content: before, head: 'head-a', isNew: false }, diff: computeDiff(before, current) };
}
function apply(text: string, edits: readonly RevertEdit[]): string {
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  return text;
}
function revertAll(before: string, current: string, contextLines = 3): string {
  const state = snapshot(before, current);
  if (contextLines !== 3) state.diff = computeDiff(before, current, contextLines);
  return apply(current, state.diff.hunks.flatMap((hunk) => prepareHunkRevert(state, hunk, current, state.baseline)));
}

describe('single-hunk restoration', () => {
  it.each([
    ['alpha\nbeta\n', 'new\nbeta\n'],
    ['alpha\n', 'alpha\nnew\n'],
    ['alpha\nbeta\n', 'alpha\n'],
    ['alpha\nbeta', 'alpha\n'],
    ['alpha', 'alpha\n'],
    ['alpha\n', 'alpha'],
    ['alpha\n', ''],
    ['', 'new file\n'],
    ['\n\n', '\n'],
    ['中文 👩‍💻\n最后一行', '中文 🧪\n增加\n最后一行\n'],
  ])('restores %j from %j, including EOF and empty documents', (before, current) => {
    expect(revertAll(before, current)).toBe(before);
  });

  it('restores deletion-only hunks in the correct place when context is set to zero', () => {
    const before = 'a\nremoved 1\nb\nremoved 2\nc\n';
    const current = 'a\nb\nc\n';
    const state = snapshot(before, current);
    state.diff = computeDiff(before, current, 0);
    expect(state.diff.hunks).toHaveLength(2);
    const edits = state.diff.hunks.flatMap((hunk) => prepareHunkRevert(state, hunk, current, state.baseline));
    expect(apply(current, edits)).toBe(before);
  });

  it('leaves other hunks unchanged', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
    const current = before.replace('line 1\n', 'first change\n').replace('line 25\n', 'second change\n');
    const state = snapshot(before, current);
    expect(state.diff.hunks).toHaveLength(2);
    const edits = prepareHunkRevert(state, state.diff.hunks[0]!, current, state.baseline);
    expect(apply(current, edits)).toBe(before.replace('line 25\n', 'second change\n'));
  });

  it('restores multiple edits in one hunk without replacing its context or unrelated EOLs', () => {
    const before = 'a\nkeep\nb\ntail\n';
    const current = 'A\r\nkeep\nbb\r\ntail\n';
    const state = snapshot(before, current);
    const edits = prepareHunkRevert(state, state.diff.hunks[0]!, current, state.baseline);
    expect(edits).toHaveLength(2);
    expect(apply(current, edits)).toBe('a\r\nkeep\nb\r\ntail\n');
  });

  it('refuses stale text, a changed HEAD, changed baseline content, or a foreign hunk', () => {
    const state = snapshot('old\n', 'new\n');
    const hunk = state.diff.hunks[0]!;
    expect(() => prepareHunkRevert(state, hunk, 'newer\n', state.baseline)).toThrow('已变化');
    expect(() => prepareHunkRevert(state, hunk, state.current, { ...state.baseline, head: 'head-b' })).toThrow('已变化');
    expect(() => prepareHunkRevert(state, hunk, state.current, { ...state.baseline, content: 'different\n' })).toThrow('已变化');
    expect(() => prepareHunkRevert(state, { ...hunk }, state.current, state.baseline)).toThrow('已变化');
  });

  it('clears an added file against an empty HEAD baseline, without a file deletion operation', () => {
    const state = snapshot('', 'new file\n'); state.baseline.isNew = true; state.baseline.head = null;
    expect(apply(state.current, prepareHunkRevert(state, state.diff.hunks[0]!, state.current, state.baseline))).toBe('');
  });

  it('round-trips deterministic mixed insertions, deletions and replacements', () => {
    let seed = 17;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let sample = 0; sample < 200; sample++) {
      const old: string[] = [], current: string[] = [];
      for (let i = 0; i < 35; i++) {
        const text = `行 ${i} 🧪`;
        old.push(text);
        if (random() < 0.3) current.push(`插入 ${i}`);
        if (random() < 0.2) continue;
        current.push(random() < 0.25 ? `修改 ${text}` : text);
      }
      const before = old.join('\n') + (random() < 0.5 ? '\n' : '');
      const after = current.join('\n') + (random() < 0.5 ? '\n' : '');
      for (const context of [0, 1, 3, 10]) expect(revertAll(before, after, context)).toBe(before);
    }
  });
});

describe('confirmation write barrier', () => {
  const state = snapshot('old\n', 'new\n');
  const hunk = state.diff.hunks[0]!;

  it('applies all edits as a single operation after checking the fresh baseline', async () => {
    const target = { getValue: () => state.current, apply: vi.fn() };
    await executeHunkRevert(state, hunk, async () => state.baseline, target, new AbortController().signal);
    expect(target.apply).toHaveBeenCalledExactlyOnceWith([{ from: 0, to: 4, text: 'old\n' }]);
  });

  it('does not start a Git read if confirmation was already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    const read = vi.fn(async () => state.baseline);
    const target = { getValue: () => state.current, apply: vi.fn() };
    await expect(executeHunkRevert(state, hunk, read, target, controller.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(target.apply).not.toHaveBeenCalled();
  });

  it('does not write if the dialog is closed while Git is being read', async () => {
    const controller = new AbortController();
    let resolve!: (value: GitBaseline) => void;
    const pending = new Promise<GitBaseline>((done) => { resolve = done; });
    const target = { getValue: () => state.current, apply: vi.fn() };
    const operation = executeHunkRevert(state, hunk, () => pending, target, controller.signal);
    controller.abort(); resolve(state.baseline);
    await expect(operation).rejects.toThrow();
    expect(target.apply).not.toHaveBeenCalled();
  });

  it('re-reads the buffer after Git returns, rejecting edits made during confirmation', async () => {
    let text = state.current;
    const target = { getValue: () => text, apply: vi.fn() };
    const read = async () => { text = 'user typed something newer\n'; return state.baseline; };
    await expect(executeHunkRevert(state, hunk, read, target, new AbortController().signal)).rejects.toThrow('已变化');
    expect(target.apply).not.toHaveBeenCalled();
  });

  it('does not write on Git failure or changed HEAD', async () => {
    const target = { getValue: () => state.current, apply: vi.fn() };
    await expect(executeHunkRevert(state, hunk, async () => { throw new Error('Git failed'); }, target, new AbortController().signal)).rejects.toThrow('Git failed');
    await expect(executeHunkRevert(state, hunk, async () => ({ ...state.baseline, head: 'head-b' }), target, new AbortController().signal)).rejects.toThrow('已变化');
    expect(target.apply).not.toHaveBeenCalled();
  });
});
