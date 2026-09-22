// Test-only runtime host boundary: the npm Obsidian SDK ships declarations only.
export function setIcon(element: HTMLElement, name: string): void { element.dataset.icon = name; }
export class ItemView {
  contentEl = document.createElement('div');
  containerEl = this.contentEl;
  private cleanups: (() => void)[] = [];
  register(cleanup: () => void): void { this.cleanups.push(cleanup); }
  registerDomEvent(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.register(() => target.removeEventListener(type, listener));
  }
  unload(): void { for (const cleanup of this.cleanups.splice(0)) cleanup(); }
}
