import { Modal, type App } from 'obsidian';
import type { DiffSettings } from './options';
import { onLanguageChange, t } from './i18n';

/** Read-only help uses the host's dialog/focus handling, never the diff's scrolling area. */
export class ReadingGuideModal extends Modal {
  private stopLanguage?: () => void;

  constructor(app: App, private settings: () => DiffSettings, private closed: () => void) { super(app); }

  onOpen(): void {
    this.titleEl.addClass('bmd-guide-title');
    this.contentEl.addClass('bmd-reading-guide');
    this.render();
    this.stopLanguage = onLanguageChange(() => this.render());
  }

  private render(): void {
    const settings = this.settings();
    const restoreFocus = this.contentEl.contains(this.contentEl.ownerDocument.activeElement);
    this.titleEl.setText(t('阅读说明'));
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: t('导航按改动项计数；区块标题显示行范围和所含改动数。区块之间省略未修改内容。') });
    this.contentEl.createEl('p', { text: t('连续增删是一项改动；每项独立还原，上下文只用于阅读。') });
    this.contentEl.createEl('p', { text: t('红色文字为旧文，绿色文字为新增内容；旧、新行配对展示，两列行号依次为 HEAD、当前内容。') + (settings.inlineHighlights ? t('深色突出变化字词；') : '') + (settings.showWhitespace ? t('· 为空格，→ 为 Tab；') : '') + t('正文可选中复制。') });
    if (settings.showMarkers) this.contentEl.createEl('p', { text: t('左侧旗标 +n、~n 表示当前新增、修改的行数，细线标出范围；−n 表示旧文删除行数，仅标记删除边界。渲染或折叠块显示首项旗标，具体范围见右侧。') });
    this.contentEl.createEl('p', { text: t('点击区块标题选中第一项改动；点击改动行号精确选中该项。开启原文联动时同步定位左侧；正文仍可拖选复制，行尾箭头仅还原该项。') });
    this.contentEl.createEl('p', { cls: 'bmd-hint', text: t('不会暂存、提交或删除文件。需在已打开的编辑模式中还原；可在左侧编辑器撤销（Ctrl/Cmd+Z）。') });
    const actions = this.contentEl.createDiv({ cls: 'bmd-guide-actions' });
    const close = actions.createEl('button', { cls: 'bmd-guide-close', text: t('关闭'), attr: { type: 'button' } });
    close.addEventListener('click', () => this.close());
    if (restoreFocus) close.focus({ preventScroll: true });
  }

  onClose(): void {
    this.stopLanguage?.();
    this.stopLanguage = undefined;
    this.contentEl.empty();
    this.closed();
  }
}
