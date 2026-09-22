import { Modal, Notice, Setting, requireApiVersion, type App } from 'obsidian';
import { changeRange, type LineChange } from './diff';
import { t, type MessageKey } from './i18n';

export class RevertChangeModal extends Modal {
  private controller = new AbortController();

  constructor(app: App, private path: string, private change: LineChange, private confirm: (signal: AbortSignal) => Promise<void>) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t('还原这一项改动？'));
    this.contentEl.createEl('p', { cls: 'bmd-revert-path', text: this.path });
    this.contentEl.createEl('p', { cls: 'bmd-revert-scope', text: changeRange(this.change) });
    this.contentEl.createEl('p', { text: t('仅还原这一项：撤销 {added} 行新增，恢复 {deleted} 行删除。其他改动不受影响。', { added: this.change.added, deleted: this.change.deleted }) });
    const previews = this.contentEl.createDiv({ cls: 'bmd-revert-previews' });
    this.preview(previews, '当前内容', 'added');
    this.preview(previews, '还原后（HEAD）', 'deleted');
    this.contentEl.createEl('p', { text: t('不会暂存、提交或删除文件。需在已打开的编辑模式中还原；可在左侧编辑器撤销（Ctrl/Cmd+Z）。') });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t('取消')).onClick(() => this.close()))
      .addButton((button) => {
        if (requireApiVersion('1.13.0')) button.setDestructive().setCta();
        else button.buttonEl.addClass('mod-warning');
        button.setButtonText(t('确认还原')).onClick(async () => {
          button.setDisabled(true);
          try {
            await this.confirm(this.controller.signal);
            this.close();
          } catch (error) {
            if (!this.controller.signal.aborted) new Notice(error instanceof Error ? error.message : t('还原失败。'));
            this.close();
          }
        });
      });
  }

  private preview(parent: HTMLElement, heading: MessageKey, kind: 'added' | 'deleted'): void {
    const rows = this.change.rows.filter((row) => row.kind === kind);
    const section = parent.createDiv();
    section.createEl('h3', { text: t(heading) });
    // Bound preview layout independently of the accepted document size; never render Markdown/HTML.
    const shown = rows.slice(0, 40);
    const content = shown.map((row) => row.text.slice(0, 400) + (row.text.length > 400 ? '…' : '') + (row.noNewline ? t(' ⏎ 无末尾换行') : '')).join('\n');
    section.createEl('pre', { cls: `bmd-revert-preview bmd-revert-preview--${kind}`, text: rows.length ? content : t('无内容') });
    if (rows.length > shown.length || shown.some((row) => row.text.length > 400)) section.createEl('p', { cls: 'bmd-hint', text: t('预览已截断；仍将还原上述完整范围。') });
  }

  onClose(): void { this.controller.abort(); this.contentEl.empty(); }
}
