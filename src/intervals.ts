/**
 * Interval-union (sweep-line) helper used to compute per-category "self time".
 *
 * Why union and not a plain sum: child spans can overlap (parallel HTTP calls,
 * async queries, nested instrumentation). Summing their durations double-counts
 * the wall-clock time. The union of intervals gives the real wall-clock time
 * actually spent inside that category, which is what the dashboard breakdown and
 * the ingestion service's self-time rollups expect (SPEC §1 self-time).
 *
 * We work in `bigint` nanoseconds so 64-bit epoch-ns values are exact (JS
 * `number` only holds 53 bits of integer precision).
 */

export type Interval = readonly [bigint, bigint];

/**
 * Total wall-clock length covered by the union of [start, end] intervals.
 */
export function unionLength(intervals: readonly Interval[]): bigint {
  if (intervals.length === 0) {
    return 0n;
  }

  // Sort by start so a single forward sweep can merge overlaps. Copy first so we
  // never mutate the caller's array.
  const sorted = [...intervals].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let total = 0n;
  let curStart = sorted[0]![0];
  let curEnd = sorted[0]![1];

  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    if (s > curEnd) {
      // Disjoint: bank the current run and start a new one.
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      // Overlapping: extend the current run.
      curEnd = e;
    }
  }

  total += curEnd - curStart;

  return total;
}
