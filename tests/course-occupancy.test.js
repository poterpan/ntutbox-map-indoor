import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeriods, pickTerm, resolveSlot, slotAt, buildOccupancy, summarizeBuildings, campusClock } from '../dev/course-occupancy.js';

// Real period table of term 115-1 (cdn.ntutbox.com/course/v1/terms/115-1/periods.json).
const PERIODS = parsePeriods({ periods: [
  ['1', '08:10', '09:00'], ['2', '09:10', '10:00'], ['3', '10:10', '11:00'], ['4', '11:10', '12:00'],
  ['N', '12:10', '13:00'], ['5', '13:10', '14:00'], ['6', '14:10', '15:00'], ['7', '15:10', '16:00'],
  ['8', '16:10', '17:00'], ['9', '17:10', '18:00'], ['A', '18:30', '19:20'], ['B', '19:20', '20:10'],
  ['C', '20:20', '21:10'], ['D', '21:10', '22:00'],
].map(([token, start_hm, end_hm], order) => ({ token, order, start_hm, end_hm, label: token })) });

// Taipei is UTC+8 all year. 2026-10-07 is a Wednesday (day 3).
const taipei = (date, hm) => new Date(`${date}T${hm}:00+08:00`);
const WED = '2026-10-07';

test('campusClock uses Asia/Taipei regardless of the host time zone', () => {
  assert.deepEqual(campusClock(new Date('2026-10-06T16:30:00Z')), { day: 3, minutes: 30 }); // 00:30 Wed in Taipei
});

test('resolveSlot: inside a period, between periods, after the last one', () => {
  const inside = resolveSlot(PERIODS, taipei(WED, '10:30'));
  assert.equal(inside.token, '3'); assert.equal(inside.day, 3); assert.equal(inside.active, true);
  assert.equal(inside.refMinutes, 10 * 60 + 30);
  assert.equal(inside.label, '週三 第3節');

  const gap = resolveSlot(PERIODS, taipei(WED, '11:05'));
  assert.equal(gap.token, '4'); assert.equal(gap.active, false); // gaps count as the next period

  const lunchGap = resolveSlot(PERIODS, taipei(WED, '12:05'));
  assert.equal(lunchGap.token, 'N');

  const late = resolveSlot(PERIODS, taipei(WED, '23:00'));
  assert.equal(late.token, '1'); assert.equal(late.day, 4); assert.equal(late.nextDay, true);
  assert.equal(late.refMinutes, 8 * 60 + 10);
  assert.equal(late.label, '週四 第1節（明 08:10）');

  const sat = resolveSlot(PERIODS, taipei('2026-10-10', '23:30'));
  assert.equal(sat.day, 0); // Saturday night rolls over to Sunday
});

test('pickTerm follows term_schedule.current', () => {
  const manifest = {
    term_schedule: { current: [{ term: '115-1', from: '2026-08-01T00:00:00+08:00' }, { term: '114-2', from: '2026-02-01T00:00:00+08:00' }] },
    terms: { '115-1': { rooms: {} }, '114-2': { rooms: {} } },
  };
  assert.equal(pickTerm(manifest, taipei(WED, '10:00')), '115-1');
  assert.equal(pickTerm(manifest, taipei('2026-03-01', '10:00')), '114-2');
  assert.equal(pickTerm(manifest, taipei('2025-01-01', '10:00')), null);
});

const room = (code, gis, slots, gis_match = 'rule') => ({
  code, raw: `三教${code}`, full_name: `第三教學大樓${code}室`, capacity: 50, gis_match,
  gis, slots: slots.map(([day, period]) => ({ day, period, offering_ids: ['x'] })),
});
const at = (b, f, cn) => [{ building_id: b, floor_id: f, class_number: cn }];
const TERM = { rooms: [
  room('busy', at('A3T', '5F', '501'), [[3, '3'], [3, '4'], [3, '6']]),
  room('soon', at('A3T', '5F', '502'), [[3, '4']]),
  room('later', at('A3T', '5F', '503'), [[3, '7']]),
  room('none', at('A3T', '5F', '504'), [[1, '3']]),
  room('flooronly', [{ building_id: 'A3T', floor_id: '1F', class_number: null }], [], 'floor_only'),
  room('bonly', [{ building_id: 'A3T', floor_id: null, class_number: null }], [], 'building_only'),
] };

test('buildOccupancy: busy / soon / free with times, and placement by gis_match', () => {
  const slot = resolveSlot(PERIODS, taipei(WED, '10:30')); // in period 3
  const { map, unplaced } = buildOccupancy(TERM, PERIODS, slot);

  const busy = map.get('A3T/5F/501');
  assert.equal(busy.status, 'busy'); assert.equal(busy.busyUntil, '12:00'); // 3+4 back to back
  assert.equal(busy.code, 'busy'); assert.equal(busy.capacity, 50);

  const soon = map.get('A3T/5F/502');
  assert.equal(soon.status, 'soon'); assert.equal(soon.freeUntil, '11:10'); // 40 min away

  const later = map.get('A3T/5F/503');
  assert.equal(later.status, 'free'); assert.equal(later.freeUntil, '15:10');

  const none = map.get('A3T/5F/504');
  assert.equal(none.status, 'free'); assert.equal(none.freeUntil, null); // no more classes today

  assert.ok(map.has('A3T/1F/?flooronly')); // known floor, no polygon
  assert.deepEqual(unplaced.map(r => r.code), ['bonly']);
});

test('slotAt judges from the period start (period picker)', () => {
  const slot = slotAt(PERIODS, 3, '5'); // Wed 13:10
  const { map } = buildOccupancy(TERM, PERIODS, slot);
  assert.equal(map.get('A3T/5F/501').status, 'soon'); // period 6 starts 14:10, 60 min after 13:10
  assert.equal(map.get('A3T/5F/503').freeUntil, '15:10');
});

test('summarizeBuildings counts located and floor-only rooms', () => {
  const { map } = buildOccupancy(TERM, PERIODS, resolveSlot(PERIODS, taipei(WED, '10:30')));
  const s = summarizeBuildings(map).A3T;
  assert.equal(s.total, 5); assert.equal(s.available, 4); assert.equal(s.best, '5F');
});
