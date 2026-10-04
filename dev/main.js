// Dev page (not part of the package): plays the role the course site's React page will play. It owns the page chrome (titles,
// legend, period + building pickers, room sheet, campus card), computes occupancy from the course
// timetable and pushes it into the engine through its public API only.
import { createIndoorMap, campusCdnSource } from '../src/index.js';
import '../src/engine/indoor-map.css';
import { parsePeriods, pickTerm, resolveSlot, slotAt, buildOccupancy, summarizeBuildings } from './course-occupancy.js';
import fixtureRooms from './fixtures/rooms-115-1.json';
import fixturePeriods from './fixtures/periods-115-1.json';

const $ = sel => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const scene = $('#scene');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const COURSE_SITE = 'https://course.ntutbox.com';

let view = null;      // last onViewChange payload
let course = null;    // { rooms, periods, term, source: 'live' | 'fixture' }
let pinned = null;    // { day, token } picked by the user, or null = follow the clock
let slot = null;      // slot the occupancy was computed for
let occ = { map: new Map(), unplaced: [] };
let summary = {};

// ---------------------------------------------------------------------------------------------
// Course data: live CDN through the Vite proxy, else the bundled 115-1 snapshot.
// ---------------------------------------------------------------------------------------------
async function loadCourse() {
  try {
    const manifest = await fetch('/course-data/manifest.json').then(r => (r.ok ? r.json() : Promise.reject(r.status)));
    const term = pickTerm(manifest);
    if (!term) throw new Error('no current term');
    const [rooms, periods] = await Promise.all([
      fetch(`/course-data/${manifest.terms[term].rooms.url}`).then(r => r.json()),
      fetch(`/course-data/terms/${term}/periods.json`).then(r => r.json()),
    ]);
    return { rooms, periods: parsePeriods(periods), term, source: 'live' };
  } catch (err) {
    console.warn('[dev] live course data unavailable, using bundled snapshot', err);
    return { rooms: fixtureRooms, periods: parsePeriods(fixturePeriods), term: fixtureRooms.term_key, source: 'fixture' };
  }
}

function computeOccupancy() {
  slot = pinned ? slotAt(course.periods, pinned.day, pinned.token) : resolveSlot(course.periods);
  occ = buildOccupancy(course.rooms, course.periods, slot);
  summary = summarizeBuildings(occ.map);
}

function recompute() {
  if (!course) return;
  computeOccupancy();
  map.setOccupancy(occ.map);
  $('#timeValue').textContent = `${slot.label}${pinned ? '' : (slot.active ? '' : ' · 下一節')}`;
  $('#dataSource').textContent = course.source === 'live' ? `${course.term} 課表` : `${course.term} 課表快照（離線）`;
  renderChrome();
}

// ---------------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------------
// Host overlays that cover the canvas; the engine frames the map inside what is left.
function getInsets() {
  const r = scene.getBoundingClientRect();
  const visible = el => el && el.offsetParent !== null && getComputedStyle(el).display !== 'none' && !el.classList.contains('hidden');
  let top = 16, bottom = 16;
  for (const el of [$('.view-switch'), $('.floor-title')]) if (visible(el)) top = Math.max(top, el.getBoundingClientRect().bottom - r.top + 10);
  if (visible($('.legend'))) bottom = Math.max(bottom, r.bottom - $('.legend').getBoundingClientRect().top + 10);
  return { top, right: 16, bottom, left: 16 };
}

function showToast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function renderChrome() {
  if (!view) return;
  const title = $('#floorTitle'), sub = $('#floorSummary'), tip = $('#tip');
  if (view.view === 'campus') {
    title.textContent = '北科校園';
    sub.textContent = '點大樓看各棟依課表沒排課的教室';
    tip.textContent = '拖曳平移 · 雙指縮放旋轉 · 點大樓選取，放大到填滿即進入';
  } else if (view.view === 'overview') {
    const s = summary[view.building];
    title.textContent = `${view.buildingShort} · 全樓層`;
    sub.textContent = s ? `依課表 ${s.available}/${s.total} 間這節沒排課 · 點樓層進入` : '點任一樓層進入';
    tip.textContent = '點樓層或放大進入 · 縮小回到校園';
  } else {
    const s = view.floors.find(f => f.id === view.floor) || {};
    title.textContent = `${view.buildingShort} ${view.floor}`;
    sub.textContent = s.total
      ? `依課表 ${s.available}/${s.total} 間這節沒排課${s.unlocated ? ` · 另 ${s.unlocated} 間無法在圖上定位` : ''}`
      : '此樓層沒有排課教室';
    tip.textContent = '拖曳平移 · 雙指縮放旋轉 · 縮小到底或點空白處回到全樓層';
  }
  $('.view-switch [data-view=building]').textContent = view.buildingShort;
  document.querySelectorAll('.view-switch button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === (view.view === 'campus' ? 'campus' : 'building'));
  });
  $('.legend').style.display = view.view === 'campus' ? 'none' : 'flex';
  $('#buildingName').textContent = view.buildingName;
  $('#footerBuilding').textContent = `真實 GIS 幾何 · ${view.building} ${view.buildingName}`;
}

const STATUS_BADGE = { free: '這節沒排課', soon: '快有課', busy: '這節有課', unknown: '無課表資料' };
function statusLine(rec) {
  if (!rec) return '排課系統沒有這間的課表';
  if (rec.status === 'busy') return rec.busyUntil ? `有課到 ${rec.busyUntil}` : '這節有課';
  if (rec.status === 'soon') return `${rec.freeUntil} 有課`;
  return rec.freeUntil ? `沒排課到 ${rec.freeUntil}` : '今天之後沒排課';
}

function showRoomSheet(room) {
  const sheet = $('#roomSheet');
  if (!room) { sheet.classList.add('hidden'); return; }
  const rec = room.occupancy;
  const kind = rec ? room.status : 'unknown';
  $('#sheetFloor').textContent = `${room.buildingName} ${room.floorId}`;
  $('#sheetRoom').textContent = rec?.raw?.replace(/\(e\)$/, '') || room.classNumber;
  const badge = $('#sheetBadge');
  badge.className = `status-badge ${kind}`;
  badge.textContent = STATUS_BADGE[kind];
  $('#sheetStatus').textContent = statusLine(rec);
  $('#sheetCapacity').textContent = rec?.capacity ? `${rec.capacity} 人` : '—';
  $('#sheetSlot').textContent = slot ? `依課表 · ${slot.label}` : '';
  const link = $('#timetableLink');
  link.style.display = rec?.code ? '' : 'none';
  if (rec?.code) link.href = `${COURSE_SITE}/rooms/${rec.code}/`;
  sheet.classList.remove('hidden');
}

function showCampusCard(focus) {
  const card = $('#campusCard');
  card.classList.toggle('hidden', !focus);
  scene.classList.toggle('card-open', !!focus);
  $('#tip').style.visibility = focus ? 'hidden' : '';
  if (!focus) return;
  const s = summary[focus.buildingId];
  card.dataset.building = focus.buildingId;
  card.querySelector('b').textContent = focus.name;
  card.querySelector('small').textContent = s
    ? `依課表 ${s.available}/${s.total} 間這節沒排課${s.best ? ` · 最多在 ${s.best}` : ''}`
    : '沒有排課資料';
  card.querySelector('.cc-hint').textContent = focus.via === 'zoom' ? '繼續放大或點此進入' : '再點一次或點此進入';
}

// ---------------------------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------------------------
// Campus data: the published ntutbox-campus data through the /campus-data proxy (vite.config.js).
// Every building with indoor GIS; floors load on demand. The timetable is loaded first and passed in, so the
// map is built once with the right rooms (pushing it later would rebuild the building and reset the first zoom).
async function loadCampus() {
  const source = campusCdnSource('/campus-data');
  const { buildings, current } = await source.load();
  console.info(`[dev] campus data revision ${current.revision}, updateSequence ${current.update_sequence}`);
  return { source, buildings };
}
const [campus, courseData] = await Promise.all([loadCampus(), loadCourse()]);
const BUILDINGS = campus.buildings;
course = courseData;
computeOccupancy();
const map = createIndoorMap(scene, {
  source: campus.source,
  buildings: BUILDINGS,
  occupancy: occ.map,
  initialBuilding: params.get('building') || 'A3T',
  initialView: params.get('view') || 'overview',
  debug: params.has('debug'),
  getInsets,
  onViewChange: info => { view = info; renderChrome(); },
  onRoomSelect: showRoomSheet,
  onCampusFocus: showCampusCard,
  onNotice: showToast,
  onLoading: ({ building }) => showToast(`載入${BUILDINGS[building]?.short || building}…`),
  onError: err => {
    console.warn('[dev] map error', err);
    if (err.type === 'load-failed' || err.type === 'building-load-failed') showToast('地圖暫時無法載入');
  },
});
window.__map = map; // for manual poking in devtools

recompute(); // fills the chrome (time chip, data source) from the occupancy already given to the map
if (course.source === 'fixture') showToast('連不到排課站，使用離線課表快照');
// Follow the clock like the course site's useNow (re-evaluate every minute).
setInterval(() => { if (!pinned) recompute(); }, 60_000);

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------
document.querySelectorAll('.view-switch button').forEach(btn => btn.addEventListener('click', () => {
  map.setView({ view: btn.dataset.view === 'campus' ? 'campus' : 'overview' });
}));
$('#resetView').addEventListener('click', () => map.resetView());
$('#closeSheet').addEventListener('click', () => map.clearSelection());
$('#campusCard').addEventListener('click', e => map.enterBuilding(e.currentTarget.dataset.building));

function closeMenus() { document.querySelectorAll('.building-menu').forEach(m => m.classList.add('hidden')); }
function menuItem(menu, label, detail, active, onPick) {
  const item = document.createElement('button');
  item.className = 'menu-item' + (active ? ' active' : '');
  item.append(Object.assign(document.createElement('span'), { textContent: label }));
  if (detail) item.append(Object.assign(document.createElement('small'), { textContent: detail }));
  item.addEventListener('click', e => { e.stopPropagation(); closeMenus(); onPick(); });
  menu.appendChild(item);
}

// Building picker: sorted by how many rooms are free per the timetable right now.
$('#buildingFilter').addEventListener('click', e => {
  e.stopPropagation();
  const menu = $('#buildingMenu');
  if (!menu.classList.contains('hidden')) { closeMenus(); return; }
  closeMenus();
  menu.replaceChildren();
  // Most free rooms first; buildings without timetabled rooms (offices, dorms, library) last.
  const ids = Object.keys(BUILDINGS).sort((a, b) =>
    (summary[b]?.available ?? -1) - (summary[a]?.available ?? -1) || BUILDINGS[a].name.localeCompare(BUILDINGS[b].name, 'zh-Hant'));
  for (const id of ids) {
    const s = summary[id];
    menuItem(menu, BUILDINGS[id].name, s ? `${s.available}/${s.total} 沒排課` : '無排課教室', id === view?.building,
      () => { if (id !== view?.building) map.setView({ building: id, view: view?.view === 'campus' ? 'campus' : 'overview' }); });
  }
  menu.classList.remove('hidden');
});

// Period picker: "現在" or any weekday + period.
$('#timeFilter').addEventListener('click', e => {
  e.stopPropagation();
  const menu = $('#timeMenu');
  if (!menu.classList.contains('hidden')) { closeMenus(); return; }
  closeMenus();
  if (!course) return;
  menu.replaceChildren();
  menuItem(menu, '現在', resolveSlot(course.periods).label, !pinned, () => { pinned = null; recompute(); });
  const day = pinned?.day ?? slot.day;
  const days = document.createElement('div');
  days.className = 'day-row';
  for (let d = 1; d <= 6; d++) {
    const b = Object.assign(document.createElement('button'), { textContent: WEEKDAYS[d], className: d === day ? 'active' : '' });
    b.addEventListener('click', ev => { ev.stopPropagation(); pinned = { day: d, token: pinned?.token ?? slot.token }; recompute(); $('#timeFilter').click(); $('#timeFilter').click(); });
    days.appendChild(b);
  }
  menu.appendChild(days);
  for (const p of course.periods) {
    menuItem(menu, `第${p.label}節`, `${p.startHM}–${p.endHM}`, pinned && pinned.day === day && pinned.token === p.token,
      () => { pinned = { day, token: p.token }; recompute(); });
  }
  menu.classList.remove('hidden');
});
document.addEventListener('click', closeMenus);
scene.addEventListener('pointerdown', closeMenus);
