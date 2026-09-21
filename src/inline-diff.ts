import { diffArrays } from 'diff';
import type { DiffRow } from './diff';

export interface InlineSegment {
  text: string;
  changed: boolean;
}

export interface InlineHighlights {
  segments: Map<DiffRow, InlineSegment[]>;
  pairs: Map<DiffRow, DiffRow>;
  limited: boolean;
}

const MAX_INLINE_LENGTH = 20_000;
const INLINE_BUDGET_MS = 80;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Refine replacements only; the original line diff and statistics stay unchanged. */
export function highlightRows(rows: readonly DiffRow[]): InlineHighlights {
  const result: InlineHighlights = {
    segments: new Map(rows.map((row) => [row, [{ text: row.text, changed: row.kind !== 'context' }]])),
    pairs: new Map(),
    limited: false,
  };
  const deadline = Date.now() + INLINE_BUDGET_MS;
  for (let start = 0; start < rows.length;) {
    if (rows[start]!.kind === 'context') { start++; continue; }
    let end = start;
    while (end < rows.length && rows[end]!.kind !== 'context') end++;
    const block = rows.slice(start, end);
    const removed = block.filter((row) => row.kind === 'deleted');
    const added = block.filter((row) => row.kind === 'added');
    start = end;
    if (!removed.length || !added.length) continue;
    if (block.reduce((length, row) => length + row.text.length, 0) > MAX_INLINE_LENGTH || Date.now() >= deadline) {
      result.limited = true;
      pairByPosition(removed, added, result.pairs);
      continue;
    }
    // Align similar lines first, so inserted lines cannot steal matching letters from their neighbors.
    const alignment = diffArrays(removed, added, { comparator: similarLine, timeout: Math.max(1, deadline - Date.now()) });
    if (!alignment) { result.limited = true; pairByPosition(removed, added, result.pairs); continue; }
    let oldIndex = 0;
    let newIndex = 0;
    for (let i = 0; i < alignment.length; i++) {
      const part = alignment[i]!;
      const count = part.value.length;
      if (!part.added && !part.removed) {
        for (let j = 0; j < count; j++) refineLine(removed[oldIndex++]!, added[newIndex++]!, result, deadline);
      } else if (part.removed && alignment[i + 1]?.added) {
        const addedCount = alignment[++i]!.value.length;
        // Equal-size unmatched ranges can still share text in the middle of each line.
        if (count === addedCount) {
          for (let j = 0; j < count; j++) refineLine(removed[oldIndex + j]!, added[newIndex + j]!, result, deadline);
        }
        oldIndex += count;
        newIndex += addedCount;
      } else if (part.removed) oldIndex += count;
      else newIndex += count;
    }
  }
  return result;
}

function pairByPosition(removed: DiffRow[], added: DiffRow[], pairs: Map<DiffRow, DiffRow>): void {
  for (let i = 0; i < Math.min(removed.length, added.length); i++) {
    pairs.set(removed[i]!, added[i]!);
    pairs.set(added[i]!, removed[i]!);
  }
}

/** Display projection only: preserve the canonical diff rows for navigation and restoration. */
export function pairDiffRows(rows: readonly DiffRow[], pairs: ReadonlyMap<DiffRow, DiffRow>): DiffRow[] {
  const result: DiffRow[] = [];
  for (let start = 0; start < rows.length;) {
    if (rows[start]!.kind === 'context') { result.push(rows[start++]!); continue; }
    let end = start;
    while (end < rows.length && rows[end]!.kind !== 'context') end++;
    const block = rows.slice(start, end);
    const added = block.filter((row) => row.kind === 'added');
    const positions = new Map(added.map((row, index) => [row, index]));
    let nextAdded = 0;
    for (const old of block.filter((row) => row.kind === 'deleted')) {
      const pair = pairs.get(old);
      const index = pair && positions.get(pair);
      if (index !== undefined) {
        while (nextAdded < index) result.push(added[nextAdded++]!);
        result.push(old, added[nextAdded++]!);
      } else result.push(old);
    }
    result.push(...added.slice(nextAdded));
    start = end;
  }
  return result;
}

function similarLine(left: DiffRow, right: DiffRow): boolean {
  const a = left.text;
  const b = right.text;
  if (a === b) return true;
  const length = Math.min(a.length, b.length);
  if (!length) return false;
  let prefix = 0;
  while (prefix < length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return prefix + suffix >= length / 2;
}

function refineLine(before: DiffRow, after: DiffRow, result: InlineHighlights, deadline: number): void {
  result.pairs.set(before, after);
  result.pairs.set(after, before);
  if (Date.now() >= deadline) { result.limited = true; return; }
  const tokens = (text: string) => Array.from(graphemes.segment(text), ({ segment }) => segment);
  const oldTokens = tokens(before.text);
  const newTokens = tokens(after.text);
  const remaining = deadline - Date.now();
  const parts = remaining > 0 ? diffArrays(oldTokens, newTokens, { timeout: remaining }) : undefined;
  if (!parts) { result.limited = true; return; }
  result.segments.set(before, parts.filter((part) => !part.added).map((part) => ({ text: part.value.join(''), changed: part.removed })));
  result.segments.set(after, parts.filter((part) => !part.removed).map((part) => ({ text: part.value.join(''), changed: part.added })));
}

/** Only pseudo-elements visualize whitespace, so copying still yields actual spaces/tabs. */
export function renderHighlightedText(container: HTMLElement, row: DiffRow, segments: readonly InlineSegment[]): void {
  container.replaceChildren();
  container.toggleAttribute('data-source-empty', !row.text);
  const document = container.ownerDocument;
  for (const segment of segments) {
    if (!segment.changed || row.kind === 'context') {
      container.append(document.createTextNode(segment.text));
      continue;
    }
    const mark = document.createElement('mark');
    mark.className = `bmd-inline-change bmd-inline-${row.kind}`;
    const action = row.kind === 'added' ? '新增' : '删除';
    mark.title = `${action}内容`;
    for (const piece of segment.text.match(/[ \t]|[^ \t]+/g) ?? []) {
      if (piece === ' ' || piece === '\t') {
        const whitespace = document.createElement('span');
        whitespace.className = 'bmd-inline-whitespace';
        whitespace.textContent = piece;
        whitespace.dataset.symbol = piece === ' ' ? '·' : '→';
        whitespace.title = `${action}${piece === ' ' ? '空格' : '制表符'}`;
        mark.append(whitespace);
      } else mark.append(document.createTextNode(piece));
    }
    container.append(mark);
  }
  if (!row.text) {
    container.append(document.createTextNode(' '));
    if (row.kind !== 'context') {
      container.classList.add('bmd-empty-line');
      container.title = row.kind === 'added' ? '新增空行' : '删除空行';
    }
  }
}
