import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertTextSize } from './diff';
import { DEFAULT_SETTINGS, type DocumentLimits } from './options';
import { LocalizedError, type MessageKey } from './i18n';

const exec = promisify(execFile);

export interface GitBaseline {
  content: string;
  head: string | null;
  isNew: boolean;
}
export type BaselineRead = (path: string) => Promise<GitBaseline>;

export class GitReadError extends LocalizedError {
  constructor(public readonly reason: 'untracked' | 'unavailable' | 'repository' | 'conflict' | 'read', key: MessageKey, values?: Record<string, string | number>) { super(key, values); }
}
interface ProcessError extends Error { code?: string | number; stderr?: string; killed?: boolean }
interface LocatedFile { vaultPath: string; path: string }

function readError(error: unknown): Error {
  if (error instanceof LocalizedError) return error;
  const failure = error as ProcessError;
  const detail = failure.stderr?.trim().slice(0, 500) || failure.message;
  return detail ? new GitReadError('read', 'Git 读取失败：{detail}', { detail }) : new GitReadError('read', '读取 Git 失败，请刷新重试。');
}

/** One owner per plugin. Only immutable blob contents survive a refresh cycle. */
export class GitBaselineReader {
  private controller = new AbortController();
  private blobs = new Map<string, string>();
  private cachedBytes = 0;

  private limits: DocumentLimits;

  constructor(private vaultRoot: string, private gitPath = 'git', limits: DocumentLimits = DEFAULT_SETTINGS) { this.limits = { ...limits }; }

  read(path: string): Promise<GitBaseline> { return this.batch([path])(path); }

  /** Lazy, sequential Git I/O; metadata is shared only by the paths in this batch. */
  batch(paths: readonly string[]): BaselineRead {
    let pending: Promise<Map<string, GitBaseline | Error>> | undefined;
    return async (path) => {
      this.controller.signal.throwIfAborted();
      pending ??= this.readBatch([...new Set(paths)]);
      const result = (await pending).get(path);
      this.controller.signal.throwIfAborted();
      if (!result) throw new GitReadError('read', '文档不在本次刷新范围内。');
      if (result instanceof Error) throw result;
      return result;
    };
  }

  private async run(cwd: string, args: string[]): Promise<string> {
    this.controller.signal.throwIfAborted();
    try {
      const { stdout } = await exec(this.gitPath, args, {
        cwd, encoding: 'utf8', windowsHide: true, shell: false,
        signal: this.controller.signal, timeout: 8_000, maxBuffer: this.limits.maxFileMiB * 1024 * 1024 + 64 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
      });
      return stdout;
    } catch (error) {
      const failure = error as ProcessError;
      if (failure.code === 'ENOENT') throw new GitReadError('unavailable', '找不到 Git。请安装 Git，或在插件设置中填写 Git 可执行文件的完整路径。');
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new GitReadError('read', 'Git 输出超过当前读取上限（{size} MiB），请在插件设置中调整文档大小上限。', { size: this.limits.maxFileMiB });
      if (failure.killed) throw new GitReadError('read', '读取 Git 超时，请检查仓库或 Git 路径后刷新。');
      throw error;
    }
  }

  private async readBatch(paths: string[]): Promise<Map<string, GitBaseline | Error>> {
    const results = new Map<string, GitBaseline | Error>();
    const roots = new Map<string, string>();
    const repositories = new Map<string, LocatedFile[]>();
    for (const vaultPath of paths) {
      this.controller.signal.throwIfAborted();
      try {
        const absolute = resolve(this.vaultRoot, vaultPath);
        const inside = relative(this.vaultRoot, absolute);
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new GitReadError('read', '文档路径不在当前仓库目录内。');
        let directory: string;
        let root: string;
        try {
          // Physical directories resolve aliases; file symlinks still fail the index check.
          directory = await realpath(dirname(absolute));
          root = roots.get(directory) ?? (await this.run(directory, ['rev-parse', '--show-toplevel'])).replace(/[\r\n]+$/, '');
          roots.set(directory, root);
        } catch (error) {
          if (error instanceof GitReadError) throw error;
          throw new GitReadError('repository', '无法访问 Git 仓库。请确认文档位于仓库内，且仓库权限与 safe.directory 配置正确。');
        }
        const files = repositories.get(root) ?? [];
        files.push({ vaultPath, path: relative(root, resolve(directory, basename(absolute))).split(sep).join('/') });
        repositories.set(root, files);
      } catch (error) { results.set(vaultPath, readError(error)); }
    }
    for (const [root, files] of repositories) {
      try {
        let head: string | null;
        try { head = (await this.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim(); }
        catch (error) { if ((error as ProcessError).code === 1) head = null; else throw error; }
        // Bound argv size on Windows; don't scan the whole index of a larger parent repo.
        for (let start = 0; start < files.length; start += 32) {
          const chunk = files.slice(start, start + 32);
          const names = chunk.map((file) => file.path);
          const index = this.entries(await this.run(root, ['ls-files', '--stage', '-z', '--', ...names]));
          const tree = head ? this.entries(await this.run(root, ['ls-tree', '-z', head, '--', ...names])) : new Map<string, string[]>();
          for (const file of chunk) {
            try {
              const entries = index.get(file.path);
              if (!entries?.length) throw new GitReadError('untracked', '此文档尚未纳入 Git 管理。请先执行 git add，再刷新差异。');
              if (entries.some((entry) => !/^\d+ [0-9a-f]+ 0$/.test(entry))) throw new GitReadError('conflict', '此文档存在未解决的合并冲突，请解决冲突后刷新。');
              if (entries.some((entry) => !/^100(?:644|755) /.test(entry))) throw new GitReadError('read', '暂不支持符号链接或子模块文件。');
              const object = tree.get(file.path)?.[0];
              if (!object) { results.set(file.vaultPath, { content: '', head, isNew: true }); continue; }
              const blob = /^100(?:644|755) blob ([0-9a-f]+)$/.exec(object)?.[1];
              if (!blob) throw new GitReadError('read', 'HEAD 中的对象不是普通 Markdown 文件。');
              results.set(file.vaultPath, { content: await this.readBlob(root, blob), head, isNew: false });
            } catch (error) { results.set(file.vaultPath, readError(error)); }
          }
        }
      } catch (error) {
        for (const file of files) results.set(file.vaultPath, readError(error));
      }
    }
    return results;
  }

  private entries(output: string): Map<string, string[]> {
    const entries = new Map<string, string[]>();
    for (const entry of output.split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const path = entry.slice(tab + 1);
      const values = entries.get(path) ?? [];
      values.push(entry.slice(0, tab));
      entries.set(path, values);
    }
    return entries;
  }

  private async readBlob(root: string, blob: string): Promise<string> {
    const key = `${root}\0${blob}`;
    let content = this.blobs.get(key);
    if (content !== undefined) { this.blobs.delete(key); this.blobs.set(key, content); return content; }
    content = await this.run(root, ['cat-file', 'blob', blob]);
    assertTextSize(content, this.limits);
    this.controller.signal.throwIfAborted();
    if (!this.blobs.has(key)) this.cachedBytes += Buffer.byteLength(content, 'utf8');
    this.blobs.set(key, content);
    while (this.cachedBytes > 16 * 1024 * 1024 || this.blobs.size > 128) {
      const oldest = this.blobs.entries().next().value!;
      this.blobs.delete(oldest[0]);
      this.cachedBytes -= Buffer.byteLength(oldest[1], 'utf8');
    }
    return content;
  }

  dispose(): void { this.controller.abort(); this.blobs.clear(); this.cachedBytes = 0; }
}

/** Restoration uses an independent, uncached read rather than the poller's batch. */
export async function readGitBaseline(vaultRoot: string, vaultPath: string, gitPath = 'git', signal?: AbortSignal, limits: DocumentLimits = DEFAULT_SETTINGS): Promise<GitBaseline> {
  const reader = new GitBaselineReader(vaultRoot, gitPath, limits);
  const abort = () => reader.dispose();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  try { return await reader.read(vaultPath); }
  finally { signal?.removeEventListener('abort', abort); reader.dispose(); }
}
