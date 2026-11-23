// Unified line diffs, so a reviewer sees exactly what changed (not whole files).
//
// Common leading/trailing lines are trimmed first, then the middle is diffed
// with an LCS table; a middle too large for that is shown as removed + added.

const MAX_CELLS = 2_000_000;

type Op = { kind: ' ' | '-' | '+'; line: string; a: number; b: number };

function lcsOps(a: string[], b: string[], aStart: number, bStart: number): Op[] {
  const n = a.length, m = b.length;
  if (n * m > MAX_CELLS) {
    return [
      ...a.map((line, i) => ({ kind: '-' as const, line, a: aStart + i, b: bStart })),
      ...b.map((line, j) => ({ kind: '+' as const, line, a: aStart + n, b: bStart + j })),
    ];
  }
  // table[i][j] = LCS length of a[i..] and b[j..]
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i], a: aStart + i, b: bStart + j });
      i++, j++;
    } else if (i < n && (j >= m || table[(i + 1) * w + j] >= table[i * w + j + 1])) {
      // Removed lines first, then added ones (the usual diff order).
      ops.push({ kind: '-', line: a[i], a: aStart + i, b: bStart + j });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j], a: aStart + i, b: bStart + j });
      j++;
    }
  }
  return ops;
}

/**
 * A unified diff of one file. `before` null = new file, `after` null = deleted.
 * At most `maxLines` diff lines; the rest is summarised.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3, maxLines = 300): string {
  if (before === after) return '';
  const header = `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ ${after === null ? '/dev/null' : `b/${path}`}`;
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;

  const ops: Op[] = [
    ...a.slice(0, start).map((line, i) => ({ kind: ' ' as const, line, a: i, b: i })),
    ...lcsOps(a.slice(start, endA), b.slice(start, endB), start, start),
    ...a.slice(endA).map((line, i) => ({ kind: ' ' as const, line, a: endA + i, b: endB + i })),
  ];

  // Group changes into hunks with `context` unchanged lines around them.
  const changed = ops.map((op, i) => (op.kind === ' ' ? -1 : i)).filter((i) => i >= 0);
  const out: string[] = [header];
  let lines = 0;
  let k = 0;
  while (k < changed.length) {
    const from = Math.max(0, changed[k] - context);
    let to = changed[k];
    while (k + 1 < changed.length && changed[k + 1] - to <= context * 2 + 1) to = changed[++k];
    to = Math.min(ops.length - 1, to + context);
    k++;
    const hunk = ops.slice(from, to + 1);
    const aLen = hunk.filter((o) => o.kind !== '+').length;
    const bLen = hunk.filter((o) => o.kind !== '-').length;
    out.push(`@@ -${hunk[0].a + 1},${aLen} +${hunk[0].b + 1},${bLen} @@`);
    for (const op of hunk) {
      if (lines >= maxLines) {
        const remaining = changed.length - changed.findIndex((c) => c >= ops.indexOf(op));
        out.push(`… (diff shortened: about ${remaining} more changed lines)`);
        return out.join('\n');
      }
      out.push(`${op.kind}${op.line}`);
      lines++;
    }
  }
  return out.join('\n');
}
