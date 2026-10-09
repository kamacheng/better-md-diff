import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStorage } from '../src/review-storage';

let root: string, vault: string, data: string;
const stores: ReviewStorage[] = [];
async function openStore(): Promise<ReviewStorage> {
  const store = await ReviewStorage.open(vault, data);
  stores.push(store);
  return store;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bmd-review-'));
  vault = join(root, 'vault'); data = join(root, 'device-data');
  await mkdir(vault); await mkdir(data);
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await rm(root, { recursive: true, force: true });
});

describe('device-local acceptance storage', () => {
  it('uses the same writer identity through a vault directory alias', async () => {
    await openStore();
    const alias = join(root, 'alias');
    await symlink(vault, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(ReviewStorage.open(alias, data)).rejects.toThrow('占用');
  });

  it('stops when its lock is replaced and does not remove the replacement on close', async () => {
    const store = await openStore();
    const path = join(store.directory, 'writer.lock');
    await writeFile(path, 'another owner');
    await expect(store.beginInitialization([])).rejects.toThrow('写锁');
    await store.close();
    expect(await readFile(path, 'utf8')).toBe('another owner');
    await expect(openStore()).rejects.toThrow('占用');
  });

  it('rejects malformed phase values rather than coercing them into a valid state', async () => {
    const store = await openStore();
    const path = join(store.directory, 'index.json');
    const original = await readFile(path, 'utf8');
    await store.close();
    const malformed = original.replace('"phase":"new"', '"phase":["new"]');
    expect(malformed).not.toBe(original);
    await writeFile(path, malformed);
    await expect(openStore()).rejects.toThrow('认可记录');
  });

  it('initializes once and treats later or offline-created files as pending, even before they were opened', async () => {
    let store = await openStore();
    await store.beginInitialization(['unopened.md']);
    await store.initializeDocument('unopened.md', 'recognized\n');
    await store.finishInitialization();
    await expect(store.beginInitialization(['different.md'])).rejects.toThrow('初始化');
    await store.close(); store = await openStore();
    const existing = await store.document('unopened.md');
    expect(existing.snapshot('offline changes\n').record.content).toBe('recognized\n');
    const added = await store.document('offline-new.md');
    expect(added.snapshot('whole draft\n').record.content).toBe('');
    expect(added.snapshot('whole draft\n').diff.added).toBe(1);
    expect(await store.document('offline-new.md')).toBe(added);
  });

  it('resumes partial initialization without replacing already recognized content', async () => {
    let store = await openStore();
    await store.beginInitialization(['a.md', 'b.md']);
    await store.initializeDocument('a.md', 'original a\n');
    await expect(store.finishInitialization()).rejects.toThrow('尚未完成');
    await expect(store.document('b.md')).rejects.toThrow('尚未完成');
    await store.close(); store = await openStore();
    expect(store.pendingPaths).toEqual(['b.md']);
    await store.initializeDocument('a.md', 'later a\n');
    await store.initializeDocument('b.md', 'original b\n');
    await store.finishInitialization();
    expect((await store.document('a.md')).snapshot('later a\n').record.content).toBe('original a\n');
  });

  it('retains the first saved snapshot when initialization index publication fails and is retried', async () => {
    const store = await openStore();
    await store.beginInitialization(['a.md']);
    const indexPath = join(store.directory, 'index.json');
    const index = await readFile(indexPath);
    await rm(indexPath); await mkdir(indexPath);
    await expect(store.initializeDocument('a.md', 'first snapshot\n')).rejects.toThrow();
    expect(store.pendingPaths).toEqual(['a.md']);
    await rm(indexPath, { recursive: true }); await writeFile(indexPath, index);
    await store.initializeDocument('a.md', 'newer content must not be auto-approved\n');
    await store.finishInitialization();
    expect((await store.document('a.md')).snapshot('latest\n').record.content).toBe('first snapshot\n');
  });

  it('does not silently recreate a corrupt or missing initialized record', async () => {
    let store = await openStore();
    await store.beginInitialization(['a.md']);
    await store.initializeDocument('a.md', 'accepted\n'); await store.finishInitialization();
    const recordPath = join(store.directory, (await readdir(store.directory)).find((name) => name.startsWith('record-'))!);
    await store.close();
    await writeFile(recordPath, 'broken json'); store = await openStore();
    await expect(store.document('a.md')).rejects.toThrow('认可记录');
    await rm(recordPath);
    await expect(store.document('a.md')).rejects.toThrow();
    expect(store.phase).toBe('ready');
  });

  it('never resets a damaged or missing index and releases its lock after a failed open', async () => {
    const store = await openStore();
    const indexPath = join(store.directory, 'index.json');
    const original = await readFile(indexPath);
    await store.close();
    await writeFile(indexPath, '{broken');
    await expect(openStore()).rejects.toThrow('认可记录');
    await rm(indexPath);
    await expect(openStore()).rejects.toThrow();
    await writeFile(indexPath, original);
    expect((await openStore()).phase).toBe('new');
  });

  it('has one writer per vault while isolating different vaults in the same data root', async () => {
    const first = await openStore();
    await expect(openStore()).rejects.toThrow('占用');
    const anotherVault = join(root, 'other-vault'); await mkdir(anotherVault);
    const other = await ReviewStorage.open(anotherVault, data); stores.push(other);
    expect(other.directory).not.toBe(first.directory);
    await other.beginInitialization([]); await other.finishInitialization();
    expect(first.phase).toBe('new');
    await first.close(); expect((await openStore()).phase).toBe('new');
  });

  it('refuses storage inside the vault, a Git worktree, or a junction into the vault', async () => {
    await expect(ReviewStorage.open(vault, vault)).rejects.toThrow('之外');
    await writeFile(join(data, '.git'), 'gitdir: somewhere');
    await expect(openStore()).rejects.toThrow('之外');
    await rm(join(data, '.git'));
    const alias = join(root, 'vault-alias');
    await symlink(vault, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(ReviewStorage.open(vault, alias)).rejects.toThrow('之外');
  });

  it('rejects escaped paths before initialization and persists special Markdown names safely', async () => {
    const store = await openStore();
    for (const path of ['../a.md', '/a.md', 'C:\\a.md', 'folder//a.md', './a.md', 'a.txt']) {
      await expect(store.beginInitialization([path])).rejects.toThrow('路径');
      expect(store.phase).toBe('new');
    }
    await store.beginInitialization([]); await store.finishInitialization();
    const path = '中文 空格/__proto__.md';
    const doc = await store.document(path);
    await doc.acceptAll(doc.snapshot('content\n'), () => 'content\n');
    await store.close();
    expect((await (await openStore()).document(path)).snapshot('content\n').record.content).toBe('content\n');
  });

  it('keeps the in-memory acceptance unchanged when the durable record has been damaged', async () => {
    const store = await openStore();
    await store.beginInitialization([]); await store.finishInitialization();
    const doc = await store.document('a.md');
    const recordPath = join(store.directory, (await readdir(store.directory)).find((name) => name.startsWith('record-'))!);
    const original = await readFile(recordPath);
    await writeFile(recordPath, '{}');
    const snapshot = doc.snapshot('new\n');
    await expect(doc.acceptAll(snapshot, () => 'new\n')).rejects.toThrow('认可记录');
    expect(doc.snapshot('new\n').record.content).toBe('');
    await writeFile(recordPath, original);
    await doc.acceptAll(snapshot, () => 'new\n');
    expect(doc.snapshot('new\n').record.content).toBe('new\n');
  });

  it('does not leave a writable document handle when closing during its initial load', async () => {
    const store = await openStore();
    await store.beginInitialization([]); await store.finishInitialization();
    const loading = store.document('new.md');
    const closing = store.close();
    const doc = await loading;
    await closing;
    const snapshot = doc.snapshot('pending\n');
    await expect(doc.reject(snapshot, snapshot.diff.changes[0]!, {
      getValue: () => 'pending\n', apply: () => { throw new Error('unexpected edit'); },
    })).rejects.toThrow('关闭');
  });

  it('refuses a per-vault storage directory that has become a Git worktree', async () => {
    const store = await openStore();
    const directory = store.directory;
    await store.close();
    await mkdir(join(directory, '.git'));
    await expect(openStore()).rejects.toThrow('之外');
  });

  it('invalidates document actions when the storage owner closes', async () => {
    const store = await openStore();
    await store.beginInitialization([]); await store.finishInitialization();
    const doc = await store.document('new.md');
    const snapshot = doc.snapshot('pending\n');
    await store.close();
    let applied = false;
    await expect(doc.reject(snapshot, snapshot.diff.changes[0]!, {
      getValue: () => 'pending\n', apply: () => { applied = true; },
    })).rejects.toThrow('关闭');
    expect(applied).toBe(false);
  });

  it('restores partial acceptance and its undo after reopening, without recognizing later edits', async () => {
    let store = await openStore();
    expect(store.phase).toBe('new');
    await store.beginInitialization(['existing.md']);
    await store.initializeDocument('existing.md', 'A1\nkeep\nB1\n');
    await store.finishInitialization();
    const doc = await store.document('existing.md');
    const current = 'A2\nkeep\nB2\n';
    const snapshot = doc.snapshot(current);
    await doc.accept(snapshot, snapshot.diff.changes[0]!, () => current);
    await store.close();
    store = await openStore();
    expect(store.phase).toBe('ready');
    const restored = await store.document('existing.md');
    expect(restored.snapshot('later\n').record.content).toBe('A2\nkeep\nB1\n');
    await restored.undoAcceptance(restored.snapshot('later\n'));
    expect(restored.snapshot('later\n').record.content).toBe('A1\nkeep\nB1\n');
    expect(restored.snapshot('later\n').current).toBe('later\n');
  });
});
