/** Extract only selected Markdown text; navigation, line numbers and visual hints are not source. */
export function selectedDiffText(body: HTMLElement, range: Range): string | undefined {
  if (range.collapsed || !body.contains(range.startContainer) || !body.contains(range.endContainer)) return;
  const rows: string[] = [];
  for (const code of Array.from(body.querySelectorAll<HTMLElement>('.bmd-row-text'))) {
    if (!range.intersectsNode(code)) continue;
    if (code.hasAttribute('data-source-empty')) { rows.push(''); continue; }
    const walker = code.ownerDocument.createTreeWalker(code, 4 /* SHOW_TEXT */);
    let text = '';
    let included = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('.bmd-no-newline') || !range.intersectsNode(node)) continue;
      const from = range.startContainer === node ? range.startOffset : 0;
      const to = range.endContainer === node ? range.endOffset : node.textContent!.length;
      text += node.textContent!.slice(from, to);
      included = true;
    }
    if (included) rows.push(text);
  }
  return rows.length ? rows.join('\n') : undefined;
}
