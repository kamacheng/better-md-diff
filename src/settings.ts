import { PluginSettingTab, Setting, type App } from 'obsidian';
import type BetterMdDiff from './main';
import { DEFAULT_SETTINGS, SETTING_LIMITS } from './options';
import { t, type MessageKey } from './i18n';

type ToggleKey = 'showMarkers' | 'inlineHighlights' | 'showWhitespace' | 'followEditor' | 'followNavigation';
type SettingRow = { name: string; desc: string } & ({ render: (setting: Setting) => void } | { render?: never });
type SettingSection = { type: 'group'; heading: string; items: SettingRow[] };

export class DiffSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BetterMdDiff) { super(app, plugin); }

  // 1.13+ uses these definitions for rendering and search. No I/O during indexing.
  getSettingDefinitions(): SettingSection[] {
    const toggle = (key: ToggleKey, name: MessageKey, desc: MessageKey): SettingRow => ({ name: t(name), desc: t(desc),
      render: (setting) => { setting.addToggle((control) => control.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.applySettings();
      })); },
    });
    const slider = (key: keyof typeof SETTING_LIMITS, name: MessageKey, desc: MessageKey, unit: string): SettingRow => ({ name: t(name), desc: t(desc),
      render: (setting) => {
        const describe = () => setting.setDesc(`${t(desc)} ${t('当前：{value} {unit}。', { value: this.plugin.settings[key], unit })}`);
        describe();
        const [min, max, step] = SETTING_LIMITS[key];
        setting.addSlider((control) => control.setLimits(min, max, step).setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value;
          describe();
          await this.plugin.applySettings();
        }));
      },
    });
    return [
      { type: 'group', heading: t('显示与排版'), items: [
        toggle('showMarkers', '在编辑正文显示差异标记', '源码编辑与实时预览中显示；阅读模式正文始终不显示。关闭后仍可使用差异面板。'),
        slider('fontSize', '差异面板字号', '调整差异正文及行号，不影响原文或其他插件。', 'px'),
        slider('contextLines', '上下文行数', '每处改动周围展示的未修改行数；仅影响阅读，不改变逐项还原范围。0 表示只显示改动。', t('行')),
        toggle('inlineHighlights', '突出变化字词', '使用更深的红绿底色标出变化字词；关闭不影响整行增删底色和旧新行配对。'),
        toggle('showWhitespace', '显示变化空白符', '变化空格显示 ·，Tab 显示 →，空行显示提示；复制仍得到原始 Markdown。'),
      ] },
      { type: 'group', heading: t('定位联动'), items: [
        toggle('followEditor', '左侧选行定位右侧', '只联动已打开的面板，不抢编辑焦点，也不会自动打开面板。'),
        toggle('followNavigation', '右侧前后按钮定位原文', '点击上一处/下一处时，同步定位原文；已显示的文档保持原模式和按钮焦点。'),
      ] },
      { type: 'group', heading: t('刷新节奏'), items: [
        slider('editDelayMs', '编辑后刷新延迟', '最后一次编辑后等待多久更新差异；数值越小，刷新越及时。', 'ms'),
        slider('gitPollSeconds', 'Git 变化检测间隔', '定时检查打开文档的 HEAD/跟踪状态；切回应用或手动刷新也会检查。', t('秒')),
      ] },
      { type: 'group', heading: t('Git 与还原'), items: [
        slider('maxFileMiB', '文档大小上限', '按每个版本的 UTF-8 字节数计算。提高上限可能增加内存占用和界面停顿；计算超时保护仍保留。', 'MiB'),
        slider('maxLines', '文档行数上限', '分别限制 HEAD 与当前内容，末尾换行后的空行也计入。提高上限不保证大型差异一定能完成计算。', t('行')),
        { name: t('Git 可执行文件'), desc: t('默认使用 PATH 中的 git，也可填写完整路径；不要附加参数或引号。'), render: (setting) => {
          setting.addText((text) => {
            text.setPlaceholder(DEFAULT_SETTINGS.gitPath).setValue(this.plugin.settings.gitPath);
            text.inputEl.addEventListener('change', () => {
              this.plugin.settings.gitPath = text.getValue().trim() || 'git';
              void this.plugin.applySettings();
            });
          });
        } },
        { name: t('还原安全说明'), desc: t('比较基准固定为 HEAD。Git 操作只读，不执行暂存或提交。只有确认“还原此项”后才修改编辑器；确认与过期检查不可关闭。') },
      ] },
    ];
  }

  // Obsidian 1.8–1.12 fallback, rendered from the same definitions to prevent drift.
  display(): void { this.renderLegacy(); }

  renderLegacy(): void {
    this.containerEl.empty();
    for (const section of this.getSettingDefinitions()) {
      new Setting(this.containerEl).setName(section.heading).setHeading();
      for (const item of section.items) {
        const setting = new Setting(this.containerEl).setName(item.name).setDesc(item.desc);
        item.render?.(setting);
      }
    }
  }
}
