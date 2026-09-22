import { editorInfoField, FileSystemAdapter, getLanguage as getObsidianLanguage, MarkdownView, Notice, Plugin, requireApiVersion, setTooltip, TFile, type Command } from 'obsidian';
import { editorDiffExtension } from './editor';
import { GitBaselineReader, readGitBaseline, type BaselineRead } from './git';
import { DIFF_VIEW, DiffPanel } from './panel';
import { DiffSettingTab } from './settings';
import { DEFAULT_SETTINGS, normalizeSettings, type DiffSettings } from './options';
import { DiffStore, type ReadyDiffState } from './store';
import { normalizeText, type LineChange } from './diff';
import { executeChangeRevert } from './revert';
import { RevertChangeModal } from './revert-modal';
import { languageForObsidian, LocalizedError, onLanguageChange, setLanguage, t, type MessageKey } from './i18n';

export default class BetterMdDiff extends Plugin {
  settings: DiffSettings = { ...DEFAULT_SETTINGS };
  store!: DiffStore;
  private selectedPath?: string;
  private timers = new Map<string, number>();
  private trackedPaths = new Set<string>();
  private contentReads = new Map<string, symbol>();
  private stopped = false;
  private refreshing = false;
  private refreshQueued = false;
  private reader!: GitBaselineReader;
  private status!: HTMLElement;
  private revertModal?: RevertChangeModal;
  private gitPollTimer?: number;
  private appliedReadSettings = { ...DEFAULT_SETTINGS };

  private syncLanguage(): void {
    setLanguage(languageForObsidian(requireApiVersion('1.8.7') ? getObsidianLanguage() : document.documentElement.lang));
  }

  async onload(): Promise<void> {
    this.syncLanguage();
    this.settings = normalizeSettings(await this.loadData());
    this.appliedReadSettings = { ...this.settings };
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice(t('Better MD Diff 仅支持桌面端本地仓库。'));
      return;
    }
    this.reader = new GitBaselineReader(adapter.getBasePath(), this.settings.gitPath, this.settings);
    this.register(() => this.reader.dispose());
    this.store = new DiffStore((path) => this.reader.read(path), this.settings.contextLines, this.settings);
    this.register(() => this.store.dispose());
    this.registerView(DIFF_VIEW, (leaf) => new DiffPanel(leaf, {
      store: this.store,
      settings: () => this.settings,
      currentPath: () => this.selectedPath,
      refresh: (path) => this.refresh(path, true),
      navigate: (path, line, focus) => { void this.navigate(path, line, focus); },
      revert: (snapshot, change) => this.confirmRevert(snapshot, change),
    }));
    this.registerEditorExtension(editorDiffExtension({
      store: this.store,
      getPath: (view) => view.state.field(editorInfoField, false)?.file?.path,
      enabled: () => this.settings.showMarkers,
      open: (path, line, preferDeletion) => { void this.openDiff(path, line, preferDeletion); },
      select: (path, line) => this.followSelection(path, line),
    }));
    const settingsTab = new DiffSettingTab(this.app, this);
    this.addSettingTab(settingsTab);
    const ribbon = this.addRibbonIcon('git-compare-arrows', t('查看当前文档的 Git 差异'), () => { void this.openDiff(); });
    this.register(onLanguageChange(() => {
      this.revertModal?.close(); // Changing the prompt language must never keep a pending write alive.
      setTooltip(ribbon, t('查看当前文档的 Git 差异'));
      if (requireApiVersion('1.13.0')) settingsTab.update();
      else if (settingsTab.containerEl.isShown()) settingsTab.renderLegacy();
      this.store.updatePresentation(this.settings.contextLines);
      this.updateStatus();
    }));
    const addCommand = (name: MessageKey, command: Omit<Command, 'name'>) => {
      const registered = this.addCommand({ ...command, name: t(name) });
      this.register(onLanguageChange(() => { registered.name = `${this.manifest.name}: ${t(name)}`; }));
    };
    addCommand('查看当前文档与 HEAD 的差异', { id: 'open-diff', checkCallback: (checking) => {
      if (!this.selectedPath || this.stopped) return false;
      if (!checking) void this.openDiff();
      return true;
    } });
    addCommand('刷新 Git 差异', { id: 'refresh-diff', callback: () => { void this.refreshOpenFiles(); } });
    for (const direction of [-1, 1] as const) addCommand(direction === 1 ? '定位下一处差异' : '定位上一处差异', {
      id: direction === 1 ? 'next-change' : 'previous-change',
      checkCallback: (checking) => {
        const state = this.selectedPath ? this.store.get(this.selectedPath) : undefined;
        if (this.stopped || state?.status !== 'ready' || !state.diff.hunks.length) return false;
        if (!checking) void this.moveDiff(direction);
        return true;
      },
    });
    addCommand('切换原文差异标记', { id: 'toggle-markers', callback: () => {
      this.settings.showMarkers = !this.settings.showMarkers;
      void this.applySettings();
    } });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension.toLowerCase() === 'md') {
        menu.addItem((item) => item.setTitle(t('查看 Git 差异')).setIcon('git-compare-arrows').onClick(() => { void this.openDiff(file.path); }));
      }
    }));
    this.status = this.addStatusBarItem();
    this.status.addClass('bmd-status');
    this.status.setAttribute('role', 'button');
    this.status.setAttribute('tabindex', '0');
    this.registerDomEvent(this.status, 'click', () => { void this.openDiff(); });
    this.registerDomEvent(this.status, 'keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void this.openDiff(); }
    });
    this.register(this.store.subscribe((path) => { if (path === this.selectedPath) this.updateStatus(); }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.followActiveFile()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.followActiveFile()));
    this.registerEvent(this.app.workspace.on('layout-change', () => { void this.refreshOpenFiles(); }));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => {
      if (info.file?.extension.toLowerCase() === 'md') this.schedule(info.file.path);
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension.toLowerCase() === 'md' && this.trackedPaths.has(file.path)) this.schedule(file.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.selectedPath === oldPath) this.setSelected(file instanceof TFile && file.extension.toLowerCase() === 'md' ? file.path : undefined);
      this.forget(oldPath);
      void this.refreshOpenFiles();
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (this.selectedPath === file.path) this.setSelected(undefined);
      this.forget(file.path);
    }));
    this.restartPolling();
    this.registerDomEvent(window, 'focus', () => { this.syncLanguage(); void this.refreshOpenFiles(); });
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      if (!this.selectedPath) {
        const recent = this.app.workspace.getMostRecentLeaf()?.view;
        if (recent instanceof MarkdownView && recent.file?.extension.toLowerCase() === 'md') this.setSelected(recent.file.path);
      }
      this.followActiveFile();
      void this.refreshOpenFiles();
    });
  }

  private followActiveFile(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return; // Keep the target when focus moves to the diff panel or settings.
    this.setSelected(view.file?.extension.toLowerCase() === 'md' ? view.file.path : undefined);
    if (this.selectedPath) void this.refresh(this.selectedPath, true);
  }

  private followSelection(path: string, line: number): void {
    if (this.stopped || !this.settings.followEditor || !path.toLowerCase().endsWith('.md')) return;
    const panels = this.app.workspace.getLeavesOfType(DIFF_VIEW);
    if (!panels.length) return; // Cursor motion must never open or focus a panel.
    this.setSelected(path);
    for (const leaf of panels) if (leaf.view instanceof DiffPanel) leaf.view.showLine(line);
  }

  private setSelected(path: string | undefined): void {
    if (path !== this.selectedPath) {
      this.selectedPath = path;
      this.app.workspace.getLeavesOfType(DIFF_VIEW).forEach((leaf) => {
        if (leaf.view instanceof DiffPanel) leaf.view.setFile(path);
      });
    }
    this.updateStatus();
  }

  private schedule(path: string): void {
    if (this.stopped) return;
    window.clearTimeout(this.timers.get(path));
    this.timers.set(path, window.setTimeout(() => {
      this.timers.delete(path);
      void this.refresh(path);
    }, this.settings.editDelayMs));
  }

  private async currentContent(file: TFile): Promise<string> {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path) return active.getViewData();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) return leaf.view.getViewData();
    }
    return this.app.vault.read(file);
  }

  private async refresh(path: string, force = false, readBaseline?: BaselineRead): Promise<void> {
    if (this.stopped) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return;
    this.trackedPaths.add(path);
    const request = Symbol();
    this.contentReads.set(path, request);
    try {
      const content = await this.currentContent(file);
      if (!this.stopped && this.contentReads.get(path) === request) await this.store.refresh(path, content, force, readBaseline);
    } catch (error) {
      if (!this.stopped && this.contentReads.get(path) === request) this.store.reportError(path, error instanceof Error ? error.message : t('读取文档失败。'));
    }
  }

  private async refreshOpenFiles(queueIfBusy = true): Promise<void> {
    if (this.stopped || !this.store) return;
    if (this.refreshing) { this.refreshQueued ||= queueIfBusy; return; }
    this.refreshing = true;
    try {
      const paths = new Set<string>();
      this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.extension.toLowerCase() === 'md') paths.add(leaf.view.file.path);
      });
      if (this.selectedPath) paths.add(this.selectedPath);
      for (const path of this.trackedPaths) if (!paths.has(path)) this.forget(path);
      // One metadata snapshot per repository, then read each editor's latest buffer.
      const readBaseline = this.reader.batch([...paths]);
      for (const path of paths) {
        if (this.stopped) break;
        if (this.app.workspace.getLeavesOfType('markdown').some((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === path) || this.selectedPath === path) await this.refresh(path, true, readBaseline);
      }
    } finally {
      this.refreshing = false;
      if (this.refreshQueued && !this.stopped) {
        this.refreshQueued = false;
        void this.refreshOpenFiles();
      }
    }
  }

  private forget(path: string): void {
    window.clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    this.trackedPaths.delete(path);
    this.contentReads.delete(path);
    this.store.forget(path);
  }

  private updateStatus(): void {
    if (!this.status) return;
    const state = this.selectedPath ? this.store.get(this.selectedPath) : undefined;
    const text = state?.status === 'ready' ? `Git +${state.diff.added} −${state.diff.deleted}` : state?.status === 'error' ? t('Git：不可比较') : 'Git Diff';
    this.status.setText(text);
    this.status.setAttribute('aria-label', t('{text}，查看差异', { text }));
    this.status.title = state?.status === 'error' ? state.message : t('查看当前文档相对 HEAD 的差异');
  }

  async openDiff(path = this.selectedPath, line?: number, preferDeletion = false): Promise<void> {
    if (this.stopped || !this.store) return;
    if (!path) { new Notice(t('请先打开一个 Markdown 文档。')); return; }
    const editorView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const targetLine = line ?? (editorView?.file?.path === path && editorView.getMode() === 'source' ? editorView.editor.getCursor('head').line : undefined);
    this.setSelected(path);
    let leaf = this.app.workspace.getLeavesOfType(DIFF_VIEW)[0];
    if (!leaf) {
      // Add a tab to the sidebar instead of splitting off a short pane below it.
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: DIFF_VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof DiffPanel) {
      leaf.view.setFile(path);
      await this.refresh(path, true);
      if (targetLine !== undefined && this.selectedPath === path) leaf.view.showLine(targetLine, true, preferDeletion);
    }
  }

  private async moveDiff(direction: -1 | 1): Promise<void> {
    if (!this.app.workspace.getLeavesOfType(DIFF_VIEW).length) await this.openDiff();
    const panel = this.app.workspace.getLeavesOfType(DIFF_VIEW)[0]?.view;
    if (!this.stopped && panel instanceof DiffPanel) panel.move(direction);
  }

  private async navigate(path: string, line: number, focus = true): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice(t('文档已移动或删除。')); return; }
    const matches = this.app.workspace.getLeavesOfType('markdown').filter((candidate) => candidate.view instanceof MarkdownView && candidate.view.file?.path === path);
    const recent = this.app.workspace.getMostRecentLeaf();
    const leaf = matches.find((candidate) => candidate === recent && candidate.view.containerEl.isShown())
      ?? matches.find((candidate) => candidate.view.containerEl.isShown())
      ?? matches[0] ?? this.app.workspace.getLeaf('tab');
    if (!focus && leaf.view instanceof MarkdownView && leaf.view.file?.path === path && leaf.view.containerEl.isShown()) {
      const target = Math.min(line, leaf.view.getViewData().split('\n').length - 1);
      leaf.setEphemeralState({ line: target }); // Scroll the visible source/preview without stealing button focus.
      return;
    }
    await leaf.openFile(file, { active: true, eState: { line } });
    leaf.setEphemeralState({ line });
    await this.app.workspace.revealLeaf(leaf);
  }

  private confirmRevert(snapshot: ReadyDiffState, change: LineChange): void {
    this.revertModal?.close();
    this.revertModal = new RevertChangeModal(this.app, snapshot.path, change, (signal) => this.revertChange(snapshot, change, signal));
    this.revertModal.open();
  }

  private async revertChange(snapshot: ReadyDiffState, change: LineChange, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      const file = this.app.vault.getAbstractFileByPath(snapshot.path);
      const adapter = this.app.vault.adapter;
      if (!(file instanceof TFile) || !(adapter instanceof FileSystemAdapter)) throw new LocalizedError('文档已移动或删除，无法还原。');
      const leaf = this.app.workspace.getLeavesOfType('markdown').find((candidate) => candidate.view instanceof MarkdownView && candidate.view.file?.path === snapshot.path && candidate.view.getMode() === 'source' && candidate.view.containerEl.isShown());
      const view = leaf?.view;
      if (!leaf || !(view instanceof MarkdownView)) throw new LocalizedError('请先在源码编辑或实时预览中打开此文档，再还原此处。');
      const editor = view.editor;
      await executeChangeRevert(snapshot, change,
        () => readGitBaseline(adapter.getBasePath(), snapshot.path, this.settings.gitPath, signal, this.settings),
        {
          getValue: () => {
            if (this.stopped || view.file?.path !== snapshot.path || view.getMode() !== 'source') throw new LocalizedError('文档或模式已切换，请重新选择要还原的区块。');
            const current = editor.getValue();
            if (normalizeText(current) !== normalizeText(view.getViewData())) throw new LocalizedError('编辑器尚未同步，请切换到编辑模式后重试。');
            return current;
          },
          apply: (edits) => editor.transaction({
            changes: edits.map((edit) => ({ from: editor.offsetToPos(edit.from), to: editor.offsetToPos(edit.to), text: edit.text })),
            selection: { from: editor.offsetToPos(edits[0]!.from) },
          }, 'better-md-diff.revert'),
        }, signal);
      // A distinct editor transaction preserves undo; Git's index is never touched.
      this.revertModal?.close();
      leaf.setEphemeralState({ line: Math.min(change.from, view.getViewData().split('\n').length - 1) });
      new Notice(t('已还原此项。需要撤销时，在左侧编辑器按 Ctrl/Cmd+Z。'));
    } finally {
      if (!this.stopped) await this.refresh(snapshot.path, true);
    }
  }

  private restartPolling(): void {
    window.clearInterval(this.gitPollTimer);
    if (!this.stopped) this.gitPollTimer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void this.refreshOpenFiles(false); }, this.settings.gitPollSeconds * 1000);
  }

  async applySettings(): Promise<void> {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
    if (this.stopped) return;
    this.syncLanguage();
    this.restartPolling();
    this.store.updatePresentation(this.settings.contextLines, this.settings);
    if (this.appliedReadSettings.gitPath !== this.settings.gitPath || this.appliedReadSettings.maxFileMiB !== this.settings.maxFileMiB || this.appliedReadSettings.maxLines !== this.settings.maxLines) {
      this.appliedReadSettings = { ...this.settings };
      this.revertModal?.close();
      this.reader.dispose();
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) return;
      this.reader = new GitBaselineReader(adapter.getBasePath(), this.settings.gitPath, this.settings);
      this.contentReads.clear();
      for (const path of this.trackedPaths) this.store.forget(path);
      await this.refreshOpenFiles();
    }
  }

  onunload(): void {
    this.stopped = true;
    this.reader?.dispose();
    window.clearInterval(this.gitPollTimer);
    this.revertModal?.close();
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    this.contentReads.clear();
  }
}
