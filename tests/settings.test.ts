// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../src/i18n';
import type { App, Setting as HostSetting } from 'obsidian';
import type BetterMdDiff from '../src/main';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/options';

import { Setting } from './helpers/obsidian-setting';
import { installObsidianDom } from './helpers/obsidian-dom';

installObsidianDom(document);
vi.mock('obsidian', () => import('./helpers/obsidian-setting'));
const { DiffSettingTab } = await import('../src/settings');

function setup() {
  const host = {
    settings: { ...DEFAULT_SETTINGS },
    applySettings: vi.fn(async () => { host.settings = normalizeSettings(host.settings); }),
  };
  const tab = new DiffSettingTab({} as App, host as unknown as BetterMdDiff);
  return { tab, host };
}

afterEach(() => setLanguage('zh-CN'));
describe('searchable settings with legacy support', () => {
  it('uses the current host locale without exposing a plugin language override', () => {
    const { tab } = setup();
    setLanguage('en');
    const definitions = tab.getSettingDefinitions();
    expect(definitions[0]?.heading).toBe('Appearance');
    expect(definitions[0]?.items[0]?.name).toBe('Show diff markers in the editor');
    expect(definitions.flatMap((group) => group.items).some((row) => /language/i.test(row.name))).toBe(false);
  });

  it.each(['legacy', 'declarative'])('renders and persists controls through the %s host path', async (mode) => {
    const { tab, host } = setup();
    if (mode === 'legacy') tab.display();
    else for (const section of tab.getSettingDefinitions()) {
      for (const item of section.items) {
        const setting = new Setting(tab.containerEl).setName(item.name).setDesc(item.desc);
        item.render?.(setting as unknown as HostSetting);
      }
    }
    const inputs = tab.containerEl.querySelectorAll('input');
    expect(inputs).toHaveLength(12);
    const toggle = tab.containerEl.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(toggle.checked).toBe(true);
    toggle.checked = false; toggle.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(host.settings.showMarkers).toBe(false));
    const slider = tab.containerEl.querySelector<HTMLInputElement>('input[type=range]')!;
    expect([slider.min, slider.max, slider.step]).toEqual(['10', '22', '1']);
    slider.value = '18'; slider.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(host.settings.fontSize).toBe(18));
    expect(slider.parentElement?.textContent).toContain('18 px');
    const git = tab.containerEl.querySelector<HTMLInputElement>('input[type=text]')!;
    git.value = '  /usr/bin/git  '; git.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(host.settings.gitPath).toBe('/usr/bin/git'));
    git.value = ' '; git.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(host.settings.gitPath).toBe('git'));
    const bytes = tab.containerEl.querySelector<HTMLInputElement>('input[max="20"]')!;
    bytes.value = '10'; bytes.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(host.settings.maxFileMiB).toBe(10));
    const lines = tab.containerEl.querySelector<HTMLInputElement>('input[max="200000"]')!;
    lines.value = '100000'; lines.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(host.settings.maxLines).toBe(100000));
    expect(host.applySettings).toHaveBeenCalledTimes(6);
  });

  it('exposes every setting in named searchable groups without I/O', () => {
    const { tab, host } = setup();
    const definitions = tab.getSettingDefinitions();
    expect(definitions.map((group) => group.heading)).toEqual(['显示与排版', '定位联动', '刷新节奏', 'Git 与还原']);
    expect(definitions.flatMap((group) => group.items.map((item) => item.name))).toEqual([
      '在编辑正文显示差异标记', '差异面板字号', '上下文行数', '突出变化字词', '显示变化空白符',
      '左侧选行定位右侧', '右侧前后按钮定位原文', '编辑后刷新延迟', 'Git 变化检测间隔',
      '文档大小上限', '文档行数上限', 'Git 可执行文件', '还原安全说明',
    ]);
    expect(host.applySettings).not.toHaveBeenCalled();
  });
});
