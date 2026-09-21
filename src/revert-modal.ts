import { Modal, Notice, Setting, type App } from 'obsidian';
import type { DiffHunk } from './diff';

export class RevertHunkModal extends Modal {
  private controller = new AbortController();

  constructor(app: App, private path: string, private hunk: DiffHunk, private confirm: (signal: AbortSignal) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('还原这处改动？');
    this.contentEl.createEl('p', { text: this.path });
    const added = this.hunk.rows.filter((row) => row.kind === 'added').length;
    const deleted = this.hunk.rows.filter((row) => row.kind === 'deleted').length;
    this.contentEl.createEl('p', { text: `将此区块恢复到 HEAD：撤销 ${added} 行新增，恢复 ${deleted} 行删除。其他区块不受影响。` });
    this.contentEl.createEl('p', { text: '不会暂存、提交或删除文件。需在已打开的编辑模式中还原；可在左侧编辑器撤销（Ctrl/Cmd+Z）。' });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
      .addButton((button) => button.setButtonText('确认还原').setWarning().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.confirm(this.controller.signal);
          this.close();
        } catch (error) {
          if (!this.controller.signal.aborted) new Notice(error instanceof Error ? error.message : '还原失败。');
          this.close();
        }
      }));
  }

  onClose(): void {
    this.controller.abort();
    this.contentEl.empty();
  }
}
