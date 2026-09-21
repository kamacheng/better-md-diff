import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertTextSize, MAX_BYTES } from './diff';

const exec = promisify(execFile);

export interface GitBaseline {
  content: string;
  head: string | null;
  isNew: boolean;
}

export class GitReadError extends Error {
  constructor(public readonly reason: 'untracked' | 'unavailable' | 'repository' | 'conflict' | 'read', message: string) {
    super(message);
  }
}

interface ProcessError extends Error { code?: string | number; stderr?: string; killed?: boolean }

export async function readGitBaseline(vaultRoot: string, vaultPath: string, gitPath = 'git'): Promise<GitBaseline> {
  const absolute = resolve(vaultRoot, vaultPath);
  const insideVault = relative(vaultRoot, absolute);
  if (insideVault === '..' || insideVault.startsWith(`..${sep}`) || isAbsolute(insideVault)) {
    throw new GitReadError('read', '文档路径不在当前仓库目录内。');
  }
  const run = async (cwd: string, args: string[]) => {
    try {
      const { stdout } = await exec(gitPath, args, {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8_000,
        maxBuffer: MAX_BYTES + 64 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' },
      });
      return stdout;
    } catch (error) {
      const failure = error as ProcessError;
      if (failure.code === 'ENOENT') throw new GitReadError('unavailable', '找不到 Git。请安装 Git，或在插件设置中填写 Git 可执行文件的完整路径。');
      if (failure.killed) throw new GitReadError('read', '读取 Git 超时，请检查仓库或 Git 路径后刷新。');
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new GitReadError('read', 'Git 输出过大，无法读取此文档。');
      throw error;
    }
  };

  try {
    let root: string;
    let directory: string;
    try {
      // Match Git's physical paths while leaving file symlinks for the index check below.
      directory = await realpath(dirname(absolute));
      root = (await run(directory, ['rev-parse', '--show-toplevel'])).replace(/[\r\n]+$/, '');
    } catch (error) {
      if (error instanceof GitReadError) throw error;
      throw new GitReadError('repository', '无法访问 Git 仓库。请确认文档位于仓库内，且仓库权限与 safe.directory 配置正确。');
    }
    const path = relative(root, resolve(directory, basename(absolute))).split(sep).join('/');
    const index = await run(root, ['ls-files', '--stage', '-z', '--', path]);
    if (!index) throw new GitReadError('untracked', '此文档尚未纳入 Git 管理。请先执行 git add，再刷新差异。');
    const entries = index.split('\0').filter(Boolean);
    if (entries.some((entry) => !/^\d+ [0-9a-f]+ 0\t/.test(entry))) {
      throw new GitReadError('conflict', '此文档存在未解决的合并冲突，请解决冲突后刷新。');
    }
    if (entries.some((entry) => !entry.startsWith('100644 ') && !entry.startsWith('100755 '))) {
      throw new GitReadError('read', '暂不支持符号链接或子模块文件。');
    }
    let head: string;
    try {
      head = (await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
    } catch (error) {
      if ((error as ProcessError).code === 1) return { content: '', head: null, isNew: true };
      throw error;
    }
    // Resolve the blob ID first: no user-supplied ref expressions, shell or text filters.
    const tree = await run(root, ['ls-tree', '-z', head, '--', path]);
    if (!tree) return { content: '', head, isNew: true };
    const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(tree)?.[1];
    if (!blob) throw new GitReadError('read', 'HEAD 中的对象不是普通 Markdown 文件。');
    const content = await run(root, ['cat-file', 'blob', blob]);
    assertTextSize(content);
    return { content, head, isNew: false };
  } catch (error) {
    if (error instanceof GitReadError) throw error;
    const failure = error as ProcessError;
    if (failure.stderr) throw new GitReadError('read', `Git 读取失败：${failure.stderr.trim().slice(0, 500)}`);
    throw new GitReadError('read', failure.message || '读取 Git 失败，请刷新重试。');
  }
}
