// Test-only host boundary for Obsidian's imperative settings controls.
export class PluginSettingTab {
  containerEl = document.createElement('div');
}

class InputControl {
  inputEl: HTMLInputElement;
  constructor(parent: HTMLElement, type: string) {
    this.inputEl = parent.ownerDocument.createElement('input');
    this.inputEl.type = type;
    parent.append(this.inputEl);
  }
  setValue(value: string | number | boolean): this {
    if (typeof value === 'boolean') this.inputEl.checked = value;
    else this.inputEl.value = String(value);
    return this;
  }
  getValue(): string { return this.inputEl.value; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  setLimits(min: number, max: number, step: number): this {
    this.inputEl.min = String(min); this.inputEl.max = String(max); this.inputEl.step = String(step);
    return this;
  }
}
class ToggleControl extends InputControl {
  onChange(callback: (value: boolean) => unknown): this {
    this.inputEl.addEventListener('change', () => { callback(this.inputEl.checked); }); return this;
  }
}
class SliderControl extends InputControl {
  onChange(callback: (value: number) => unknown): this {
    this.inputEl.addEventListener('input', () => { callback(Number(this.inputEl.value)); }); return this;
  }
}

export class ButtonControl {
  buttonEl: HTMLButtonElement;
  constructor(parent: HTMLElement) { this.buttonEl = parent.ownerDocument.createElement('button'); parent.append(this.buttonEl); }
  setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
  setDisabled(value: boolean): this { this.buttonEl.disabled = value; return this; }
  setDestructive(): this { this.buttonEl.classList.add('mod-destructive'); return this; }
  setCta(): this { this.buttonEl.classList.add('mod-cta'); return this; }
  onClick(callback: () => unknown): this { this.buttonEl.addEventListener('click', () => { callback(); }); return this; }
}

export class Setting {
  settingEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  constructor(parent: HTMLElement) {
    this.settingEl = parent.ownerDocument.createElement('section');
    this.nameEl = parent.ownerDocument.createElement('label');
    this.descEl = parent.ownerDocument.createElement('p');
    this.settingEl.append(this.nameEl, this.descEl); parent.append(this.settingEl);
  }
  setName(name: string): this { this.nameEl.textContent = name; return this; }
  setDesc(desc: string): this { this.descEl.textContent = desc; return this; }
  setHeading(): this { this.settingEl.classList.add('setting-heading'); return this; }
  addToggle(callback: (control: ToggleControl) => unknown): this { callback(new ToggleControl(this.settingEl, 'checkbox')); return this; }
  addSlider(callback: (control: SliderControl) => unknown): this { callback(new SliderControl(this.settingEl, 'range')); return this; }
  addText(callback: (control: InputControl) => unknown): this { callback(new InputControl(this.settingEl, 'text')); return this; }
  addButton(callback: (control: ButtonControl) => unknown): this { callback(new ButtonControl(this.settingEl)); return this; }
}
