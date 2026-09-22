import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitBaselineReader, readGitBaseline } from '../src/git';

const exec = promisify(execFile);
let root: string;
async function git(...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })).stdout;
}
async function note(path: string, text: string): Promise<void> { await writeFile(join(root, path), text, 'utf8'); }
async function commit(): Promise<void> { await git('add', '--all'); await git('commit', '-qm', '测试提交'); }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'better-md-diff-'));
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Diff Test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.autocrlf', 'false');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('read-only Git HEAD baseline', () => {
  it('batches repository metadata and caches immutable blobs without caching tracking state', async () => {
    for (let i = 0; i < 10; i++) await note(`note-${i}.md`, `HEAD ${i}\n`);
    await commit();
    const trace = join(root, 'trace.jsonl');
    const previousTrace = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = trace;
    const reader = new GitBaselineReader(root);
    const paths = Array.from({ length: 10 }, (_, i) => `note-${i}.md`);
    try {
      let read = reader.batch(paths);
      for (const path of paths) expect((await read(path)).isNew).toBe(false);
      const count = async () => (await readFile(trace, 'utf8')).split('\n').filter((line) => line.includes('"event":"start"')).length;
      const cold = await count();
      read = reader.batch(paths);
      for (const path of paths) await read(path);
      expect(cold).toBe(14); // root, HEAD, index, tree, ten distinct blobs.
      expect(await count() - cold).toBe(4);
      await git('rm', '--cached', 'note-0.md');
      await expect(reader.read('note-0.md')).rejects.toMatchObject({ reason: 'untracked' });
      await note('note-1.md', 'updated\n'); await commit();
      expect((await reader.read('note-1.md')).content).toBe('updated\n');
    } finally {
      reader.dispose();
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = previousTrace;
    }
  });

  it('isolates errors within a batch and rejects reads after disposal', async () => {
    await note('valid.md', 'HEAD\n'); await commit();
    await note('untracked.md', 'new\n');
    const reader = new GitBaselineReader(root);
    const read = reader.batch(['valid.md', 'untracked.md', '../escape.md']);
    expect((await read('valid.md')).content).toBe('HEAD\n');
    await expect(read('untracked.md')).rejects.toMatchObject({ reason: 'untracked' });
    await expect(read('../escape.md')).rejects.toMatchObject({ reason: 'read' });
    reader.dispose();
    await expect(reader.read('valid.md')).rejects.toThrow();
  });

  it('honors configured limits in cached and independent restoration reads', async () => {
    const text = '中文'.repeat(450_000);
    await note('large.md', text); await commit();
    await expect(readGitBaseline(root, 'large.md')).rejects.toThrow('上限');
    const limits = { maxFileMiB: 3, maxLines: 30_000 };
    const reader = new GitBaselineReader(root, 'git', limits);
    try {
      expect((await reader.read('large.md')).content).toBe(text);
      expect((await reader.read('large.md')).content).toBe(text);
      expect((await readGitBaseline(root, 'large.md', 'git', undefined, limits)).content).toBe(text);
    } finally { reader.dispose(); }
    await note('lines.md', 'line\n'.repeat(25_000)); await commit();
    await expect(readGitBaseline(root, 'lines.md')).rejects.toThrow('20000');
    expect((await readGitBaseline(root, 'lines.md', 'git', undefined, limits)).content).toBe('line\n'.repeat(25_000));
  });

  it('reads HEAD, not index or working tree, without writing either', async () => {
    await note('note.md', 'HEAD\n'); await commit();
    await note('note.md', 'staged\n'); await git('add', 'note.md');
    await note('note.md', 'working\n');
    const index = await readFile(join(root, '.git/index'));
    const status = await git('status', '--porcelain=v1');
    const baseline = await readGitBaseline(root, 'note.md');
    expect(baseline.content).toBe('HEAD\n');
    expect(baseline.isNew).toBe(false);
    expect(baseline.head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await readFile(join(root, '.git/index'))).toEqual(index);
    expect(await git('status', '--porcelain=v1')).toBe(status);
    expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('working\n');
  });

  it('uses literal paths with Chinese, spaces, glob and option-like names', async () => {
    for (const name of ['中文 [笔记].md', '-test.md', 'a;echo bad.md']) await note(name, `${name}\n`);
    await commit();
    for (const name of ['中文 [笔记].md', '-test.md', 'a;echo bad.md']) {
      expect((await readGitBaseline(root, name)).content).toBe(`${name}\n`);
    }
  });

  it('supports a vault nested inside a Git repository', async () => {
    await mkdir(join(root, 'vault'));
    await note('vault/note.md', 'nested\n'); await commit();
    expect((await readGitBaseline(join(root, 'vault'), 'note.md')).content).toBe('nested\n');
  });

  it('reads a repository through a directory alias without escaping its root', async () => {
    await note('note.md', 'HEAD\n'); await commit();
    const aliases = await mkdtemp(join(tmpdir(), 'better-md-alias-'));
    const alias = join(aliases, 'linked');
    try {
      await symlink(root, alias, 'junction');
      expect((await readGitBaseline(alias, 'note.md')).content).toBe('HEAD\n');
      expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('HEAD\n');
    } finally { await rm(aliases, { recursive: true, force: true }); }
  });

  it('discovers a nested repository using the document directory', async () => {
    await mkdir(join(root, 'nested'));
    await exec('git', ['init', '-q'], { cwd: join(root, 'nested') });
    await note('nested/note.md', 'new\n');
    await exec('git', ['add', 'note.md'], { cwd: join(root, 'nested') });
    expect(await readGitBaseline(root, 'nested/note.md')).toEqual({ content: '', head: null, isNew: true });
  });

  it('rejects a path recorded as a file symlink without resolving its target', async () => {
    await note('note.md', 'HEAD\n'); await commit();
    const blob = (await git('rev-parse', 'HEAD:note.md')).trim();
    await git('update-index', '--add', '--cacheinfo', `120000,${blob},linked.md`);
    await expect(readGitBaseline(root, 'linked.md')).rejects.toMatchObject({
      reason: 'read', message: '暂不支持符号链接或子模块文件。',
    });
  });

  it('reports untracked and ignored documents', async () => {
    await note('.gitignore', 'ignored.md\n');
    await note('note.md', 'new\n'); await note('ignored.md', 'ignored\n');
    await expect(readGitBaseline(root, 'note.md')).rejects.toMatchObject({ reason: 'untracked' });
    await expect(readGitBaseline(root, 'ignored.md')).rejects.toMatchObject({ reason: 'untracked' });
  });

  it('compares staged additions against an empty baseline, including unborn HEAD', async () => {
    await note('first.md', 'first\n'); await git('add', 'first.md');
    expect(await readGitBaseline(root, 'first.md')).toEqual({ content: '', head: null, isNew: true });
    await commit();
    await note('new.md', 'new\n'); await git('add', 'new.md');
    expect(await readGitBaseline(root, 'new.md')).toMatchObject({ content: '', isNew: true });
  });

  it('refreshes after a new HEAD commit', async () => {
    await note('note.md', 'one\n'); await commit();
    const before = await readGitBaseline(root, 'note.md');
    await note('note.md', 'two\n'); await commit();
    const after = await readGitBaseline(root, 'note.md');
    expect(after.head).not.toBe(before.head);
    expect(after.content).toBe('two\n');
  });

  it('reads a linked worktree whose .git is a file', async () => {
    await note('note.md', 'worktree\n'); await commit();
    const worktree = join(root, 'linked');
    await git('worktree', 'add', '-q', '-b', 'test-worktree', worktree);
    expect((await readGitBaseline(worktree, 'note.md')).content).toBe('worktree\n');
    await git('worktree', 'remove', worktree);
  });

  it('reports missing Git, non-repositories and escaped paths', async () => {
    await note('note.md', 'x');
    await expect(readGitBaseline(root, 'note.md', join(root, 'missing-git'))).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(readGitBaseline(root, '../outside.md')).rejects.toMatchObject({ reason: 'read' });
    const outside = await mkdtemp(join(tmpdir(), 'better-md-no-git-'));
    try {
      await writeFile(join(outside, 'note.md'), 'x');
      await expect(readGitBaseline(outside, 'note.md')).rejects.toMatchObject({ reason: 'repository' });
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('reports unresolved merge conflicts', async () => {
    await note('note.md', 'base\n'); await commit();
    await git('checkout', '-qb', 'conflict');
    await note('note.md', 'branch\n'); await commit();
    await git('checkout', '-q', 'main');
    await note('note.md', 'main\n'); await commit();
    await expect(git('merge', '--no-edit', 'conflict')).rejects.toBeDefined();
    await expect(readGitBaseline(root, 'note.md')).rejects.toMatchObject({ reason: 'conflict' });
  });
});
