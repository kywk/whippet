export type DiffKind = 'same' | 'add' | 'del';
export interface DiffLine { kind: DiffKind; text: string; before?: number; after?: number }
export type DiffItem = DiffLine | { kind: 'skip'; count: number };

/** 逐行 LCS 差異；超過上限時回傳 undefined，由畫面改用前後兩欄對照。 */
export function diffLines(before: string, after: string, limit = 360_000): DiffLine[] | undefined {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > limit) return undefined;
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: 'same', text: a[i], before: i + 1, after: j + 1 }); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { lines.push({ kind: 'del', text: a[i], before: i + 1 }); i++; }
    else { lines.push({ kind: 'add', text: b[j], after: j + 1 }); j++; }
  }
  while (i < a.length) { lines.push({ kind: 'del', text: a[i], before: i + 1 }); i++; }
  while (j < b.length) { lines.push({ kind: 'add', text: b[j], after: j + 1 }); j++; }
  return lines;
}

/** 只保留變更行與前後各 context 行，其餘折疊成「略過 N 行」。 */
export function collapseDiff(lines: DiffLine[], context = 2): DiffItem[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const items: DiffItem[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) { if (skipped) { items.push({ kind: 'skip', count: skipped }); skipped = 0; } items.push(line); }
    else skipped++;
  });
  if (skipped) items.push({ kind: 'skip', count: skipped });
  return items;
}

export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((line) => line.kind === 'add').length, removed: lines.filter((line) => line.kind === 'del').length };
}
