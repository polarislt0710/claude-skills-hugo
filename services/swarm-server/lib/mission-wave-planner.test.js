// Run: node lib/mission-wave-planner.test.js
'use strict';
const assert = require('assert');
const { planWaves } = require('./mission-wave-planner');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
const ids = (wave) => wave.map((s) => s.id);

console.log('mission-wave-planner');

test('empty input → empty waves', () => {
  const r = planWaves([]);
  assert.deepStrictEqual(r.waves, []);
  assert.deepStrictEqual(r.order, []);
});

test('linear chain p1→p2→p3 → 3 single waves', () => {
  const r = planWaves([
    { id: 'p1', dependencies: [] },
    { id: 'p2', dependencies: ['p1'] },
    { id: 'p3', dependencies: ['p2'] },
  ], { maxConcurrency: 3 });
  assert.strictEqual(r.waves.length, 3);
  assert.deepStrictEqual(r.waves.map(ids), [['p1'], ['p2'], ['p3']]);
  assert.deepStrictEqual(r.order, ['p1', 'p2', 'p3']);
});

test('all independent, cap 3 → single wave of 3', () => {
  const r = planWaves([
    { id: 'p1' }, { id: 'p2' }, { id: 'p3' },
  ], { maxConcurrency: 3 });
  assert.strictEqual(r.waves.length, 1);
  assert.deepStrictEqual(ids(r.waves[0]), ['p1', 'p2', 'p3']);
});

test('diamond p1; p2,p3←p1; p4←p2,p3', () => {
  const r = planWaves([
    { id: 'p1', dependencies: [] },
    { id: 'p2', dependencies: ['p1'] },
    { id: 'p3', dependencies: ['p1'] },
    { id: 'p4', dependencies: ['p2', 'p3'] },
  ], { maxConcurrency: 3 });
  assert.deepStrictEqual(r.waves.map(ids), [['p1'], ['p2', 'p3'], ['p4']]);
});

test('cycle p1↔p2 → throws', () => {
  assert.throws(() => planWaves([
    { id: 'p1', dependencies: ['p2'] },
    { id: 'p2', dependencies: ['p1'] },
  ]), /cycle|unsatisfiable/i);
});

test('file collision splits independent phases into 2 waves', () => {
  const r = planWaves([
    { id: 'p1', estFiles: ['src/app.js'] },
    { id: 'p2', estFiles: ['src/app.js'] }, // collides with p1
  ], { maxConcurrency: 3 });
  assert.strictEqual(r.waves.length, 2);
  assert.deepStrictEqual(r.waves.map(ids), [['p1'], ['p2']]);
});

test('no collision when estFiles disjoint', () => {
  const r = planWaves([
    { id: 'p1', estFiles: ['a.js'] },
    { id: 'p2', estFiles: ['b.js'] },
  ], { maxConcurrency: 3 });
  assert.strictEqual(r.waves.length, 1);
});

test('cap truncates: 5 independent, cap 2 → waves 2,2,1', () => {
  const r = planWaves(
    ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({ id })),
    { maxConcurrency: 2 },
  );
  assert.deepStrictEqual(r.waves.map((w) => w.length), [2, 2, 1]);
});

test('dangling + self dep produce warnings but still plan', () => {
  const r = planWaves([
    { id: 'p1', dependencies: ['p1', 'ghost'] },
    { id: 'p2', dependencies: ['p1'] },
  ]);
  assert.deepStrictEqual(r.waves.map(ids), [['p1'], ['p2']]);
  assert.ok(r.warnings.some((w) => /self-dependency/.test(w)));
  assert.ok(r.warnings.some((w) => /not found/.test(w)));
});

test('duplicate ids repaired', () => {
  const r = planWaves([{ id: 'p1' }, { id: 'p1' }], { maxConcurrency: 3 });
  assert.strictEqual(r.order.length, 2);
  assert.ok(r.warnings.some((w) => /duplicate/.test(w)));
});

test('missing id falls back to positional', () => {
  const r = planWaves([{}, {}], { maxConcurrency: 3 });
  assert.deepStrictEqual(r.order.sort(), ['p1', 'p2']);
});

console.log(`\n${passed} passed`);
