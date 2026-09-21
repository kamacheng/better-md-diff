import { describe, expect, it, vi } from 'vitest';
import { DiffStore } from '../src/store';
import type { GitBaseline } from '../src/git';

const baseline: GitBaseline = { content: 'old\n', head: 'abc', isNew: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('diff snapshot store', () => {
  it('reuses HEAD on edits and reloads on explicit refresh', async () => {
    const read = vi.fn(async () => baseline);
    const store = new DiffStore(read);
    await store.refresh('a.md', 'new\n');
    await store.refresh('a.md', 'newer\n');
    expect(read).toHaveBeenCalledTimes(1);
    await store.refresh('a.md', 'newer\n', true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('updates presentation and context without new Git reads', async () => {
    const read = vi.fn(async () => ({ ...baseline, content: 'a\nold\nb\n' }));
    const store = new DiffStore(read);
    await store.refresh('a.md', 'a\nnew\nb\n');
    const notify = vi.fn(); store.subscribe(notify);
    store.updatePresentation(0);
    const state = store.get('a.md');
    expect(state?.status === 'ready' && state.diff.hunks[0]?.rows.map((row) => row.kind)).toEqual(['deleted', 'added']);
    store.updatePresentation(0);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('coalesces in-flight Git reads and ignores stale editor snapshots', async () => {
    const pending = deferred<GitBaseline>();
    const read = vi.fn(() => pending.promise);
    const store = new DiffStore(read);
    const first = store.refresh('a.md', 'first\n');
    const second = store.refresh('a.md', 'second\n');
    pending.resolve(baseline);
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.get('a.md')).toMatchObject({ status: 'ready', current: 'second\n' });
  });

  it('waits for an in-flight HEAD refresh rather than using an old cached baseline', async () => {
    const next = deferred<GitBaseline>();
    const read = vi.fn().mockResolvedValueOnce(baseline).mockReturnValueOnce(next.promise);
    const store = new DiffStore(read);
    await store.refresh('a.md', 'new\n');
    const poll = store.refresh('a.md', 'new\n', true);
    const edit = store.refresh('a.md', 'newest\n');
    next.resolve({ ...baseline, content: 'new\n', head: 'def' });
    await Promise.all([poll, edit]);
    expect(store.get('a.md')).toMatchObject({ status: 'ready', current: 'newest\n', baseline: { head: 'def' } });
  });

  it('does not notify for identical snapshots', async () => {
    const store = new DiffStore(async () => baseline);
    const listener = vi.fn(); store.subscribe(listener);
    await store.refresh('a.md', 'new\r\n');
    await store.refresh('a.md', 'new\n', true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('replaces stale diff with an error and recovers on retry', async () => {
    const read = vi.fn(async () => baseline);
    const store = new DiffStore(read);
    await store.refresh('a.md', 'new\n');
    read.mockRejectedValueOnce(new Error('not tracked'));
    await store.refresh('a.md', 'new\n', true);
    expect(store.get('a.md')).toMatchObject({ status: 'error', message: 'not tracked' });
    await store.refresh('a.md', 'new\n');
    expect(store.get('a.md')?.status).toBe('ready');
  });

  it('does not restore forgotten data after an in-flight read completes', async () => {
    const pending = deferred<GitBaseline>();
    const store = new DiffStore(() => pending.promise);
    const request = store.refresh('a.md', 'old');
    store.forget('a.md');
    pending.resolve(baseline);
    await request;
    expect(store.get('a.md')).toBeUndefined();
  });

  it('ignores an old request even if the path is reopened immediately', async () => {
    const old = deferred<GitBaseline>();
    const next = deferred<GitBaseline>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const store = new DiffStore(read);
    const first = store.refresh('a.md', 'stale');
    store.forget('a.md');
    const second = store.refresh('a.md', 'fresh');
    next.resolve(baseline); await second;
    old.resolve(baseline); await first;
    expect(store.get('a.md')).toMatchObject({ current: 'fresh' });
  });

  it('cleans up listeners and in-flight results on disposal', async () => {
    const pending = deferred<GitBaseline>();
    const store = new DiffStore(() => pending.promise);
    const listener = vi.fn(); store.subscribe(listener);
    const request = store.refresh('a.md', 'new');
    store.dispose(); pending.resolve(baseline); await request;
    expect(store.get('a.md')).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
});
