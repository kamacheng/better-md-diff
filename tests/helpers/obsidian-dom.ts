/** Minimal Obsidian DOM extensions at the host boundary; never shipped with the plugin. */
export function installObsidianDom(document: Document): void {
  const win = document.defaultView!;
  const make = (tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) => {
    const element = document.createElement(tag);
    if (options?.text !== undefined) element.textContent = options.text;
    if (options?.cls) element.className = options.cls;
    for (const [key, value] of Object.entries(options?.attr ?? {})) element.setAttribute(key, value);
    return element;
  };
  Object.defineProperty(win, 'createEl', { configurable: true, value: make });
  Object.defineProperty(win.Node.prototype, 'empty', { configurable: true, value: function (this: Node) { this.textContent = ''; } });
  Object.defineProperty(win.Node.prototype, 'setText', { configurable: true, value: function (this: Node, text: string) { this.textContent = text; } });
  Object.defineProperty(win.HTMLElement.prototype, 'addClass', { configurable: true, value: function (this: HTMLElement, ...classes: string[]) { this.classList.add(...classes); } });
  Object.defineProperty(win.HTMLElement.prototype, 'removeClass', { configurable: true, value: function (this: HTMLElement, ...classes: string[]) { this.classList.remove(...classes); } });
  Object.defineProperty(win.HTMLElement.prototype, 'toggleClass', { configurable: true, value: function (this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); } });
  Object.defineProperty(win.Node.prototype, 'createEl', { configurable: true, value: function (this: Node, tag: string, options?: Parameters<typeof make>[1]) {
    const element = make(tag, options); this.appendChild(element); return element;
  } });
  for (const [method, tag] of [['createDiv', 'div'], ['createSpan', 'span']]) {
    Object.defineProperty(win.Node.prototype, method!, { configurable: true, value: function (this: Node, options?: Parameters<typeof make>[1]) { return this.createEl(tag as 'div' | 'span', options); } });
  }
}
