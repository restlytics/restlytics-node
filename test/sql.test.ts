import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, operationOf } from '../src/sql.ts';

test('strips numeric literals', () => {
  assert.equal(
    normalize('SELECT * FROM users WHERE id = 1'),
    'select * from users where id = ?',
  );
});

test('strips string literals', () => {
  assert.equal(
    normalize("SELECT * FROM users WHERE email = 'alice@example.com'"),
    'select * from users where email = ?',
  );
});

test('two different literals produce the same template (N+1 fingerprint)', () => {
  const a = normalize('SELECT * FROM users WHERE id = 1');
  const b = normalize('SELECT * FROM users WHERE id = 2');
  assert.equal(a, b);
});

test('collapses IN lists to a single placeholder', () => {
  assert.equal(
    normalize('SELECT * FROM users WHERE id IN (1, 2, 3, 4, 5)'),
    'select * from users where id in (?)',
  );

  // Varying-length lists must collapse to the SAME template.
  const short = normalize('SELECT * FROM users WHERE id IN (1, 2)');
  const long = normalize('SELECT * FROM users WHERE id IN (1, 2, 3, 4)');
  assert.equal(short, long);
});

test('collapses existing placeholders in IN lists', () => {
  assert.equal(
    normalize('SELECT * FROM t WHERE id IN (?, ?, ?)'),
    'select * from t where id in (?)',
  );
});

test('squashes whitespace and newlines', () => {
  assert.equal(
    normalize('SELECT   id\n  FROM users\n\tWHERE active   =   1'),
    'select id from users where active = ?',
  );
});

test('collapses multi-row VALUES tuples', () => {
  assert.equal(
    normalize('INSERT INTO t (a, b) VALUES (1, 2), (3, 4), (5, 6)'),
    'insert into t (a, b) values (?)',
  );
});

test('handles named and positional bindings', () => {
  assert.equal(
    normalize('SELECT * FROM users WHERE id = :id AND name = $1'),
    'select * from users where id = ? and name = ?',
  );
});

test('does not mangle identifiers with trailing digits', () => {
  const out = normalize('SELECT column2 FROM table1 WHERE column2 = 5');
  assert.ok(out.includes('column2'), `expected column2 to survive, got: ${out}`);
  assert.ok(out.includes('= ?'), `expected a normalized literal, got: ${out}`);
});

test('strips decimal and hex literals', () => {
  assert.equal(
    normalize('SELECT * FROM t WHERE price > 19.99 AND flag = 0xFF'),
    'select * from t where price > ? and flag = ?',
  );
});

test('operationOf extracts the leading keyword, lowercased', () => {
  assert.equal(operationOf('SELECT * FROM t'), 'select');
  assert.equal(operationOf('  insert into t values (1)'), 'insert');
  assert.equal(operationOf(''), undefined);
});
