import { editorInfoField, FileSystemAdapter, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { editorDiffExtension } from './editor';
import { readGitBaseline } from './git';
import { DIFF_VIEW, DiffPanel } from './panel';
import { DiffSettingTab } from './settings';
import { DEFAULT_SETTINGS, normalizeSettings, type DiffSettings } from './options';
import { DiffStore, type ReadyDiffState } from './store';
import { normalizeText, type DiffHunk } from './diff';
import { executeHunkRevert } from './revert';
import { RevertHunkModal } from './revert-modal';

export default class BetterMdDiff extends Plugin {
  settings: DiffSettings = { ...DEFAULT_SETTINGS };
  store!: DiffStore;
  private selectedPath?: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private trackedPaths = new Set<string>();
  private contentReads = new Map<string, symbol>();
  private stopped = false;
  private refreshing = false;
  private status!: HTMLElement;
  private revertModal?: RevertHunkModal;
  private gitPollTimer?: number;
  private appliedGitPath = 'git';

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.appliedGitPath = this.settings.gitPath;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('Better MD Diff 仅支持桌面端本地仓库。');
      return;
    }
    this.store = new DiffStore((path) => readGitBaseline(adapter.getBasePath(), path, this.settings.gitPath), this.settings.contextLines);
    this.register(() => this.store.dispose());
    this.registerView(DIFF_VIEW, (leaf) => new DiffPanel(leaf, {
      store: this.store,
      settings: () => this.settings,
      currentPath: () => this.selectedPath,
      refresh: (path) => { void this.refresh(path, true); },
      navigate: (path, line, focus) => { void this.navigate(path, line, focus); },
      revert: (snapshot, hunk) => this.confirmRevert(snapshot, hunk),
    }));
    this.registerEditorExtension(editorDiffExtension({
      store: this.store,
      getPath: (view) => view.state.field(editorInfoField, false)?.file?.path,
      enabled: () => this.settings.showMarkers,
      open: (path, line) => { void this.openDiff(path, line); },
      select: (path, line) => this.followSelection(path, line),
    }));
    this.addSettingTab(new DiffSettingTab(this.app, this));
    this.addRibbonIcon('git-compare-arrows', '查看当前文档的 Git 差异', () => { void this.openDiff(); });
    this.addCommand({ id: 'open-diff', name: '查看当前文档与 HEAD 的差异', checkCallback: (checking) => {
      if (!this.selectedPath || this.stopped) return false;
      if (!checking) void this.openDiff();
      return true;
    } });
    this.addCommand({ id: 'refresh-diff', name: '刷新 Git 差异', callback: () => { void this.refreshOpenFiles(); } });
    this.addCommand({ id: 'toggle-markers', name: '切换原文差异标记', callback: () => {
      this.settings.showMarkers = !this.settings.showMarkers;
      void this.applySettings();
    } });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension.toLowerCase() === 'md') {
        menu.addItem((item) => item.setTitle('查看 Git 差异').setIcon('git-compare-arrows').onClick(() => { void this.openDiff(file.path); }));
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
    this.registerDomEvent(window, 'focus', () => { void this.refreshOpenFiles(); });
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
    clearTimeout(this.timers.get(path));
    this.timers.set(path, setTimeout(() => {
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

  private async refresh(path: string, force = false): Promise<void> {
    if (this.stopped) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return;
    this.trackedPaths.add(path);
    const request = Symbol();
    this.contentReads.set(path, request);
    try {
      const content = await this.currentContent(file);
      if (!this.stopped && this.contentReads.get(path) === request) await this.store.refresh(path, content, force);
    } catch (error) {
      if (!this.stopped && this.contentReads.get(path) === request) this.store.reportError(path, error instanceof Error ? error.message : '读取文档失败。');
    }
  }

  private async refreshOpenFiles(): Promise<void> {
    if (this.stopped || !this.store || this.refreshing) return;
    this.refreshing = true;
    try {
      const paths = new Set<string>();
      this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.extension.toLowerCase() === 'md') paths.add(leaf.view.file.path);
      });
      if (this.selectedPath) paths.add(this.selectedPath);
      for (const path of this.trackedPaths) if (!paths.has(path)) this.forget(path);
      // Sequential across documents: don't spawn one Git process per open tab at once.
      for (const path of paths) await this.refresh(path, true);
    } finally {
      this.refreshing = false;
    }
  }

  private forget(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    this.trackedPaths.delete(path);
    this.contentReads.delete(path);
    this.store.forget(path);
  }

  private updateStatus(): void {
    if (!this.status) return;
    const state = this.selectedPath ? this.store.get(this.selectedPath) : undefined;
    const text = state?.status === 'ready' ? `Git +${state.diff.added} −${state.diff.deleted}` : state?.status === 'error' ? 'Git：不可比较' : 'Git Diff';
    this.status.setText(text);
    this.status.setAttribute('aria-label', `${text}，查看差异`);
    this.status.title = state?.status === 'error' ? state.message : '查看当前文档相对 HEAD 的差异';
  }

  async openDiff(path = this.selectedPath, line?: number): Promise<void> {
    if (this.stopped || !this.store) return;
    if (!path) { new Notice('请先打开一个 Markdown 文档。'); return; }
    const editorView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const targetLine = line ?? (editorView?.file?.path === path && editorView.getMode() === 'source' ? editorView.editor.getCursor('head').line : undefined);
    this.setSelected(path);
    let leaf = this.app.workspace.getLeavesOfType(DIFF_VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(true) ?? this.app.workspace.getLeaf('split');
      await leaf.setViewState({ type: DIFF_VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof DiffPanel) {
      leaf.view.setFile(path);
      await this.refresh(path, true);
      if (targetLine !== undefined && this.selectedPath === path) leaf.view.showLine(targetLine);
    }
  }

  private async navigate(path: string, line: number, focus = true): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice('文档已移动或删除。'); return; }
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

  private confirmRevert(snapshot: ReadyDiffState, hunk: DiffHunk): void {
    this.revertModal?.close();
    this.revertModal = new RevertHunkModal(this.app, snapshot.path, hunk, (signal) => this.revertHunk(snapshot, hunk, signal));
    this.revertModal.open();
  }

  private async revertHunk(snapshot: ReadyDiffState, hunk: DiffHunk, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      const file = this.app.vault.getAbstractFileByPath(snapshot.path);
      const adapter = this.app.vault.adapter;
      if (!(file instanceof TFile) || !(adapter instanceof FileSystemAdapter)) throw new Error('文档已移动或删除，无法还原。');
      const leaf = this.app.workspace.getLeavesOfType('markdown').find((candidate) => candidate.view instanceof MarkdownView && candidate.view.file?.path === snapshot.path && candidate.view.getMode() === 'source' && candidate.view.containerEl.isShown());
      const view = leaf?.view;
      if (!leaf || !(view instanceof MarkdownView)) throw new Error('请先在源码编辑或实时预览中打开此文档，再还原此处。');
      const editor = view.editor;
      await executeHunkRevert(snapshot, hunk,
        () => readGitBaseline(adapter.getBasePath(), snapshot.path, this.settings.gitPath),
        {
          getValue: () => {
            if (this.stopped || view.file?.path !== snapshot.path || view.getMode() !== 'source') throw new Error('文档或模式已切换，请重新选择要还原的区块。');
            const current = editor.getValue();
            if (normalizeText(current) !== normalizeText(view.getViewData())) throw new Error('编辑器尚未同步，请切换到编辑模式后重试。');
            return current;
          },
          apply: (edits) => editor.transaction({
            changes: edits.map((edit) => ({ from: editor.offsetToPos(edit.from), to: editor.offsetToPos(edit.to), text: edit.text })),
            selection: { from: editor.offsetToPos(edits[0]!.from) },
          }, 'better-md-diff.revert'),
        }, signal);
      // A distinct editor transaction preserves undo; Git's index is never touched.
      this.revertModal?.close();
      leaf.setEphemeralState({ line: Math.min(hunk.line, view.getViewData().split('\n').length - 1) });
      new Notice('已还原此处。需要撤销时，在左侧编辑器按 Ctrl/Cmd+Z。');
    } finally {
      if (!this.stopped) await this.refresh(snapshot.path, true);
    }
  }

  private restartPolling(): void {
    window.clearInterval(this.gitPollTimer);
    if (!this.stopped) this.gitPollTimer = window.setInterval(() => { void this.refreshOpenFiles(); }, this.settings.gitPollSeconds * 1000);
  }

  async applySettings(): Promise<void> {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
    if (this.stopped) return;
    this.restartPolling();
    this.store.updatePresentation(this.settings.contextLines);
    if (this.appliedGitPath !== this.settings.gitPath) {
      this.appliedGitPath = this.settings.gitPath;
      for (const path of this.trackedPaths) this.store.forget(path);
      await this.refreshOpenFiles();
    }
  }

  onunload(): void {
    this.stopped = true;
    window.clearInterval(this.gitPollTimer);
    this.revertModal?.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.contentReads.clear();
  }
}
