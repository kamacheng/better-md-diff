import { describe, expect, it } from 'vitest';
import { createReviewRecord, ReviewDocument, type ReviewRecord } from '../src/review';

function document(content: string) {
  let saved: ReviewRecord = createReviewRecord(content);
  const review = new ReviewDocument('note.md', saved, async (record) => { saved = record; });
  return { review, saved: () => saved };
}

describe('document acceptance', () => {
  it('rechecks disposal after the host reads the editor during rejection', async () => {
    const { review } = document('old\n');
    const snapshot = review.snapshot('new\n');
    let applied = false;
    await expect(review.reject(snapshot, snapshot.diff.changes[0]!, {
      getValue: () => { review.dispose(); return 'new\n'; },
      apply: () => { applied = true; },
    })).rejects.toThrow('关闭');
    expect(applied).toBe(false);
  });

  it('does not commit if a final editor check cancels the operation', async () => {
    const { review, saved } = document('old\n');
    const controller = new AbortController();
    await expect(review.acceptAll(review.snapshot('new\n'), () => {
      controller.abort();
      return 'new\n';
    }, controller.signal)).rejects.toThrow();
    expect(saved().content).toBe('old\n');
  });

  it.each([
    ['', 'new file\n'], ['a\nb\n', 'prefix\na\nB\n'], ['a\nb\n', 'a\n'],
    ['a', 'a\n'], ['a\n', 'a'], ['a\n', ''], ['\n\n', '\n'],
    ['中文 👩‍💻\n最后一行', '中文 🧪\n增加\n最后一行\n'],
  ])('accepts independent edits in reverse order from %j to %j', async (before, current) => {
    const { review } = document(before);
    let snapshot = review.snapshot(current, 0);
    while (snapshot.diff.changes.length) {
      await review.accept(snapshot, snapshot.diff.changes.at(-1)!, () => current);
      snapshot = review.snapshot(current, 0);
    }
    expect(snapshot.record.content).toBe(current);
  });

  it('accepts an insertion after earlier unaccepted insertions without shifting its old-side anchor', async () => {
    const { review, saved } = document('a\nb\nc\n');
    const current = 'first\na\nb\nlast\nc\n';
    const snapshot = review.snapshot(current);
    await review.accept(snapshot, snapshot.diff.changes[1]!, () => current);
    expect(saved().content).toBe('a\nb\nlast\nc\n');
  });

  it('does not publish failed persistence and permits a retry', async () => {
    let fail = true;
    const review = new ReviewDocument('note.md', createReviewRecord('old\n'), async () => {
      if (fail) throw new Error('disk full');
    });
    const snapshot = review.snapshot('new\n');
    await expect(review.acceptAll(snapshot, () => 'new\n')).rejects.toThrow('disk full');
    expect(review.snapshot('new\n').record.content).toBe('old\n');
    fail = false;
    await review.acceptAll(snapshot, () => 'new\n');
    expect(review.snapshot('new\n').record.content).toBe('new\n');
  });

  it('publishes only the checked content after persistence, leaving later edits pending', async () => {
    let started!: () => void, finish!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const review = new ReviewDocument('note.md', createReviewRecord('old\n'), async () => { started(); await gate; });
    let current = 'checked\n';
    const operation = review.acceptAll(review.snapshot(current), () => current);
    await began;
    expect(review.snapshot(current).record.content).toBe('old\n');
    current = 'later\n';
    finish(); await operation;
    expect(review.snapshot(current).record.content).toBe('checked\n');
    expect(review.snapshot(current).diff.changes).toHaveLength(1);
  });

  it('rejects forged targets, stale rejection and cancellation without applying an edit', async () => {
    const { review } = document('old\n');
    const snapshot = review.snapshot('new\n');
    const change = snapshot.diff.changes[0]!;
    let current = 'new\n', applied = false;
    const target = { getValue: () => current, apply: () => { applied = true; } };
    await expect(review.accept(snapshot, { ...change }, () => current)).rejects.toThrow('已变化');
    current = 'later\n';
    await expect(review.reject(snapshot, change, target)).rejects.toThrow('已变化');
    current = 'new\n';
    const controller = new AbortController(); controller.abort();
    await expect(review.reject(snapshot, change, target, controller.signal)).rejects.toThrow();
    expect(applied).toBe(false);
    expect(review.snapshot(current).record.content).toBe('old\n');
  });

  it('undoes only the latest successful acceptance and does not offer redo', async () => {
    const { review } = document('a\nkeep\nb\n');
    const current = 'A\nkeep\nB\n';
    let snapshot = review.snapshot(current);
    await review.accept(snapshot, snapshot.diff.changes[0]!, () => current);
    await review.acceptAll(review.snapshot(current), () => current);
    await review.undoAcceptance(review.snapshot(current));
    snapshot = review.snapshot(current);
    expect(snapshot.record.content).toBe('A\nkeep\nb\n');
    await review.undoAcceptance(snapshot);
    expect(review.snapshot(current).record).toBe(snapshot.record);
  });

  it('round-trips seeded mixed edits while accepting in alternating order', async () => {
    let seed = 23;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let sample = 0; sample < 80; sample++) {
      const before: string[] = [], after: string[] = [];
      for (let line = 0; line < 20; line++) {
        const text = `原文 ${line} 🧪`;
        before.push(text);
        if (random() < 0.3) after.push(`插入 ${line}`);
        if (random() < 0.2) continue;
        after.push(random() < 0.3 ? `改写 ${line}` : text);
      }
      const current = after.join('\n') + (random() < 0.5 ? '\n' : '');
      const { review } = document(before.join('\n') + (random() < 0.5 ? '\n' : ''));
      for (let turn = 0; turn < 40; turn++) {
        const snapshot = review.snapshot(current, sample % 4);
        if (!snapshot.diff.changes.length) break;
        await review.accept(snapshot, snapshot.diff.changes[turn % 2 ? 0 : snapshot.diff.changes.length - 1]!, () => current);
      }
      expect(review.snapshot(current).record.content).toBe(current);
    }
  });

  it('cancels queued rejection without editing after an earlier acceptance completes', async () => {
    let begin!: () => void, finish!: () => void;
    const began = new Promise<void>((resolve) => { begin = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const review = new ReviewDocument('note.md', createReviewRecord('old\n'), async () => { begin(); await gate; });
    const snapshot = review.snapshot('new\n');
    const accept = review.acceptAll(snapshot, () => 'new\n');
    await began;
    const controller = new AbortController();
    let applied = false;
    const reject = review.reject(snapshot, snapshot.diff.changes[0]!, { getValue: () => 'new\n', apply: () => { applied = true; } }, controller.signal);
    const result = Promise.allSettled([accept, reject]);
    controller.abort(); finish();
    expect((await result).map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
    expect(applied).toBe(false);
  });

  it('validates restored recognition and undo data before using it', () => {
    expect(() => new ReviewDocument('note.md', { revision: -1, content: 'old', undoContent: null }, async () => {})).toThrow('认可记录');
    expect(() => new ReviewDocument('note.md', { revision: 0, content: 'old', undoContent: '\0' }, async () => {})).toThrow('二进制');
  });

  it('rejects a partial acceptance whose hybrid baseline exceeds the document limits', async () => {
    const before = 'a\nb\nc\n', current = 'new\na\nb\n';
    const review = new ReviewDocument('note.md', createReviewRecord(before), async () => {}, { maxFileMiB: 1, maxLines: 4 });
    const snapshot = review.snapshot(current);
    await expect(review.accept(snapshot, snapshot.diff.changes[0]!, () => current)).rejects.toThrow('上限');
    expect(review.snapshot(current).record.content).toBe(before);
  });

  it('does not erase undo when accepting a document that has no pending changes', async () => {
    const { review, saved } = document('old\n');
    await review.acceptAll(review.snapshot('new\n'), () => 'new\n');
    await review.acceptAll(review.snapshot('new\n'), () => 'new\n');
    expect(saved().revision).toBe(1);
    await review.undoAcceptance(review.snapshot('new\n'));
    expect(saved().content).toBe('old\n');
  });

  it('keeps caller mutations from changing recognition or the displayed write target', () => {
    const seed = createReviewRecord('old\n');
    const review = new ReviewDocument('note.md', seed, async () => {});
    seed.content = 'changed outside\n';
    const snapshot = review.snapshot('new\n');
    expect(snapshot.record.content).toBe('old\n');
    expect(() => { snapshot.current = 'forged\n'; }).toThrow();
    expect(() => { snapshot.diff.changes[0]!.from = 100; }).toThrow();
    expect(() => { snapshot.diff.changes[0]!.rows[0]!.text = 'forged'; }).toThrow();
  });

  it('rejects one pending change into a single edit without undoing another accepted change', async () => {
    const { review } = document('A1\nkeep\nB1\n');
    let current = 'A2\r\nkeep\nB2\r\n';
    const first = review.snapshot(current);
    await review.accept(first, first.diff.changes[0]!, () => current);
    const next = review.snapshot(current);
    let transactions = 0;
    await review.reject(next, next.diff.changes[0]!, {
      getValue: () => current,
      apply: (edits) => {
        transactions++;
        expect(edits).toHaveLength(1);
        const edit = edits[0]!;
        current = current.slice(0, edit.from) + edit.text + current.slice(edit.to);
      },
    });
    expect(current).toBe('A2\r\nkeep\nB1\r\n');
    expect(transactions).toBe(1);
    expect(review.snapshot(current).record.content).toBe('A2\nkeep\nB1\n');
    expect(review.snapshot(current).diff.changes).toHaveLength(0);
  });

  it('rejects stale text, foreign snapshots, and queued decisions made against an older recognition state', async () => {
    const { review } = document('old\n');
    const snapshot = review.snapshot('new\n');
    await expect(review.acceptAll(snapshot, () => 'newer\n')).rejects.toThrow('已变化');
    await expect(review.acceptAll({ ...snapshot }, () => 'new\n')).rejects.toThrow('已变化');
    const results = await Promise.allSettled([
      review.acceptAll(snapshot, () => 'new\n'),
      review.acceptAll(snapshot, () => 'new\n'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(review.snapshot('new\n').record.revision).toBe(1);
  });

  it('accepts all and can undo that decision without reverting later text, including after reload', async () => {
    const { review, saved } = document('original\n');
    await review.acceptAll(review.snapshot('accepted\n'), () => 'accepted\n');
    expect(saved().content).toBe('accepted\n');
    const restored = new ReviewDocument('note.md', saved(), async () => {});
    await restored.undoAcceptance(restored.snapshot('later manual edit\n'));
    const result = restored.snapshot('later manual edit\n');
    expect(result.record.content).toBe('original\n');
    expect(result.current).toBe('later manual edit\n');
    expect(result.record.undoContent).toBeNull();
    expect(result.diff.changes).toHaveLength(1);
  });

  it('accepts only the selected change without changing the current text', async () => {
    const { review, saved } = document('A1\nkeep\nB1\n');
    const current = 'A2\nkeep\nB2\n';
    const snapshot = review.snapshot(current);
    await review.accept(snapshot, snapshot.diff.changes[0]!, () => current);
    expect(saved().content).toBe('A2\nkeep\nB1\n');
    expect(review.snapshot(current).diff.changes).toHaveLength(1);
    expect(review.snapshot(current).current).toBe(current);
  });
});
