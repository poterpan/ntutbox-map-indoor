import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorRank } from '../src/engine/indoor-map.js';

const sorted = ids => ids.slice().sort((a, b) => floorRank(a) - floorRank(b));

test('floorRank orders basements, mezzanines, floors and roofs physically', () => {
  // CB lists B1M last in building-index; A6T has 1M; some buildings use RF; AM has R1–R3.
  assert.deepEqual(sorted(['1F', '2F', 'B1M', 'B1', 'B2']), ['B2', 'B1', 'B1M', '1F', '2F']);
  assert.deepEqual(sorted(['2F', '1M', '1F']), ['1F', '1M', '2F']);
  assert.deepEqual(sorted(['RF', '14F', '13F', 'R1', 'R2']), ['13F', '14F', 'RF', 'R1', 'R2']);
  assert.ok(floorRank('14F') < floorRank('RF'));
  assert.ok(floorRank('PH') > floorRank('R3'));
});
