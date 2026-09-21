import { PluginSettingTab, Setting, type App } from 'obsidian';
import type BetterMdDiff from './main';
import { SETTING_LIMITS } from './options';

type ToggleKey = 'showMarkers' | 'inlineHighlights' | 'showWhitespace' | 'followEditor' | 'followNavigation';

export class DiffSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BetterMdDiff) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    const heading = (name: string) => new Setting(this.containerEl).setName(name).setHeading();
    const toggle = (key: ToggleKey, name: string, description: string) => new Setting(this.containerEl)
      .setName(name).setDesc(description)
      .addToggle((control) => control.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.applySettings();
      }));
    const slider = (key: keyof typeof SETTING_LIMITS, name: string, description: string, unit: string) => {
      const setting = new Setting(this.containerEl).setName(name);
      const describe = () => setting.setDesc(`${description} 当前：${this.plugin.settings[key]} ${unit}。`);
      describe();
      const [min, max, step] = SETTING_LIMITS[key];
      setting.addSlider((control) => control.setLimits(min, max, step).setValue(this.plugin.settings[key]).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings[key] = value;
        describe();
        await this.plugin.applySettings();
      }));
    };

    heading('显示与排版');
    toggle('showMarkers', '在编辑正文显示差异标记', '源码编辑与实时预览中显示；阅读模式正文始终不显示。关闭后仍可使用差异面板。');
    slider('fontSize', '差异面板字号', '调整差异正文及行号，不影响原文或其他插件。', 'px');
    slider('contextLines', '上下文行数', '每处变更周围展示的未修改行数；相邻区块可能合并，0 表示只显示变更。', '行');
    toggle('inlineHighlights', '突出变化字词', '使用更深的红绿底色标出变化字词；关闭不影响整行增删底色和旧新行配对。');
    toggle('showWhitespace', '显示变化空白符', '变化空格显示 ·，Tab 显示 →，空行显示提示；复制仍得到原始 Markdown。');

    heading('定位联动');
    toggle('followEditor', '左侧选行定位右侧', '只联动已打开的面板，不抢编辑焦点，也不会自动打开面板。');
    toggle('followNavigation', '右侧前后按钮定位原文', '点击上一处/下一处时，同步定位原文；已显示的文档保持原模式和按钮焦点。');

    heading('刷新节奏');
    slider('editDelayMs', '编辑后刷新延迟', '最后一次编辑后等待多久更新差异；数值越小，刷新越及时。', 'ms');
    slider('gitPollSeconds', 'Git 变化检测间隔', '定时检查打开文档的 HEAD/跟踪状态；切回应用或手动刷新也会检查。', '秒');

    heading('Git 与还原');
    new Setting(this.containerEl)
      .setName('Git 可执行文件')
      .setDesc('默认使用 PATH 中的 git，也可填写完整路径；不要附加参数或引号。')
      .addText((text) => {
        text.setPlaceholder('git').setValue(this.plugin.settings.gitPath);
        text.inputEl.addEventListener('change', () => {
          this.plugin.settings.gitPath = text.getValue().trim() || 'git';
          void this.plugin.applySettings();
        });
      });
    this.containerEl.createEl('p', { text: '比较基准固定为 HEAD。Git 操作只读，不执行暂存或提交。只有确认“还原此处”后才修改编辑器；确认与过期检查不可关闭。' });
  }
}
