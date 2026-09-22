import { describe, expect, it, vi } from 'vitest';
import { computeDiff, normalizeText } from '../src/diff';
import { executeChangeRevert, prepareChangeRevert, type RevertEdit } from '../src/revert';
import type { GitBaseline } from '../src/git';
import type { ReadyDiffState } from '../src/store';

function snapshot(before: string, current: string, context = 3): ReadyDiffState {
  return { status: 'ready', path: 'test.md', current: normalizeText(current), baseline: { content: before, head: 'head-a', isNew: false }, diff: computeDiff(before, current, context) };
}
function apply(text: string, edits: readonly RevertEdit[]): string {
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  return text;
}
function revertAll(before: string, current: string, context = 3): string {
  const state = snapshot(before, current, context);
  return apply(current, state.diff.changes.flatMap((change) => prepareChangeRevert(state, change, current, state.baseline)));
}

describe('independent change restoration', () => {
  it.each([0, 1, 3, 10])('restores only one of four nearby edits, regardless of context=%i', (context) => {
    const before = 'before\nreset.\nkeep\n## title\n\nremoved\nkeep again\nclaim.\nafter\n';
    const current = before.replace('reset.', 'reset').replace('## title', '## new title').replace('removed\n', '').replace('claim.', 'claim?');
    const state = snapshot(before, current, context);
    expect(state.diff.changes).toHaveLength(4);
    if (context === 3) expect(state.diff.hunks).toHaveLength(1);
    const expected = [current.replace('reset\n', 'reset.\n'), current.replace('## new title', '## title'), current.replace('keep again', 'removed\nkeep again'), current.replace('claim?', 'claim.')];
    for (let i = 0; i < 4; i++) {
      const edits = prepareChangeRevert(state, state.diff.changes[i]!, current, state.baseline);
      expect(edits).toHaveLength(1);
      expect(apply(current, edits)).toBe(expected[i]);
    }
  });

  it.each([
    ['alpha\nbeta\n', 'new\nbeta\n'], ['alpha\n', 'alpha\nnew\n'],
    ['alpha\nbeta\n', 'alpha\n'], ['alpha\nbeta', 'alpha\n'],
    ['alpha', 'alpha\n'], ['alpha\n', 'alpha'], ['alpha\n', ''],
    ['', 'new file\n'], ['\n\n', '\n'],
    ['中文 👩‍💻\n最后一行', '中文 🧪\n增加\n最后一行\n'],
  ])('restores %j from %j, including EOF and empty documents', (before, current) => {
    expect(revertAll(before, current)).toBe(before);
  });

  it('keeps contiguous old/new replacement rows together as one operation', () => {
    const state = snapshot('a\nb\nkeep\n', 'A\nB\nC\nkeep\n');
    expect(state.diff.changes).toHaveLength(1);
    const change = state.diff.changes[0]!;
    expect(change.rows.filter((row) => row.kind === 'deleted')).toHaveLength(2);
    expect(change.rows.filter((row) => row.kind === 'added')).toHaveLength(3);
    expect(apply(state.current, prepareChangeRevert(state, change, state.current, state.baseline))).toBe(state.baseline.content);
  });

  it('restores pure deletions at the correct anchor with no context', () => {
    const state = snapshot('a\nremoved 1\nb\nremoved 2\nc\n', 'a\nb\nc\n', 0);
    expect(apply(state.current, prepareChangeRevert(state, state.diff.changes[1]!, state.current, state.baseline))).toBe('a\nb\nremoved 2\nc\n');
  });

  it('preserves other edits, context and mixed line endings', () => {
    const state = snapshot('a\nkeep\nb\ntail\n', 'A\r\nkeep\nbb\r\ntail\n');
    const edits = prepareChangeRevert(state, state.diff.changes[0]!, 'A\r\nkeep\nbb\r\ntail\n', state.baseline);
    expect(apply('A\r\nkeep\nbb\r\ntail\n', edits)).toBe('a\r\nkeep\nbb\r\ntail\n');
  });

  it('rejects stale text, changed HEAD/baseline, a cloned change or a display hunk', () => {
    const state = snapshot('old\nkeep\nother\n', 'new\nkeep\nchanged\n');
    const change = state.diff.changes[0]!;
    expect(() => prepareChangeRevert(state, change, 'newer\n', state.baseline)).toThrow('已变化');
    expect(() => prepareChangeRevert(state, change, state.current, { ...state.baseline, head: 'head-b' })).toThrow('已变化');
    expect(() => prepareChangeRevert(state, change, state.current, { ...state.baseline, content: 'different\n' })).toThrow('已变化');
    expect(() => prepareChangeRevert(state, { ...change }, state.current, state.baseline)).toThrow('已变化');
    // Display groups must not accidentally become write targets again.
    expect(() => prepareChangeRevert(state, Object.assign({}, change, state.diff.hunks[0]), state.current, state.baseline)).toThrow('已变化');
  });

  it('clears a newly tracked file without deleting it', () => {
    const state = snapshot('', 'new file\n'); state.baseline.isNew = true; state.baseline.head = null;
    expect(apply(state.current, prepareChangeRevert(state, state.diff.changes[0]!, state.current, state.baseline))).toBe('');
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
  const change = state.diff.changes[0]!;
  it('applies one change as one undoable editor operation', async () => {
    const target = { getValue: () => state.current, apply: vi.fn() };
    await executeChangeRevert(state, change, async () => state.baseline, target, new AbortController().signal);
    expect(target.apply).toHaveBeenCalledExactlyOnceWith([{ from: 0, to: 4, text: 'old\n' }]);
  });
  it('does not start a Git read after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const read = vi.fn(async () => state.baseline);
    const target = { getValue: () => state.current, apply: vi.fn() };
    await expect(executeChangeRevert(state, change, read, target, controller.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(target.apply).not.toHaveBeenCalled();
  });
  it('does not write if the dialog closes while reading Git', async () => {
    const controller = new AbortController();
    let resolve!: (value: GitBaseline) => void;
    const pending = new Promise<GitBaseline>((done) => { resolve = done; });
    const target = { getValue: () => state.current, apply: vi.fn() };
    const operation = executeChangeRevert(state, change, () => pending, target, controller.signal);
    controller.abort(); resolve(state.baseline);
    await expect(operation).rejects.toThrow(); expect(target.apply).not.toHaveBeenCalled();
  });
  it('checks the newest buffer after the independent Git read', async () => {
    let text = state.current;
    const target = { getValue: () => text, apply: vi.fn() };
    const read = async () => { text = 'newer text\n'; return state.baseline; };
    await expect(executeChangeRevert(state, change, read, target, new AbortController().signal)).rejects.toThrow('已变化');
    expect(target.apply).not.toHaveBeenCalled();
  });
  it('does not write on Git failure or changed HEAD', async () => {
    const target = { getValue: () => state.current, apply: vi.fn() };
    await expect(executeChangeRevert(state, change, async () => { throw new Error('Git failed'); }, target, new AbortController().signal)).rejects.toThrow('Git failed');
    await expect(executeChangeRevert(state, change, async () => ({ ...state.baseline, head: 'head-b' }), target, new AbortController().signal)).rejects.toThrow('已变化');
    expect(target.apply).not.toHaveBeenCalled();
  });
});
