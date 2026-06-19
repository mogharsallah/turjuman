// ---- translation-memory helpers ---------------------------------------------

export function normalizeTm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Sørensen–Dice similarity over character bigrams (0..1). */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  let overlap = 0;
  for (const [g, count] of ba) {
    const other = bb.get(g);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}
