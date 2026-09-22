// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { computeDiff } from '../src/diff';
import { installObsidianDom } from './helpers/obsidian-dom';

installObsidianDom(document);
vi.mock('obsidian', async () => ({
  ...(await import('./helpers/obsidian-setting')),
  requireApiVersion: vi.fn(() => true),
  Notice: vi.fn(),
  Modal: class {
    titleEl = document.createElement('h2');
    contentEl = document.createElement('div');
    onOpen(): void {}
    onClose(): void {}
    open(): void { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
    close(): void { this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
  },
}));
const { requireApiVersion, Notice } = await import('obsidian');
const { RevertChangeModal } = await import('../src/revert-modal');
const change = computeDiff('old\n', 'new\n').changes[0]!;
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

describe('restoration confirmation UI', () => {
  it('previews only the selected change and its exact scope, never rendered Markdown', () => {
    const diff = computeDiff('old first\nkeep\nold second\n', '<img src=x onerror=alert(1)>\nkeep\nnew second\n');
    const modal = new RevertChangeModal({} as App, 'example.md', diff.changes[0]!, vi.fn());
    modal.open();
    expect(document.querySelector('.bmd-revert-scope')?.textContent).toBe('当前第 1 行');
    expect(document.querySelector('.bmd-revert-preview--added')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('.bmd-revert-preview--deleted')?.textContent).toBe('old first');
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).not.toContain('second');
    modal.close();
  });

  it('explicitly marks bounded previews without reducing the restoration scope', () => {
    const change = computeDiff('', 'x'.repeat(1000) + '\n' + 'line\n'.repeat(50)).changes[0]!;
    const modal = new RevertChangeModal({} as App, 'large.md', change, vi.fn());
    modal.open();
    expect(document.body.textContent).toContain('预览已截断');
    expect(document.body.textContent).toContain('撤销 51 行新增');
    expect(document.querySelector('.bmd-revert-preview--added')!.textContent!.length).toBeLessThan(1000);
    modal.close();
  });

  it.each([true, false])('keeps confirmation explicit with modern API = %s', async (modern) => {
    vi.mocked(requireApiVersion).mockReturnValue(modern);
    const confirm = vi.fn(async () => {});
    const modal = new RevertChangeModal({} as App, 'example.md', change, confirm);
    modal.open();
    expect(document.body.textContent).toContain('撤销 1 行新增，恢复 1 行删除');
    expect(confirm).not.toHaveBeenCalled();
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === '确认还原')!;
    expect(button.classList.contains(modern ? 'mod-destructive' : 'mod-warning')).toBe(true);
    button.click();
    expect(button.disabled).toBe(true);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(document.body.textContent).toBe(''));
  });

  it('cancels the pending confirmation on close without showing a failure notice', async () => {
    let signal: AbortSignal | undefined;
    const confirm = vi.fn((current: AbortSignal) => {
      signal = current;
      return new Promise<void>((_resolve, reject) => current.addEventListener('abort', () => reject(current.reason), { once: true }));
    });
    const modal = new RevertChangeModal({} as App, 'example.md', change, confirm);
    modal.open();
    document.querySelectorAll('button')[1]!.click();
    modal.close();
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(Notice).not.toHaveBeenCalled();
  });
});
