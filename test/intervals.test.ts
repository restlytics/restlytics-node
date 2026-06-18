import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unionLength, type Interval } from '../src/intervals.ts';

const I = (a: number, b: number): Interval => [BigInt(a), BigInt(b)];

test('empty is zero', () => {
  assert.equal(unionLength([]), 0n);
});

test('single interval', () => {
  assert.equal(unionLength([I(0, 10)]), 10n);
});

test('disjoint intervals sum', () => {
  // [0,10] + [20,25] = 10 + 5
  assert.equal(unionLength([I(0, 10), I(20, 25)]), 15n);
});

test('overlapping intervals are unioned, not summed', () => {
  // [0,10] and [5,15] overlap → union is [0,15] = 15 (NOT 10+10=20).
  assert.equal(unionLength([I(0, 10), I(5, 15)]), 15n);
});

test('fully contained interval', () => {
  // [2,4] inside [0,10] → just 10.
  assert.equal(unionLength([I(0, 10), I(2, 4)]), 10n);
});

test('adjacent touching intervals merge', () => {
  // [0,10] and [10,20] touch at 10 → continuous [0,20] = 20.
  assert.equal(unionLength([I(0, 10), I(10, 20)]), 20n);
});

test('unsorted input is handled', () => {
  assert.equal(unionLength([I(20, 25), I(0, 10)]), 15n);
});

test('multiple overlaps chained', () => {
  // [0,5],[3,8],[7,12] all chain → [0,12] = 12.
  assert.equal(unionLength([I(0, 5), I(3, 8), I(7, 12)]), 12n);
});

test('zero-length intervals contribute nothing', () => {
  // Cache markers are zero-length; they contribute nothing on their own.
  assert.equal(unionLength([I(5, 5), I(10, 10)]), 0n);
});

test('does not mutate the input array order', () => {
  const input: Interval[] = [I(20, 25), I(0, 10)];
  const before = input.map(([a, b]) => [a, b]);
  unionLength(input);
  assert.deepEqual(
    input.map(([a, b]) => [a, b]),
    before,
  );
});

test('handles 64-bit epoch-nanosecond magnitudes exactly', () => {
  // ~now in ns, well beyond Number.MAX_SAFE_INTEGER — must stay exact via bigint.
  const base = 1_700_000_000_000_000_000n;
  const a: Interval = [base, base + 1000n];
  const b: Interval = [base + 500n, base + 2000n];
  assert.equal(unionLength([a, b]), 2000n);
});
