// Course-site timetable -> indoor map occupancy.
//
// Input is the course site's public catalog (cdn.ntutbox.com/course/v1): terms/<t>/rooms.json and
// terms/<t>/periods.json. Each room lists the (day, period) slots that HAVE a scheduled class, plus its GIS
// location. "No slot" means "沒排課", not "guaranteed empty" — every user-facing string must say so.
//
// Pure functions only (no DOM, no fetch), so this can move into the course site unchanged.

export const TIME_ZONE = 'Asia/Taipei';
// A free room whose next class starts within this many minutes is "soon" (amber).
export const SOON_MINUTES = 60;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const toMin = hm => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};
const toHM = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Periods sorted by order, with minute offsets: [{ token, order, label, start, end, startHM, endHM }].
 * The array carries the table's time zone as `.timeZone` (periods.json `timezone`, default Asia/Taipei).
 */
export function parsePeriods(periodsJson) {
  const periods = (periodsJson?.periods || [])
    .map(p => ({ token: p.token, order: p.order, label: p.label ?? p.token, start: toMin(p.start_hm), end: toMin(p.end_hm), startHM: p.start_hm, endHM: p.end_hm }))
    .sort((a, b) => a.order - b.order);
  periods.timeZone = periodsJson?.timezone || TIME_ZONE;
  return periods;
}

/** Term in effect at `now` per manifest.term_schedule.current (last entry whose `from` has passed). */
export function pickTerm(manifest, now = new Date()) {
  const schedule = [...(manifest?.term_schedule?.current || [])].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  let term = null;
  for (const entry of schedule) if (Date.parse(entry.from) <= now.getTime()) term = entry.term;
  return term && manifest.terms?.[term]?.rooms ? term : null;
}

/** Day of week (0 = Sunday) and minutes since midnight in the campus time zone. */
export function campusClock(now = new Date(), timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  // Some engines report midnight as "24" even with h23.
  return { day, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/**
 * Which slot "now" refers to, with the course site's /rooms semantics: inside a period -> that period;
 * between periods -> the next one; after the last period -> the first period of the next day.
 * Returns { day, token, period, active, nextDay, refMinutes, label }. refMinutes is the moment statuses
 * are judged from (now, or the period start when looking ahead to tomorrow).
 */
export function resolveSlot(periods, now = new Date()) {
  const { day, minutes } = campusClock(now, periods.timeZone || TIME_ZONE);
  const inside = periods.find(p => p.start <= minutes && minutes < p.end);
  if (inside) return slotInfo(periods, day, inside, { active: true, refMinutes: minutes });
  const next = periods.find(p => p.start > minutes);
  if (next) return slotInfo(periods, day, next, { active: false, refMinutes: minutes });
  return slotInfo(periods, (day + 1) % 7, periods[0], { active: false, nextDay: true, refMinutes: periods[0].start });
}

/** A specific slot picked by the user (period picker). Statuses are judged from the period start. */
export function slotAt(periods, day, token) {
  const period = periods.find(p => p.token === token) || periods[0];
  return slotInfo(periods, day, period, { active: false, refMinutes: period.start });
}

function slotInfo(periods, day, period, { active, nextDay = false, refMinutes }) {
  const label = `週${WEEKDAYS[day]} 第${period.label}節`;
  return { day, token: period.token, period, active, nextDay, refMinutes, label: nextDay ? `${label}（明 ${period.startHM}）` : label };
}

/**
 * Occupancy for one slot. Returns { map, unplaced } where
 *   map: Map<key, record>, key = "B/F/classNumber" for rooms GIS can locate, "B/F/?<code>" for rooms
 *        known only to the floor (gis_match floor_only);
 *   unplaced: rooms with no floor (building_only / none) — list only, never on the map.
 * record = { status: 'free'|'soon'|'busy', code, raw, name, capacity, freeUntil, busyUntil, gisMatch, slot }
 *   freeUntil: "HH:MM" start of the next class today, or null = no more classes today (status free/soon)
 *   busyUntil: "HH:MM" end of the current run of back-to-back classes (status busy)
 */
export function buildOccupancy(termRooms, periods, slot, { soonMinutes = SOON_MINUTES } = {}) {
  const orderOf = new Map(periods.map(p => [p.token, p]));
  const map = new Map();
  const unplaced = [];
  for (const room of termRooms?.rooms || []) {
    const today = new Map();
    for (const s of room.slots || []) if (s.day === slot.day && orderOf.has(s.period)) today.set(s.period, s);
    const record = {
      code: room.code, raw: room.raw, name: room.full_name, capacity: room.capacity ?? null,
      gisMatch: room.gis_match, slot: slot.token, ...statusAt(today, periods, slot, soonMinutes),
    };
    let placed = false;
    for (const g of room.gis || []) {
      if (!g.building_id || !g.floor_id) continue;
      if (g.class_number && (room.gis_match === 'rule' || room.gis_match === 'override')) {
        map.set(`${g.building_id}/${g.floor_id}/${g.class_number}`, record);
        placed = true;
      } else if (room.gis_match === 'floor_only') {
        map.set(`${g.building_id}/${g.floor_id}/?${room.code}`, record);
        placed = true;
      }
    }
    if (!placed) unplaced.push(record);
  }
  return { map, unplaced };
}

function statusAt(today, periods, slot, soonMinutes) {
  const idx = periods.findIndex(p => p.token === slot.token);
  if (today.has(slot.token)) {
    // Busy: until the end of the run of consecutive scheduled periods.
    let last = idx;
    while (last + 1 < periods.length && today.has(periods[last + 1].token)) last++;
    return { status: 'busy', freeUntil: null, busyUntil: periods[last].endHM };
  }
  const next = periods.slice(idx + 1).find(p => today.has(p.token));
  if (!next) return { status: 'free', freeUntil: null, busyUntil: null };
  return { status: next.start - slot.refMinutes <= soonMinutes ? 'soon' : 'free', freeUntil: next.startHM, busyUntil: null };
}

/** Per-building totals for pickers / cards: { [buildingId]: { total, available, best: floorId|null } }. */
export function summarizeBuildings(map) {
  // Keys come from the data (building ids), so use prototype-less objects: an id such as "__proto__"
  // must not reach Object.prototype.
  const out = Object.create(null);
  const perFloor = Object.create(null);
  for (const [key, rec] of map) {
    const [b, f] = key.split('/');
    const s = (out[b] ??= { total: 0, available: 0, best: null });
    s.total++;
    if (rec.status === 'free' || rec.status === 'soon') {
      s.available++;
      const n = (perFloor[`${b}/${f}`] = (perFloor[`${b}/${f}`] || 0) + 1);
      if (!s.best || n > (perFloor[`${b}/${s.best}`] || 0)) s.best = f;
    }
  }
  return out;
}
