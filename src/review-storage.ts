import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { LocalizedError } from './i18n';
import { DEFAULT_SETTINGS, type DocumentLimits } from './options';
import { createReviewRecord, parseReviewRecord, ReviewDocument, type ReviewRecord } from './review';

type Phase = 'new' | 'initializing' | 'ready';
interface Index { phase: Phase; documents: Map<string, boolean> }
const maxIndexBytes = 8 * 1024 * 1024;
const corrupt = () => new LocalizedError('认可记录损坏或不兼容，未自动初始化。');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hasCode = (error: unknown, code: string) => !!error && typeof error === 'object' && 'code' in error && error.code === code;

function checkPath(path: string): void {
  if (!path.toLowerCase().endsWith('.md') || /[\\\0:]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new LocalizedError('审阅文档路径无效。');
  }
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw corrupt();
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw corrupt();
  try { const value: unknown = JSON.parse(text); return value; }
  catch { throw corrupt(); }
}

async function writeJson(path: string, value: unknown, maxBytes: number): Promise<void> {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new LocalizedError('审阅存储超过大小上限，未保存。');
  const temp = join(dirname(path), `${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, path);
  } finally {
    // A cleanup failure after rename must not report a committed decision as unsaved.
    await rm(temp, { force: true }).catch(() => {});
  }
}

/** One writer per vault. The caller supplies an existing, device-local directory outside Git/vault sync. */
export class ReviewStorage {
  private index: Index = { phase: 'new', documents: new Map() };
  private pending: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private documents = new Map<string, ReviewDocument>();

  private constructor(
    readonly directory: string,
    private readonly vault: string,
    private readonly lock: FileHandle,
    private readonly lockToken: string,
    private readonly limits: DocumentLimits,
  ) {}

  static async open(vaultRoot: string, dataRoot: string, limits: DocumentLimits = DEFAULT_SETTINGS): Promise<ReviewStorage> {
    const vault = await realpath(vaultRoot), base = await realpath(dataRoot);
    const directory = join(base, `better-md-diff-${hash(vault)}`);
    if (inside(vault, directory)) throw new LocalizedError('审阅存储必须位于 vault 和 Git 仓库之外。');
    for (let path = directory; ; path = dirname(path)) {
      try { await lstat(join(path, '.git')); throw new LocalizedError('审阅存储必须位于 vault 和 Git 仓库之外。'); }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      if (dirname(path) === path) break;
    }
    let created = false;
    try { await mkdir(directory, { mode: 0o700 }); created = true; }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw corrupt();
    let lock: FileHandle;
    try { lock = await open(join(directory, 'writer.lock'), 'wx', 0o600); }
    catch (error) {
      if (hasCode(error, 'EEXIST')) throw new LocalizedError('审阅存储已被占用；请先关闭其他实例，勿直接删除写锁。');
      throw error;
    }
    const token = JSON.stringify({ pid: process.pid, owner: randomUUID() });
    const store = new ReviewStorage(directory, vault, lock, token, { ...limits });
    try {
      await lock.writeFile(token, 'utf8'); await lock.sync();
      if (created) await store.saveIndex(store.index);
      else store.index = store.parseIndex(await readJson(join(directory, 'index.json'), maxIndexBytes));
      return store;
    } catch (error) { await store.close(); throw error; }
  }

  get phase(): Phase { return this.index.phase; }
  get pendingPaths(): string[] { return [...this.index.documents].filter(([, ready]) => !ready).map(([path]) => path); }

  beginInitialization(paths: readonly string[]): Promise<void> {
    return this.run(async () => {
      if (this.index.phase !== 'new') throw new LocalizedError('审阅初始化状态不允许此操作。');
      for (const path of paths) checkPath(path);
      await this.saveIndex({ phase: 'initializing', documents: new Map(paths.map((path) => [path, false])) });
    });
  }

  /** The host must supply a freshly checked initial snapshot, never silently re-read after an edit. */
  initializeDocument(path: string, content: string): Promise<void> {
    return this.run(async () => {
      if (this.index.phase !== 'initializing' || !this.index.documents.has(path)) throw new LocalizedError('审阅初始化状态不允许此操作。');
      if (this.index.documents.get(path)) return;
      let record = await this.readRecord(path, true);
      if (record && (record.revision !== 0 || record.undoContent !== null)) throw corrupt();
      if (!record) {
        record = createReviewRecord(content, this.limits);
        await this.writeRecord(path, record);
      }
      // If index publication previously failed, keep the first saved snapshot, not newer input.
      await this.saveIndex({ ...this.index, documents: new Map(this.index.documents).set(path, true) });
    });
  }

  finishInitialization(): Promise<void> {
    return this.run(async () => {
      if (this.index.phase !== 'initializing' || this.pendingPaths.length) throw new LocalizedError('审阅初始化尚未完成，不能自动认可剩余文档。');
      for (const path of this.index.documents.keys()) await this.readRecord(path);
      await this.saveIndex({ ...this.index, phase: 'ready' });
    });
  }

  document(path: string): Promise<ReviewDocument> {
    return this.run(async () => {
      checkPath(path);
      if (this.index.phase !== 'ready') throw new LocalizedError('审阅初始化尚未完成，不能自动认可剩余文档。');
      const cached = this.documents.get(path);
      if (cached) return cached;
      if (!this.index.documents.has(path)) {
        const orphan = await this.readRecord(path, true);
        if (orphan && (orphan.revision !== 0 || orphan.content !== '' || orphan.undoContent !== null)) throw corrupt();
        if (!orphan) await this.writeRecord(path, createReviewRecord('', this.limits));
        await this.saveIndex({ ...this.index, documents: new Map(this.index.documents).set(path, true) });
      }
      let saved = (await this.readRecord(path))!;
      const doc = new ReviewDocument(path, saved, (next) => this.run(async () => {
        const disk = (await this.readRecord(path))!;
        if (disk.revision !== saved.revision || disk.content !== saved.content || disk.undoContent !== saved.undoContent || next.revision !== saved.revision + 1) {
          throw new LocalizedError('文档或认可内容已变化，请刷新后重新选择改动。');
        }
        await this.writeRecord(path, next);
        saved = next;
      }), this.limits);
      this.documents.set(path, doc);
      if (this.closing) doc.dispose();
      return doc;
    });
  }

  close(): Promise<void> {
    for (const doc of this.documents.values()) doc.dispose();
    this.closing ??= this.pending.then(async () => {
      await this.lock.close();
      // Never remove another owner's lock after an external replacement.
      const token = await readFile(join(this.directory, 'writer.lock'), 'utf8').catch(() => '');
      if (token === this.lockToken) await rm(join(this.directory, 'writer.lock'));
    });
    return this.closing;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new LocalizedError('审阅存储已关闭。'));
    const result = this.pending.then(async () => {
      if (await readFile(join(this.directory, 'writer.lock'), 'utf8') !== this.lockToken) throw new LocalizedError('审阅存储写锁已变化，操作已停止。');
      return operation();
    });
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  private recordPath(path: string): string { return join(this.directory, `record-${hash(path)}.json`); }
  private get maxRecordBytes(): number { return this.limits.maxFileMiB * 1024 * 1024 * 12 + 64 * 1024; }

  private async readRecord(path: string, optional = false): Promise<ReviewRecord | undefined> {
    let value: unknown;
    try { value = await readJson(this.recordPath(path), this.maxRecordBytes); }
    catch (error) { if (optional && hasCode(error, 'ENOENT')) return undefined; throw error; }
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('path' in value) || value.path !== path || !('record' in value)) throw corrupt();
    return parseReviewRecord(value.record, this.limits);
  }

  private async writeRecord(path: string, record: ReviewRecord): Promise<void> {
    await writeJson(this.recordPath(path), { version: 1, path, record }, this.maxRecordBytes);
  }

  private async saveIndex(index: Index): Promise<void> {
    await writeJson(join(this.directory, 'index.json'), { version: 1, vault: this.vault, phase: index.phase, documents: [...index.documents] }, maxIndexBytes);
    this.index = index;
  }

  private parseIndex(value: unknown): Index {
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('vault' in value) || value.vault !== this.vault
      || !('phase' in value) || (value.phase !== 'new' && value.phase !== 'initializing' && value.phase !== 'ready') || !('documents' in value) || !Array.isArray(value.documents)) throw corrupt();
    const documents = new Map<string, boolean>();
    const entries: unknown[] = value.documents;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) throw corrupt();
      const path: unknown = entry[0], ready: unknown = entry[1];
      if (typeof path !== 'string' || typeof ready !== 'boolean' || documents.has(path)) throw corrupt();
      checkPath(path); documents.set(path, ready);
    }
    const phase = value.phase;
    if ((phase === 'new' && documents.size) || (phase === 'ready' && [...documents.values()].some((ready) => !ready))) throw corrupt();
    return { phase, documents };
  }
}
