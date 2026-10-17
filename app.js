'use strict';
// 수영!일해야지! — 1단계: 할일 카드 보드 + 타임라인 (데이터는 이 폰의 localStorage에만 저장)
const KEY = 'suyoung_cards_v1';
const KEY_PROJ = 'suyoung_projects_v1';   // 프로젝트 이름 -> 색(#RRGGBB)
const KEY_RANGE = 'suyoung_range_v1';     // 날짜 -> { s: 시작 시(0~24), e: 끝 시(0~24) }, 하루 단위로 늘린 범위
const DEF_S = 7, DEF_E = 22;              // 타임라인 기본 범위: 오전 7시 ~ 오후 10시
const COLOR_DEFAULT = { work: '#2f6db5', personal: '#f2b705' }; // 기본색: 회사 일은 파랑, 개인 일은 노랑
const OLD_PERSONAL = '#c0692f';                                  // 예전 기본색(주황). 소장이 고른 색이 아니라 옛 기본값이므로 새 기본색(노랑)으로 바꿔 읽는다
const PX = 64, MINH = 46, GAP = 4;        // 1시간 높이(px), 말풍선 최소 높이, 말풍선 사이 간격
const KEY_G = 'suyoung_google_v1';        // { clientId } (클라이언트 ID는 비밀이 아니다. 토큰은 저장하지 않는다)
const KEY_GSIDE = 'suyoung_gside_v1';     // 구글 일정 id -> 'L'|'R' (소장이 옮긴 좌우)
const KEY_ALARM = 'suyoung_alarm_v1';     // { mode: both|sound|vibrate|off, end: 완료 시각 알림, gcal: 구글 캘린더 시작 알림 }
const KEY_FIRED = 'suyoung_fired_v1';     // 이미 울린 알림(같은 알림이 다시 울리지 않게)
const KEY_GDEL = 'suyoung_gdel_v1';       // 카드를 지웠는데 아직 구글에서 못 지운 일정 id 목록
const KEY_TICK ='suyoung_tick_v1';       // 마지막으로 알림을 확인한 시각
const GSCOPE ='https://www.googleapis.com/auth/calendar.events';
const GAPI = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GCOLOR = { 1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e', 7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000' };

let cards, projects, ranges, gset, gside, aset; // 아래 도우미 함수들이 정의된 뒤에 읽어 온다
let gtoken = null, gexp = 0, gcache = {}, gbusy = false, editingG = null;
let gweek = {}, gwbusy = false; // 캘린더 탭용: 월요일 날짜 -> { at, events }
let editingId = null;
let justDragged = false;
let shownDate = todayStr();

const $ = (id) => document.getElementById(id);
function load(k, def) {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    if (Array.isArray(def)) return Array.isArray(v) ? v : def;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : def;
  } catch (e) { return def; }
}
function saveKey(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
}
function save() { if (!saveKey(KEY, cards)) alert('저장하지 못했습니다. 저장 공간을 확인하세요.'); }
function saveAll() { save(); saveKey(KEY_PROJ, projects); saveKey(KEY_RANGE, ranges); }

const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isColor = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
// 예전 카드(time 하나)도 읽는다: time -> start
function norm(c) {
  if (!c || typeof c.id !== 'string' || typeof c.title !== 'string' || !isDate(c.date)) return null;
  const start = isTime(c.start) ? c.start : (isTime(c.time) ? c.time : '');
  const end = start && isTime(c.end) && c.end > start ? c.end : '';
  return {
    id: c.id, title: c.title.slice(0, 100), memo: String(c.memo || '').slice(0, 500),
    start, end, time: start, done: !!c.done, source: String(c.source || '내 카드'),
    kind: c.kind === 'personal' ? 'personal' : 'work', side: c.side === 'L' || c.side === 'R' ? c.side : '',
    project: String(c.project || '').slice(0, 40), color: isColor(c.color) && c.color.toLowerCase() !== OLD_PERSONAL ? c.color : '',
    gid: typeof c.gid === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(c.gid) ? c.gid : '', gdirty: !!c.gdirty, alarmS: c.alarmS !== false, alarmE: c.alarmE !== false,
    date: c.date, created: String(c.created || '')
  };
}

cards = load(KEY, []).map(norm).filter(Boolean);
projects = load(KEY_PROJ, {});
ranges = load(KEY_RANGE, {});
gset = load(KEY_G, {});
gside = load(KEY_GSIDE, {});

function todayStr() { return dstr(new Date()); }
function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const timeText = (c) => c.start ? (c.end ? c.start + '~' + c.end : c.start + '~') : '';
// 프로젝트 색은 그 앱이 직접 저장한 이름에서만 찾고(__proto__ 같은 이름 방어), 색 형식이 아니면 기본색
function colorOf(c) {
  const pc = c.project && Object.prototype.hasOwnProperty.call(projects, c.project) ? projects[c.project] : '';
  const col = c.color || pc;
  return isColor(col) ? col : COLOR_DEFAULT[c.kind];
}
function textOn(hex) { // 배경색에 맞춰 글자색
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#222' : '#fff';
}

// ---------- 구글 캘린더 (OAuth 클라이언트 ID가 있을 때만 동작. 없으면 앱은 이전과 똑같이 단독으로 돈다) ----------
const pad2 = (n) => String(n).padStart(2, '0');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const gready = () => !!gtoken && Date.now() < gexp - 30000;
function gmsg(t) { $('g-status').textContent = t || ''; $('tl-g').textContent = t || ''; }
function updateGUi() {
  const has = !!(gset.clientId || '').trim();
  $('g-client').value = gset.clientId || '';
  $('g-sync').hidden = !has; $('g-off').hidden = !has;
  $('tl-gconnect').hidden = !(has && !gready());
  if (!has) $('g-state').textContent = '구글 캘린더: 연결 안 함 (클라이언트 ID를 넣으면 연결할 수 있습니다)';
  else $('g-state').textContent = gready() ? '구글 캘린더: 연결됨' : '구글 캘린더: 연결이 필요합니다 (아래 "구글 연결" 버튼)';
}
function loadGis(ok, fail) {
  if (window.google && google.accounts && google.accounts.oauth2) return ok();
  const old = document.getElementById('gis-script');
  if (old) { old.addEventListener('load', ok); old.addEventListener('error', () => fail('구글 로그인 스크립트를 불러오지 못했습니다(인터넷을 확인하세요).')); return; }
  const s = document.createElement('script');
  s.id = 'gis-script'; s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = ok; s.onerror = () => { s.remove(); fail('구글 로그인 스크립트를 불러오지 못했습니다(인터넷을 확인하세요).'); };
  document.head.appendChild(s);
}
function gToken() { // 구글 로그인 창을 띄워 토큰을 받는다(버튼을 누른 직후에만 불러야 창이 열린다)
  return new Promise((resolve, reject) => {
    const id = (gset.clientId || '').trim();
    if (!id) return reject(new Error('클라이언트 ID가 없습니다. 설정에서 먼저 입력하세요.'));
    loadGis(() => {
      try {
        const tc = google.accounts.oauth2.initTokenClient({
          client_id: id, scope: GSCOPE,
          callback: (r) => {
            if (!r || r.error || !r.access_token) return reject(new Error('구글 연결에 실패했습니다' + (r && r.error ? ' (' + r.error + ')' : '') + '.'));
            gtoken = r.access_token; gexp = Date.now() + Number(r.expires_in || 3600) * 1000; resolve(gtoken);
          },
          error_callback: (e) => reject(new Error('구글 연결이 취소되었거나 막혔습니다' + (e && e.type ? ' (' + e.type + ')' : '') + '.'))
        });
        tc.requestAccessToken({ prompt: '' });
      } catch (e) { reject(e); }
    }, (m) => reject(new Error(m)));
  });
}
async function gfetch(url, method, body) {
  const noauth = () => { const e = new Error('구글에 다시 연결해야 합니다(타임라인 위 또는 설정의 연결 버튼).'); e.code = 'noauth'; return e; };
  if (!gready()) throw noauth();
  let r;
  try {
    r = await fetch(url, { method: method || 'GET', headers: Object.assign({ Authorization: 'Bearer ' + gtoken }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  } catch (e) { const er = new Error('구글에 연결하지 못했습니다(인터넷을 확인하세요).'); er.code = 'net'; throw er; }
  if (r.status === 401) { gtoken = null; updateGUi(); throw noauth(); }
  if (r.status === 204) return null;
  let j = null; try { j = await r.json(); } catch (e) { /* 본문 없음 */ }
  if (!r.ok) { const er = new Error('구글 오류 ' + r.status + (j && j.error && j.error.message ? ': ' + j.error.message : '')); er.code = r.status; throw er; }
  return j;
}
const dayBounds = (date) => { const [y, m, d] = date.split('-').map(Number); return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()]; };
const clock = (t, day1) => t >= day1 ? '24:00' : pad2(new Date(t).getHours()) + ':' + pad2(new Date(t).getMinutes());
async function fetchDay(date) {
  const [d0, d1] = dayBounds(date);
  const q = '?timeMin=' + encodeURIComponent(new Date(d0).toISOString()) + '&timeMax=' + encodeURIComponent(new Date(d1).toISOString()) + '&singleEvents=true&orderBy=startTime&maxResults=100';
  const j = await gfetch(GAPI + q);
  gcache[date] = { at: Date.now(), events: ((j && j.items) || []).filter(e => e && typeof e.id === 'string' && e.status !== 'cancelled') };
}
// 구글 일정 -> 타임라인 말풍선 한 개 (시간 있는 일정만. 종일 일정은 위에 따로 보인다)
function gItem(ev, date) {
  if (!ev.start || !ev.start.dateTime) return null;
  const [d0, d1] = dayBounds(date);
  let s = new Date(ev.start.dateTime).getTime(), e = new Date((ev.end && ev.end.dateTime) || ev.start.dateTime).getTime();
  const clipped = s < d0 || e > d1;
  s = Math.max(s, d0); e = Math.min(e, d1);
  if (!(e > s)) e = Math.min(s + 30 * 60000, d1);
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  if (priv.suyoungCardId && cards.some(c => c.id === priv.suyoungCardId)) return null; // 앱 카드로 이미 보인다
  return { src: 'g', ev, clipped, key: ev.id, title: ev.summary || '(제목 없음)', memo: ev.description || '', start: clock(s, d1), end: clock(e, d1),
    kind: 'personal', side: own(gside, ev.id) && (gside[ev.id] === 'L' || gside[ev.id] === 'R') ? gside[ev.id] : '',
    color: own(GCOLOR, String(ev.colorId)) ? GCOLOR[ev.colorId] : '#5f6b7a', done: false, project: '구글 캘린더' };
}
function evBody(c) { // 카드 -> 구글 일정
  const [y, m, d] = c.date.split('-').map(Number);
  const s = new Date(y, m - 1, d, Number(c.start.slice(0, 2)), Number(c.start.slice(3)));
  const e = c.end ? new Date(y, m - 1, d, Number(c.end.slice(0, 2)), Number(c.end.slice(3))) : new Date(s.getTime() + 30 * 60000);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { summary: c.title, description: c.memo || '', start: { dateTime: s.toISOString(), timeZone: tz }, end: { dateTime: e.toISOString(), timeZone: tz },
    // 시작 1분 전에 구글 캘린더 앱이 울리게 한다(설정에서 끌 수 있다). 완료 시각 알림은 캘린더로 못 보내서 앱 안에서만 울린다.
    reminders: aset.gcal && c.alarmS !== false ? { useDefault: false, overrides: [{ method: 'popup', minutes: 1 }] } : { useDefault: true },
    extendedProperties: { private: { suyoungCardId: c.id, suyoungProject: c.project || '' } } };
}
const gpush = {}; // 카드별로 한 번에 하나만 올린다(겹쳐 올라가 일정이 두 개 생기는 것을 막는다)
function pushCard(c) {
  if (gpush[c.id]) { gpush[c.id].again = true; return gpush[c.id].p; }
  const st = { again: false };
  st.p = (async () => {
    try { do { st.again = false; await pushCardOnce(c); } while (st.again); }
    finally { delete gpush[c.id]; }
  })();
  gpush[c.id] = st;
  return st.p;
}
async function pushCardOnce(c) { // 시간이 있는 카드만 캘린더에 올린다(만들기·수정. 카드를 지워도 캘린더 일정은 남긴다)
  if (!c.start || !(gset.clientId || '').trim()) return;
  try {
    if (c.gid) {
      try { await gfetch(GAPI + '/' + encodeURIComponent(c.gid), 'PATCH', evBody(c)); }
      catch (e) { if (e.code === 404 || e.code === 410) c.gid = ''; else throw e; }
    }
    if (!c.gid) { const r = await gfetch(GAPI, 'POST', evBody(c)); c.gid = (r && typeof r.id === 'string') ? r.id : ''; if (c.deleted && c.gid) { deleteCardG(c.gid); return; } } // 올리는 도중 카드를 지웠으면 방금 만든 일정도 지운다
    c.gdirty = !c.gid;
    delete gcache[c.date]; gweek = {};
  } catch (e) { c.gdirty = true; gmsg(e.message + ' (이 카드는 다음 동기화 때 다시 올립니다.)'); }
  save();
}
// 카드를 지우면 구글 일정도 지운다. 연결이 안 돼 못 지운 것은 목록에 남겨 두었다가 다음 동기화 때 지운다.
let gdel = load(KEY_GDEL, []).filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id));
async function flushGDel() {
  if (!gdel.length || !gready()) return;
  for (const id of gdel.slice()) {
    try { await gfetch(GAPI + '/' + encodeURIComponent(id), 'DELETE'); }
    catch (e) { if (e.code === 404 || e.code === 410) { /* 이미 없음 */ } else { if (e.code === 'noauth') break; continue; } }
    gdel = gdel.filter(x => x !== id); saveKey(KEY_GDEL, gdel);
    gcache = {}; gweek = {};
  }
}
function deleteCardG(gid) {
  if (!gid || !(gset.clientId || '').trim()) return;
  if (!gdel.includes(gid)) { gdel.push(gid); saveKey(KEY_GDEL, gdel); }
  flushGDel().then(() => { if (gdel.length) gmsg('구글 일정을 아직 못 지웠습니다. 연결한 뒤 동기화하면 지워집니다.'); else ensureG(shownDate, true); });
}
async function syncAll() { // 연결된 뒤 아직 못 올린 카드(오늘 이후)를 올리고 오늘 화면을 새로 읽는다
  if (!gready()) return;
  await flushGDel();
  const t = todayStr();
  for (const c of cards.filter(x => x.start && x.date >= t && (x.gdirty || !x.gid))) { await pushCard(c); if (!gready()) break; }
}
function ensureG(date, force) {
  if (!(gset.clientId || '').trim()) return;
  const c = gcache[date];
  if (!force && c && Date.now() - c.at < 60000) return;
  if (!gready()) { updateGUi(); return; }
  if (gbusy) return;
  gbusy = true;
  fetchDay(date).then(() => { gmsg(''); renderTimeline(); })
    .catch(e => gmsg(e.message))
    .finally(() => { gbusy = false; updateGUi(); if (shownDate !== date) ensureG(shownDate); });
}
// ---- 캘린더 탭(보기 전용): 보고 있는 주의 구글 일정을 모아서 읽어 온다 ----
const mondayOf = (ds) => { const d = dateOf(ds); return dstr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))); };
async function fetchWeek(mon) {
  const [y, m, d] = mon.split('-').map(Number);
  const a = new Date(y, m - 1, d).getTime(), b = new Date(y, m - 1, d + 7).getTime();
  const q = '?timeMin=' + encodeURIComponent(new Date(a).toISOString()) + '&timeMax=' + encodeURIComponent(new Date(b).toISOString()) + '&singleEvents=true&orderBy=startTime&maxResults=250';
  const j = await gfetch(GAPI + q);
  gweek[mon] = { at: Date.now(), events: ((j && j.items) || []).filter(e => e && typeof e.id === 'string' && e.status !== 'cancelled') };
}
function ensureWeek(force) {
  const mon = mondayOf(shownDate), c = gweek[mon];
  if (!(gset.clientId || '').trim() || !gready() || gwbusy) return;
  if (!force && c && Date.now() - c.at < 60000) return;
  gwbusy = true;
  fetchWeek(mon).then(() => { $('gc-msg').textContent = ''; renderGcal(); })
    .catch(e => { $('gc-msg').textContent = e.message; renderGcal(); })
    .finally(() => { gwbusy = false; updateGUi(); if (mondayOf(shownDate) !== mon) ensureWeek(); });
}
async function connectGoogle() {
  const v = $('g-client').value.trim();
  if (v !== (gset.clientId || '')) { gset.clientId = v; gcache = {}; gweek = {}; gtoken = null; saveKey(KEY_G, gset); }
  if (!v) { gmsg('클라이언트 ID를 먼저 입력하세요.'); updateGUi(); return; }
  gmsg('구글 로그인 창을 엽니다…');
  try { await gToken(); gmsg(''); updateGUi(); await syncAll(); ensureG(shownDate, true); render(); }
  catch (e) { gmsg(e.message); updateGUi(); }
}

// ---------- 할일 화면 ----------
function dayCards() { return cards.filter(c => c.date === shownDate); } // 보고 있는 날의 카드(오늘이 아닌 날도 볼 수 있다)
function overdueCards() { return cards.filter(c => c.date < todayStr() && !c.done); }

function render() {
  const box = $('cards');
  box.textContent = '';
  showHeader();
  const t = dayCards();
  // 시간이 있는 카드는 완료 여부와 관계없이 시작 시각이 빠른 순서(위에서 아래로). 시간이 없는 카드는 그 아래에 직접 정한 순서대로(미완료 먼저, 완료 나중)
  const timedList = t.filter(c => c.start).map((c, i) => ({ c, i })).sort((a, b) => hm(a.c.start) - hm(b.c.start) || (a.c.end || '24:00').localeCompare(b.c.end || '24:00') || a.i - b.i).map(x => x.c);
  const loose = t.filter(c => !c.start);
  const list = timedList.concat(loose.filter(c => !c.done), loose.filter(c => c.done));
  list.forEach(c => {
    const el = document.createElement('div');
    el.className = 'card' + (c.done ? ' done' : '') + (c.start ? '' : ' loose');
    el.dataset.id = c.id;
    const cc = colorOf(c); el.style.background = cc; el.style.color = textOn(cc); el.style.borderColor = cc; // 카드 색 = 타임라인 말풍선 색
    const chk = document.createElement('button');
    chk.className = 'chk';
    chk.textContent = c.done ? '✓' : '';
    chk.setAttribute('aria-label', '완료 표시');
    chk.onclick = () => { c.done = !c.done; save(); render(); };
    const body = document.createElement('div');
    body.className = 'body';
    body.onclick = () => { if (justDragged) return; openSheet(c.id); };
    const ti = document.createElement('div'); ti.className = 'ct'; ti.textContent = c.title;
    body.appendChild(ti);
    if (c.done) { const dc = document.createElement('span'); dc.className = 'donechip'; dc.textContent = '완료'; body.appendChild(dc); }
    if (c.memo) { const m = document.createElement('div'); m.className = 'cm'; m.textContent = c.memo; body.appendChild(m); }
    if (c.start) { const s = document.createElement('div'); s.className = 'cs'; s.textContent = '⏰ ' + timeText(c); body.appendChild(s); }
    if (c.project) {
      const p = document.createElement('span'); p.className = 'chip'; p.textContent = c.project; body.appendChild(p); // 카드 색과 같아서 반투명 바탕(CSS)
    }
    el.append(chk, body);
    if (!c.done && !c.start) { // 끌어서 순서를 바꾸는 것은 시간이 없는 카드만(시간이 있는 카드는 시간순으로 자동 정렬)
      const grip = document.createElement('div');
      grip.className = 'grip'; grip.textContent = '≡'; grip.setAttribute('aria-label', '끌어서 순서 바꾸기');
      el.appendChild(grip);
      attachDrag(el, grip);
    }
    box.appendChild(el);
  });
  renderGcal();
  renderHours();
  if ($('view-gcal').classList.contains('active')) ensureWeek();
  $('empty').hidden = list.length > 0;
  $('empty').textContent = (shownDate === todayStr() ? '오늘' : '이 날') + ' 할 일이 없습니다.\n아래 + 버튼으로 추가하세요.';
  const od = overdueCards();
  $('carry').hidden = od.length === 0 || shownDate !== todayStr(); // 이월 안내는 오늘 화면에서만
  $('carry-text').textContent = '지난 날 미완료 ' + od.length + '개';
  renderTimeline();
}

$('btn-carry').onclick = () => {
  const today = todayStr();
  const moved = overdueCards();
  moved.forEach(c => { c.date = today; if (c.start && (gset.clientId || '').trim()) c.gdirty = true; });
  save(); render();
  if (gready()) syncAll().then(() => ensureG(shownDate, true));
};

// ---------- 타임라인 ----------
function rangeFor(date) {
  const r = ranges[date] || {};
  let s = Number.isInteger(r.s) ? r.s : DEF_S, e = Number.isInteger(r.e) ? r.e : DEF_E;
  cards.filter(c => c.date === date && c.start).forEach(c => {
    s = Math.min(s, Math.floor(hm(c.start) / 60));
    const endMin = c.end ? hm(c.end) : hm(c.start) + 30;
    e = Math.max(e, Math.ceil(endMin / 60));
  });
  gItems(date).forEach(it => { s = Math.min(s, Math.floor(hm(it.start) / 60)); e = Math.max(e, Math.ceil(hm(it.end) / 60)); });
  s = Math.max(0, Math.min(s, 23)); e = Math.min(24, Math.max(e, s + 1));
  return { s, e };
}
function gItems(date) {
  const c = gcache[date];
  return c ? c.events.map(ev => gItem(ev, date)).filter(Boolean) : [];
}
function dateLabel(date) {
  const [y, m, d] = date.split('-').map(Number), w = '일월화수목금토'[new Date(y, m - 1, d).getDay()];
  return m + '월 ' + d + '일 (' + w + ')' + (date === todayStr() ? ' · 오늘' : '');
}
function hourLabel(h) { return h === 24 ? '24시' : (h < 12 ? '오전 ' : h === 12 ? '낮 ' : '오후 ') + (h % 12 === 0 ? 12 : h % 12) + '시'; }

function renderTimeline() {
  const tl = $('tl');
  tl.textContent = '';
  $('tl-date').textContent = dateLabel(shownDate);
  const { s, e } = rangeFor(shownDate);
  const stored = ranges[shownDate];
  $('tl-reset').hidden = !stored;
  const H = (e - s) * PX;
  const line = document.createElement('div'); line.className = 'tl-line'; tl.appendChild(line);
  for (let h = s; h <= e; h++) {
    const y = (h - s) * PX;
    const g = document.createElement('div'); g.className = 'tl-hline'; g.style.top = y + 'px'; tl.appendChild(g);
    const l = document.createElement('div'); l.className = 'tl-hour'; l.style.top = y + 'px';
    l.textContent = h === s || h === e || h % 3 === 0 ? hourLabel(h) : h % 12 === 0 ? hourLabel(h) : String(h % 12 === 0 ? 12 : h % 12);
    tl.appendChild(l);
  }
  const day = cards.filter(c => c.date === shownDate);
  const cardItems = day.filter(c => c.start).map(c => ({ src: 'c', c, key: c.id, title: c.title, start: c.start, end: c.end, kind: c.kind, side: c.side,
    color: colorOf(c), done: c.done, project: c.project }));
  const timed = cardItems.concat(gItems(shownDate)).sort((a, b) => hm(a.start) - hm(b.start) || a.title.localeCompare(b.title));
  const last = { L: -1e9, R: -1e9 };
  let bottom = H;
  timed.forEach(c => {
    const st = hm(c.start), en = c.end ? hm(c.end) : st + 30;
    const top0 = (st - s * 60) / 60 * PX;
    const h = Math.max((en - st) / 60 * PX, MINH);
    const pref = c.kind === 'work' ? 'L' : 'R', other = pref === 'L' ? 'R' : 'L';
    const disp = (side) => Math.max(0, last[side] + GAP - top0);
    let side = c.side || pref;
    if (!c.side && disp(pref) > disp(other) + 8) side = other; // 너무 빡빡하면 비어 있는 쪽으로
    const top = top0 + disp(side);
    last[side] = top + h;
    bottom = Math.max(bottom, top + h);
    const col = c.color, fg = textOn(col);
    const b = document.createElement('div');
    b.className = 'bub ' + side + (c.done ? ' done' : '');
    b.style.top = top + 'px'; b.style.minHeight = h + 'px';
    b.style.background = col; b.style.color = fg; b.style.setProperty('--bc', col);
    b.style.setProperty('--tail', Math.max(8, Math.min(top0 - top + 12, h - 22)) + 'px');
    const t1 = document.createElement('div'); t1.className = 'bt'; t1.textContent = (c.done ? '완료 · ' : '') + timeText(c);
    const t2 = document.createElement('div'); t2.className = 'bn'; t2.textContent = c.title;
    b.append(t1, t2);
    if (c.project) { const t3 = document.createElement('div'); t3.className = 'bp'; t3.textContent = c.project; b.appendChild(t3); }
    b.onclick = () => { if (c.src === 'g') openG(c.ev.id); else openSheet(c.c.id); };
    const f = document.createElement('button'); f.className = 'flip'; f.type = 'button'; f.textContent = '⇄';
    f.setAttribute('aria-label', '반대쪽으로 옮기기');
    f.onclick = (ev) => {
      ev.stopPropagation();
      const ns = side === 'L' ? 'R' : 'L';
      if (c.src === 'g') { gside[c.ev.id] = ns; saveKey(KEY_GSIDE, gside); } else { c.c.side = ns; save(); }
      render();
    };
    b.appendChild(f);
    tl.appendChild(b);
  });
  tl.style.height = Math.ceil(bottom + 8) + 'px';
  const ad = $('tl-allday'); ad.textContent = '';
  const allday = ((gcache[shownDate] && gcache[shownDate].events) || []).filter(ev => ev.start && ev.start.date && !ev.start.dateTime);
  allday.forEach(ev => { const sp = document.createElement('span'); sp.textContent = '종일 · ' + (ev.summary || '(제목 없음)'); ad.appendChild(sp); });
  ad.hidden = allday.length === 0;
  const noTime = day.filter(c => !c.start).length;
  $('tl-note').textContent = noTime ? '시간을 정하지 않은 카드 ' + noTime + '개는 할일 탭에서 봅니다. 회사 일은 왼쪽, 개인 일은 오른쪽에 놓이고 ⇄ 로 옮길 수 있습니다.'
    : '회사 일은 왼쪽, 개인 일은 오른쪽에 놓입니다. 말풍선 옆 ⇄ 로 반대쪽으로 옮길 수 있습니다.';
}
function extend(dir) {
  const { s, e } = rangeFor(shownDate);
  const r = Object.assign({}, ranges[shownDate]);
  r.s = dir < 0 ? Math.max(0, s - 1) : s; r.e = dir > 0 ? Math.min(24, e + 1) : e;
  if (!Number.isInteger(r.s)) r.s = s; if (!Number.isInteger(r.e)) r.e = e;
  ranges[shownDate] = r; saveAll(); renderTimeline();
}
function shrink(dir) { // 위(-1) 또는 아래(+1)에서 1시간 줄인다. 그 시간에 일정이 있으면 줄이지 않는다
  const { s, e } = rangeFor(shownDate);
  if (e - s <= 1) { $('tl-note').textContent = '더 줄일 수 없습니다(최소 1시간).'; return; }
  const r = Object.assign({}, ranges[shownDate]);
  r.s = dir < 0 ? s + 1 : s; r.e = dir > 0 ? e - 1 : e;
  const prev = ranges[shownDate];
  ranges[shownDate] = r;
  const after = rangeFor(shownDate);
  if (after.s === s && after.e === e) { // 그 시간에 카드·일정이 있어 그대로
    if (prev) ranges[shownDate] = prev; else delete ranges[shownDate];
    renderTimeline();
    $('tl-note').textContent = '그 시간에 일정이 있어 줄일 수 없습니다.';
    return;
  }
  saveAll(); renderTimeline();
}
$('tl-up').onclick = () => extend(-1);
$('tl-down').onclick = () => extend(1);
$('tl-up-less').onclick = () => shrink(-1);
$('tl-down-less').onclick = () => shrink(1);
$('tl-reset').onclick = () => { delete ranges[shownDate]; saveAll(); renderTimeline(); };
function shiftDay(n) { const [y, m, d] = shownDate.split('-').map(Number); setDate(dstr(new Date(y, m - 1, d + n))); }
$('tl-prev').onclick = () => shiftDay(-1);
$('tl-next').onclick = () => shiftDay(1);
$('tl-today').onclick = () => setDate(todayStr());
$('tl-gconnect').onclick = () => connectGoogle();
$('g-connect').onclick = () => connectGoogle();
$('g-sync').onclick = async () => { if (!gready()) { gmsg('먼저 구글에 연결하세요.'); return; } gmsg('동기화 중…'); await syncAll(); gcache = {}; gweek = {}; ensureG(shownDate, true); gmsg(''); render(); };
$('g-off').onclick = () => {
  if (!confirm('구글 연결을 해제할까요? (앱 안의 카드와 구글 캘린더의 일정은 그대로 남습니다)')) return;
  try { if (gtoken && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(gtoken, () => {}); } catch (e) { /* 무시 */ }
  gtoken = null; gexp = 0; gcache = {}; gweek = {}; gset = {}; saveKey(KEY_G, gset); gmsg(''); updateGUi(); render();
};

// ---------- 오른쪽 ≡ 손잡이를 잡고 끌어서 순서 바꾸기 (미완료 카드끼리) ----------
// 폰에서는 카드를 길게 누르면 화면 스크롤과 겹쳐 끌기가 끊겨서, 손잡이(touch-action:none)를 잡으면 바로 끌리게 했다.
let drag = null;
function attachDrag(el, grip) {
  grip.addEventListener('contextmenu', (e) => e.preventDefault());
  grip.addEventListener('pointerdown', (e) => {
    if (drag) return;
    e.preventDefault();
    beginDrag(el, e);
  });
}
// 끄는 동안 카드를 DOM에서 옮기지 않는다(옮기면 크롬이 손가락 추적을 놓친다). 끄는 카드는 손가락을 따라 transform으로만 움직이고,
// 다른 카드는 자리를 비켜 주고, 손을 뗄 때 한 번만 순서를 저장한다. 움직임은 window에서 받아 요소가 바뀌어도 끊기지 않는다.
function beginDrag(el, e) {
  const list = [...$('cards').querySelectorAll('.card.loose:not(.done)')];
  const from = list.indexOf(el);
  if (from < 0) return;
  const rects = list.map(x => x.getBoundingClientRect());
  drag = { el, list, from, to: from, pid: e.pointerId, startY: e.clientY, rects, h: rects[from].height + 10 };
  el.classList.add('dragging');
  list.forEach(x => { if (x !== el) x.style.transition = 'transform .12s'; });
  if (navigator.vibrate) { try { navigator.vibrate(15); } catch (er) { /* 무시 */ } }
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', cancelDrag);
}
function cancelDrag(e) { if (drag && e.pointerId === drag.pid) { drag.to = drag.from; endDrag(e); } } // 끌기가 중단되면(전화·알림 등) 원래 자리로
function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  const { el, list, from, rects, h } = drag;
  const dy = e.clientY - drag.startY;
  el.style.transform = 'translateY(' + dy + 'px) scale(1.02)';
  const center = rects[from].top + rects[from].height / 2 + dy;
  let to = 0; // 끄는 카드 중심보다 위에 있는 다른 카드 수 = 새 자리
  list.forEach((x, i) => { if (i !== from && rects[i].top + rects[i].height / 2 < center) to++; });
  drag.to = to;
  list.forEach((x, i) => {
    if (i === from) return;
    let shift = 0;
    if (from < to && i > from && i <= to) shift = -h;
    else if (from > to && i >= to && i < from) shift = h;
    x.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
  });
}
function endDrag(e) {
  if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.pid)) return;
  const { el, list, from, to } = drag;
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', endDrag);
  window.removeEventListener('pointercancel', cancelDrag);
  el.classList.remove('dragging');
  list.forEach(x => { x.style.transform = ''; x.style.transition = ''; });
  drag = null;
  if (from !== to) {
    const ids = list.map(x => x.dataset.id);
    const [mv] = ids.splice(from, 1); ids.splice(to, 0, mv);
    const set = new Set(ids);
    const moved = ids.map(id => cards.find(c => c.id === id)).filter(Boolean);
    cards = cards.filter(c => !set.has(c.id)).concat(moved);
  }
  save();
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 300);
  render();
}
$('cards').addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });

// ---------- 카드 추가·수정·삭제 ----------
function fillProjList() { // 고른 구분(회사/개인)에 쓰인 프로젝트만 보여 준다. 아직 카드가 없는 프로젝트는 양쪽에 보인다
  const dl = $('projlist'); dl.textContent = '';
  const kind = $('f-kind').value === 'personal' ? 'personal' : 'work';
  Object.keys(projects).forEach(n => {
    const used = cards.filter(c => c.project === n);
    if (used.length && !used.some(c => c.kind === kind)) return;
    const o = document.createElement('option'); o.value = n; dl.appendChild(o);
  });
  $('l-proj').firstChild.nodeValue = kind === 'personal' ? '개인 프로젝트(선택, 새 이름도 가능)' : '프로젝트(선택, 새 이름도 가능)';
}
function openSheet(id) {
  editingId = id || null;
  const c = cards.find(x => x.id === id);
  $('sheet-title').textContent = c ? '카드 수정' : '새 카드' + (shownDate === todayStr() ? '' : ' · ' + dateLabel(shownDate).replace(' · 오늘', ''));
  $('f-title').value = c ? c.title : '';
  $('f-memo').value = c ? c.memo : '';
  $('f-start').value = c ? c.start : '';
  $('f-end').value = c ? c.end : '';
  $('f-kind').value = c ? c.kind : 'work';
  $('f-side').value = c ? c.side : '';
  $('f-proj').value = c ? c.project : '';
  $('f-color').value = c ? colorOf(c) : COLOR_DEFAULT.work;
  $('f-err').hidden = true;
  editingG = null;
  $('l-kind').hidden = false; $('r-proj').hidden = false; $('f-gnote').hidden = true;
  $('clk').hidden = !isAndroid;
  setAl($('al-start'), c ? c.alarmS !== false : true); setAl($('al-end'), c ? c.alarmE !== false : true); setAlRow(true);
  fillProjList();
  $('btn-del').hidden = !c;
  $('sheet').hidden = false;
  setTimeout(() => $('f-title').focus(), 50);
}
function openG(id) { // 구글 캘린더 일정 고치기·지우기
  const it = gItems(shownDate).find(x => x.ev.id === id);
  if (!it) return;
  editingId = null; editingG = id;
  $('sheet-title').textContent = '구글 캘린더 일정';
  $('f-title').value = it.ev.summary || '';
  $('f-memo').value = it.memo.slice(0, 500);
  $('f-start').value = it.start === '24:00' ? '' : it.start;
  $('f-end').value = it.end === '24:00' ? '' : it.end;
  $('f-side').value = it.side;
  $('l-kind').hidden = true; $('r-proj').hidden = true; $('f-gnote').hidden = false; $('clk').hidden = true; setAlRow(false);
  $('f-err').hidden = true;
  $('btn-del').hidden = false;
  $('sheet').hidden = false;
  setTimeout(() => $('f-title').focus(), 50);
}
// 시작·완료 시각 옆 "지금" 버튼과, 카드마다 시작·완료 알람을 켜고 끄는 버튼(처음엔 켜짐)
function setAl(btn, on) {
  btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = (btn.id === 'al-start' ? '⏰ 시작 알람 ' : '⏰ 완료 알람 ') + (on ? '✓' : '꺼짐');
}
function setAlRow(show) { const r = $('al-start').parentElement; r.hidden = !show; if (r.nextElementSibling) r.nextElementSibling.hidden = !show; }
['al-start', 'al-end'].forEach(id => { $(id).onclick = () => setAl($(id), $(id).getAttribute('aria-pressed') !== 'true'); });
const nowHM = () => { const d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
$('now-start').onclick = () => { $('f-start').value = nowHM(); $('f-err').hidden = true; };
$('now-end').onclick = () => { $('f-end').value = nowHM(); $('f-err').hidden = true; };
// 폰 화면이 꺼지면 웹앱은 진동·소리를 낼 수 없다(브라우저가 멈춘다). 그래서 안드로이드 시계 앱에 알람을 만드는 길을 둔다.
const isAndroid = /Android/i.test(navigator.userAgent);
function clockAlarm(t, what) {
  const err = $('f-err');
  if (!isTime(t)) { err.textContent = '먼저 ' + what + ' 시간을 정해 주세요.'; err.hidden = false; return; }
  err.hidden = true;
  const [h, m] = t.split(':').map(Number);
  const label = Array.from(($('f-title').value.trim() || '수영!일해야지!') + ' ' + what).slice(0, 40).join(''); // 글자 단위로 자른다(이모지가 반으로 잘려 오류 나는 것 방지)
  // 시계 앱이 열리면 알람 내용이 채워져 있고, 소장이 저장만 누른다
  location.href = 'intent:#Intent;action=android.intent.action.SET_ALARM;i.android.intent.extra.alarm.HOUR=' + h + ';i.android.intent.extra.alarm.MINUTES=' + m +
    ';S.android.intent.extra.alarm.MESSAGE=' + encodeURIComponent(label) + ';b.android.intent.extra.alarm.VIBRATE=true;end';
}
$('clk-start').onclick = () => clockAlarm($('f-start').value, '시작');
$('clk-end').onclick = () => clockAlarm($('f-end').value, '완료');
function closeSheet() { $('sheet').hidden = true; editingId = null; editingG = null; }
async function saveG(title, memo, start, end, side) {
  const err = $('f-err');
  const ev = ((gcache[shownDate] && gcache[shownDate].events) || []).find(e => e.id === editingG);
  if (!ev) { closeSheet(); return; }
  const it = gItem(ev, shownDate);
  const body = { summary: title, description: memo };
  const sameTime = it && start === it.start && (end === it.end || (it.end === '24:00' && end === '')); // 시간을 안 건드렸으면 시간은 보내지 않는다
  if (it && !it.clipped && start && !sameTime) { // 여러 날에 걸친 일정은 제목·메모만 고친다(시간은 구글 캘린더에서)
    const [y, m, d] = shownDate.split('-').map(Number);
    const tzS = (ev.start && ev.start.timeZone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const mk = (t) => new Date(y, m - 1, d, Number(t.slice(0, 2)), Number(t.slice(3))).toISOString();
    const e2 = end || pad2(Math.min(23, Number(start.slice(0, 2)) + (Number(start.slice(3)) >= 30 ? 1 : 0))) + ':' + (Number(start.slice(3)) >= 30 ? '00' : '30');
    body.start = { dateTime: mk(start), timeZone: tzS };
    body.end = { dateTime: mk(e2 > start ? e2 : '23:59'), timeZone: tzS };
  }
  try {
    await gfetch(GAPI + '/' + encodeURIComponent(ev.id), 'PATCH', body);
    if (side) { gside[ev.id] = side; saveKey(KEY_GSIDE, gside); }
    closeSheet(); gweek = {}; await fetchDay(shownDate); gmsg(''); render();
  } catch (e) { err.textContent = e.message; err.hidden = false; }
}
async function deleteG() {
  const ev = ((gcache[shownDate] && gcache[shownDate].events) || []).find(e => e.id === editingG);
  if (!ev) { closeSheet(); return; }
  const rec = ev.recurringEventId ? '\n반복 일정이라 이 날 하루만 지워집니다.' : '';
  if (!confirm('이 일정을 구글 캘린더에서도 지웁니다.' + rec + '\n(구글 캘린더 휴지통에서 복구할 수 있습니다)\n지울까요?')) return;
  try {
    await gfetch(GAPI + '/' + encodeURIComponent(ev.id), 'DELETE');
    gcache[shownDate].events = gcache[shownDate].events.filter(e => e.id !== ev.id); gweek = {};
    cards.forEach(c => { if (c.gid === ev.id) c.gid = ''; }); save();
    closeSheet(); render();
  } catch (e) { $('f-err').textContent = e.message; $('f-err').hidden = false; }
}
$('f-proj').addEventListener('input', () => {
  const n = $('f-proj').value.trim();
  if (Object.prototype.hasOwnProperty.call(projects, n) && isColor(projects[n])) $('f-color').value = projects[n];
});
$('f-kind').addEventListener('change', fillProjList);
$('f-kind').addEventListener('change', () => { // 직접 고르지 않은 기본색이면 구분에 맞는 기본색으로 따라 바꾼다
  const k = $('f-kind').value === 'personal' ? 'personal' : 'work', o = k === 'work' ? 'personal' : 'work';
  if (!$('f-proj').value.trim() && $('f-color').value.toLowerCase() === COLOR_DEFAULT[o]) $('f-color').value = COLOR_DEFAULT[k];
});

$('fab').onclick = () => openSheet(null);
$('btn-cancel').onclick = closeSheet;
$('sheet').onclick = (e) => { if (e.target === $('sheet')) closeSheet(); };
$('btn-del').onclick = () => {
  if (editingG) { deleteG(); return; }
  const del = cards.find(c => c.id === editingId);
  const inG = !!(del && del.gid && (gset.clientId || '').trim());
  if (!confirm(inG ? '이 카드를 삭제할까요?\n구글 캘린더의 일정도 함께 지워집니다.' : '이 카드를 삭제할까요?')) return;
  if (del) del.deleted = true; // 올리는 중인 요청이 있으면 알아차리게 표시(저장되는 카드 목록에서는 빠진다)
  cards = cards.filter(c => c.id !== editingId);
  save(); closeSheet(); render();
  if (inG) deleteCardG(del.gid);
};
$('form').onsubmit = (e) => {
  e.preventDefault();
  const title = $('f-title').value.trim();
  if (!title) return;
  const start = $('f-start').value, end = $('f-end').value;
  const err = $('f-err');
  if (end && !start) { err.textContent = '완료 시간을 쓰려면 시작 시간도 정해 주세요.'; err.hidden = false; return; }
  if (end && end <= start) { err.textContent = '완료 시간은 시작 시간보다 늦어야 합니다.'; err.hidden = false; return; }
  if (editingG) { saveG(title, $('f-memo').value.trim(), start, end, $('f-side').value); return; }
  const proj =$('f-proj').value.trim().slice(0, 40);
  const color = $('f-color').value;
  if (proj) projects[proj] = color;
  const kind = $('f-kind').value === 'personal' ? 'personal' : 'work';
  const f = { title, memo: $('f-memo').value.trim(), start, end, time: start, alarmS: $('al-start').getAttribute('aria-pressed') === 'true', alarmE: $('al-end').getAttribute('aria-pressed') === 'true', kind, side: $('f-side').value, project: proj,
    color: proj ? '' : (color === COLOR_DEFAULT[kind] ? '' : color) };
  const c = cards.find(x => x.id === editingId);
  if (c) Object.assign(c, f);
  else cards.push(Object.assign({ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
    done: false, source: '내 카드', date: shownDate, gid: '', gdirty: false, created: new Date().toISOString() }, f));
  const card = c || cards[cards.length - 1];
  const toGoogle = !!(card.start && (gset.clientId || '').trim());
  if (toGoogle) card.gdirty = true; // 올리기에 성공하면 pushCard가 false로 바꾼다
  saveAll(); closeSheet(); render();
  if (toGoogle) pushCard(card).then(() => { render(); if (card.date === shownDate) ensureG(shownDate, true); });
};

// ---------- 백업 ----------
function backupMsg(t) { $('backup-msg').textContent = t; }
function backupFile() {
  const data = { app: 'suyoung-ilhaeyaji', version: 2, exported: new Date().toISOString(), cards, projects, ranges, gside };
  const name = '수영일해야지_백업_' + todayStr() + '.json';
  return { name, blob: new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }) };
}
// 저장 위치 안내: 웹앱은 폰의 폴더를 마음대로 정할 수 없다. 가능한 방법을 상황에 맞게 보여 준다.
const canPick = typeof window.showSaveFilePicker === 'function';
const canShareFile = (() => { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'a.json', { type: 'application/json' })] })); } catch (e) { return false; } })();
$('save-where').textContent = canPick
  ? '내보낼 때 저장할 폴더와 파일 이름을 직접 고릅니다.'
  : '"파일로 내보내기"는 크롬의 기본 다운로드 폴더(폰의 "내 파일 > 다운로드")에 저장됩니다. 다른 폴더나 구글 드라이브에 저장하려면 아래 "다른 곳에 저장하기"를 쓰거나, 크롬 설정의 다운로드 항목에서 저장 위치를 바꾸세요(폰 기종에 따라 메뉴 이름이 다를 수 있습니다). "다른 곳에 저장하기"는 인터넷 주소(https)로 열었을 때만 나타납니다.';
$('btn-share').hidden = !canShareFile;
$('btn-export').onclick = async () => {
  const { name, blob } = backupFile();
  if (canPick) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: '수영!일해야지! 백업', accept: { 'application/json': ['.json'] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      backupMsg('저장했습니다: ' + h.name + ' (카드 ' + cards.length + '개). 고른 폴더에 있습니다.');
    } catch (e) { backupMsg(e && e.name === 'AbortError' ? '저장을 취소했습니다.' : '저장하지 못했습니다: ' + (e && e.message ? e.message : e)); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  backupMsg('내보냈습니다: ' + name + ' (카드 ' + cards.length + '개). 크롬의 기본 다운로드 폴더에 저장됩니다. 폰에서는 "내 파일 > 다운로드"에서 찾을 수 있고, 개인 드라이브 등에 따로 보관하세요.');
};
$('btn-share').onclick = async () => {
  const { name, blob } = backupFile();
  try {
    await navigator.share({ files: [new File([blob], name, { type: 'application/json' })], title: '수영!일해야지! 백업' });
    backupMsg('공유 창에서 고른 곳으로 보냈습니다(예: 내 파일, 구글 드라이브). 파일 이름: ' + name);
  } catch (e) { backupMsg(e && e.name === 'AbortError' ? '저장을 취소했습니다.' : '저장하지 못했습니다: ' + (e && e.message ? e.message : e)); }
};
$('btn-import').onclick = () => $('f-import').click();
$('f-import').onchange = () => {
  const f = $('f-import').files[0];
  $('f-import').value = '';
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    let d;
    try { d = JSON.parse(rd.result); } catch (e) { backupMsg('불러오지 못했습니다: 올바른 백업 파일이 아닙니다.'); return; }
    if (!d || d.app !== 'suyoung-ilhaeyaji' || !Array.isArray(d.cards)) { backupMsg('불러오지 못했습니다: 이 앱의 백업 파일이 아닙니다.'); return; }
    const ok = d.cards.map(norm).filter(c => c && c.title.trim() !== '');
    const have = new Set(cards.map(c => c.id));
    const add = ok.filter(c => { if (have.has(c.id)) return false; have.add(c.id); return true; });
    if (add.length === 0) { backupMsg('새로 들어올 카드가 없습니다(이미 있는 카드는 건너뜁니다).'); return; }
    if (!confirm('카드 ' + add.length + '개를 추가할까요? (이미 있는 카드는 그대로 둡니다)')) return;
    const prevCards = cards, prevProj = projects, prevRange = ranges, prevGside = gside;
    cards = cards.concat(add);
    projects = Object.assign({}, projects);
    if (d.projects && typeof d.projects === 'object') Object.keys(d.projects).forEach(n => {
      if (!(n in projects) && isColor(d.projects[n])) projects[String(n).slice(0, 40)] = d.projects[n];
    });
    if (d.gside && typeof d.gside === 'object' && !Array.isArray(d.gside)) {
      gside = Object.assign({}, gside);
      Object.keys(d.gside).forEach(k => { if (/^[A-Za-z0-9_-]{1,100}$/.test(k) && !own(gside, k) && (d.gside[k] === 'L' || d.gside[k] === 'R')) gside[k] = d.gside[k]; });
    }
    ranges = Object.assign({}, ranges);
    if (d.ranges && typeof d.ranges === 'object') Object.keys(d.ranges).forEach(k => {
      const r = d.ranges[k];
      if (isDate(k) && !(k in ranges) && r && Number.isInteger(r.s) && Number.isInteger(r.e)) ranges[k] = { s: r.s, e: r.e };
    });
    if (!(saveKey(KEY, cards) && saveKey(KEY_PROJ, projects) && saveKey(KEY_RANGE, ranges) && saveKey(KEY_GSIDE, gside))) {
      cards = prevCards; projects = prevProj; ranges = prevRange; gside = prevGside;
      saveKey(KEY, cards); saveKey(KEY_PROJ, projects); saveKey(KEY_RANGE, ranges); saveKey(KEY_GSIDE, gside);
      backupMsg('불러오지 못했습니다: 저장 공간이 부족합니다.'); return;
    }
    render();
    backupMsg('불러왔습니다: ' + add.length + '개 추가, ' + (d.cards.length - add.length) + '개 건너뜀.');
  };
  rd.readAsText(f);
};

// ---------- 투입시간 탭: 완료된 카드(시작·완료 시각이 있는 것)의 시간을 프로젝트별로 모아 보여 준다 ----------
const fmtDur = (m) => m <= 0 ? '0분' : (m >= 60 ? Math.floor(m / 60) + '시간' : '') + (m % 60 ? (m >= 60 ? ' ' : '') + (m % 60) + '분' : '');
function spentOf(date) {
  const groups = new Map(), segs = [];
  let total = 0;
  cards.forEach(c => {
    if (c.date !== date || !c.done || !c.start || !c.end) return;
    const s = hm(c.start), e = hm(c.end);
    if (!(e > s)) return;
    const name = c.project || (c.kind === 'work' ? '회사 일(프로젝트 없음)' : '개인 일(프로젝트 없음)');
    const g = groups.get(name) || { min: 0, color: colorOf(c) };
    g.min += e - s; groups.set(name, g); total += e - s;
    segs.push({ s, e, color: colorOf(c), name });
  });
  return { groups, segs, total };
}
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) { const el = document.createElementNS(SVGNS, tag); Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k])); return el; }
function drawClock(segs, showNow) { // 24시간 시계: 0시가 맨 위, 시계 방향. 쓴 시간대를 프로젝트 색 부채꼴로 칠한다
  const R = 100, svg = svgEl('svg', { viewBox: '-120 -120 240 240', class: 'hr-clock', role: 'img', 'aria-label': '하루 24시간 투입시간 시계' });
  const pt = (min, r) => { const a = min / 1440 * 2 * Math.PI; return [r * Math.sin(a), -r * Math.cos(a)]; };
  svg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: R, fill: '#fff', stroke: '#bdb8ab', 'stroke-width': 2 }));
  segs.forEach(g => {
    const [x1, y1] = pt(g.s, R), [x2, y2] = pt(g.e, R), large = g.e - g.s > 720 ? 1 : 0;
    const d = g.e - g.s >= 1440 ? '' : 'M0,0 L' + x1.toFixed(2) + ',' + y1.toFixed(2) + ' A' + R + ',' + R + ' 0 ' + large + ' 1 ' + x2.toFixed(2) + ',' + y2.toFixed(2) + ' Z';
    if (d) { const p = svgEl('path', { d, fill: g.color, 'fill-opacity': 0.85, stroke: '#fff', 'stroke-width': 0.8 }); const t = svgEl('title', {}); t.textContent = g.name + ' ' + fmtDur(g.e - g.s); p.appendChild(t); svg.appendChild(p); }
  });
  for (let h = 0; h < 24; h++) {
    const [a, b] = pt(h * 60, R), [c, d] = pt(h * 60, h % 6 === 0 ? R - 12 : R - 6);
    svg.appendChild(svgEl('line', { x1: a, y1: b, x2: c, y2: d, stroke: '#8a8576', 'stroke-width': h % 6 === 0 ? 2 : 1 }));
  }
  [0, 6, 12, 18].forEach(h => {
    const [x, y] = pt(h * 60, R - 24);
    const t = svgEl('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#555' });
    t.textContent = h; svg.appendChild(t);
  });
  if (showNow) {
    const d = new Date(), [x, y] = pt(d.getHours() * 60 + d.getMinutes(), R - 4);
    svg.appendChild(svgEl('line', { x1: 0, y1: 0, x2: x, y2: y, stroke: '#c0392b', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  }
  svg.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 4, fill: '#555' }));
  return svg;
}
function legendRow(name, color, text) {
  const r = document.createElement('div'); r.className = 'hr-row';
  const sw = document.createElement('span'); sw.className = 'hr-sw'; sw.style.background = color;
  const n = document.createElement('span'); n.className = 'hr-n'; n.textContent = name;
  const v = document.createElement('span'); v.className = 'hr-v'; v.textContent = text;
  r.append(sw, n, v); return r;
}
function renderHours() {
  const d = dateOf(shownDate), t = todayStr();
  $('hr-date').textContent = dateLabel(shownDate);
  const day = spentOf(shownDate);
  const box = $('hr-clock'); box.textContent = '';
  box.appendChild(drawClock(day.segs, shownDate === t));
  const dl = $('hr-day'); dl.textContent = '';
  [...day.groups.entries()].sort((a, b) => b[1].min - a[1].min).forEach(([n, g]) => dl.appendChild(legendRow(n, g.color, fmtDur(g.min))));
  $('hr-day-total').textContent = day.total ? '이 날 합계 ' + fmtDur(day.total) : '이 날 완료된 시간 기록이 없습니다.';
  // 주간(월~일)
  const mon = dateOf(mondayOf(shownDate)), days = [], wk = new Map();
  let maxDay = 240, wkTotal = 0;
  for (let i = 0; i < 7; i++) {
    const ds = dstr(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i)), s = spentOf(ds);
    days.push({ ds, i, s }); maxDay = Math.max(maxDay, s.total); wkTotal += s.total;
    s.groups.forEach((g, n) => { const w = wk.get(n) || { min: 0, color: g.color }; w.min += g.min; wk.set(n, w); });
  }
  const bars = $('hr-week'); bars.textContent = '';
  days.forEach(({ ds, i, s }) => {
    const col = document.createElement('button'); col.type = 'button'; col.className = 'hr-col' + (ds === shownDate ? ' sel' : '');
    col.setAttribute('aria-label', ds + ' ' + fmtDur(s.total));
    const tot = document.createElement('div'); tot.className = 'hr-tot'; tot.textContent = s.total ? (Math.round(s.total / 6) / 10) + 'h' : '';
    const stack = document.createElement('div'); stack.className = 'hr-stack';
    s.groups.forEach((g, n) => { const seg = document.createElement('div'); seg.className = 'hr-seg'; seg.style.height = (g.min / maxDay * 100) + '%'; seg.style.background = g.color; seg.title = n + ' ' + fmtDur(g.min); stack.appendChild(seg); });
    const lb = document.createElement('div'); lb.className = 'hr-dn' + (i === 5 ? ' sat' : i === 6 ? ' sun' : '') + (ds === t ? ' today' : ''); lb.textContent = '월화수목금토일'[i];
    col.append(tot, stack, lb); col.onclick = () => setDate(ds); bars.appendChild(col);
  });
  const wl = $('hr-wlist'); wl.textContent = '';
  [...wk.entries()].sort((a, b) => b[1].min - a[1].min).forEach(([n, g]) => wl.appendChild(legendRow(n, g.color, fmtDur(g.min) + ' · 하루 평균 ' + fmtDur(Math.round(g.min / 7)))));
  $('hr-week-total').textContent = wkTotal ? '이 주 합계 ' + fmtDur(wkTotal) + ' · 하루 평균 ' + fmtDur(Math.round(wkTotal / 7)) : '이 주 완료된 시간 기록이 없습니다.';
}
$('hr-prev').onclick = () => { const d = dateOf(shownDate); setDate(dstr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1))); };
$('hr-next').onclick = () => { const d = dateOf(shownDate); setDate(dstr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))); };
$('hr-today').onclick = () => setDate(todayStr());
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view === 'timeline') { renderTimeline(); ensureG(shownDate); }
  if (b.dataset.view === 'gcal') { renderGcal(); ensureWeek(); }
  if (b.dataset.view === 'hours') renderHours();
  if (b.dataset.view === 'settings') updateGUi();
});

// ---------- 옆으로 밀어서 탭 넘기기: 왼쪽으로 밀면 다음 탭(할일→타임라인→캘린더→투입시간→설정), 오른쪽으로 밀면 이전 탭 ----------
(function () {
  let sx = 0, sy = 0, st = 0, ok = false;
  const main = document.querySelector('main');
  main.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    ok = e.touches.length === 1 && !drag && !e.target.closest('.grip, input, textarea, select, .bub, .hr-col');
    sx = t.clientX; sy = t.clientY; st = Date.now();
  }, { passive: true });
  main.addEventListener('touchend', (e) => {
    if (!ok || drag) return; ok = false;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Date.now() - st > 800 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return; // 짧고 분명한 가로 밀기만(세로 스크롤과 구분)
    if (!$('sheet').hidden || !$('cal').hidden) return;
    const tabs = [...document.querySelectorAll('.tab')], cur = tabs.findIndex(x => x.classList.contains('active'));
    const next = tabs[cur + (dx < 0 ? 1 : -1)];
    if (next) next.click();
  }, { passive: true });
})();

// ---------- 오늘 날짜·이번 주 표시와 자정 바뀜 ----------
const weekOfMonth = (d) => { const off = (new Date(d.getFullYear(), d.getMonth(), 1).getDay() + 6) % 7; return Math.floor((d.getDate() - 1 + off) / 7) + 1; }; // 월요일 시작, 1일이 든 주가 1주차
const dateOf = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
function setDate(ds) { shownDate = ds; render(); ensureG(shownDate); } // 보는 날을 바꾼다(할일·타임라인 둘 다 같은 날)
function renderStrip() { // 왼쪽 세로 띠: 맨 위 "지금"(오늘로 돌아오기) + 보고 있는 주의 월~일. 오늘 요일은 색으로, 보고 있는 날은 테두리로
  const s = $('daystrip'); s.textContent = '';
  const today = todayStr(), sel = dateOf(shownDate);
  const nb = document.createElement('button'); nb.type = 'button'; nb.className = 'nowbtn' + (shownDate === today ? '' : ' away'); nb.textContent = '지금';
  nb.setAttribute('aria-label', '오늘로 돌아가기'); nb.onclick = () => setDate(todayStr()); s.appendChild(nb);
  const monday = new Date(sel.getFullYear(), sel.getMonth(), sel.getDate() - ((sel.getDay() + 6) % 7));
  ['월', '화', '수', '목', '금', '토', '일'].forEach((n, i) => {
    const dd = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i), ds = dstr(dd);
    const b = document.createElement('button'); b.type = 'button'; b.textContent = n;
    if (i === 5) b.classList.add('sat'); if (i === 6) b.classList.add('sun');
    if (ds === today) b.classList.add('now'); if (ds === shownDate) { b.classList.add('sel'); b.setAttribute('aria-current', 'date'); }
    if (cards.some(c => c.date === ds)) b.classList.add('has');
    b.setAttribute('aria-label', (dd.getMonth() + 1) + '월 ' + dd.getDate() + '일 ' + n + '요일' + (ds === today ? ' (오늘)' : ''));
    b.onclick = () => setDate(ds); s.appendChild(b);
  });
}
function showHeader() {
  const d = dateOf(shownDate), t = todayStr();
  $('today').textContent = d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + '일월화수목금토'[d.getDay()] + ')' + (shownDate === t ? '' : shownDate < t ? ' · 지난 날' : ' · 앞으로');
  $('wk-week').textContent = weekOfMonth(d) + '주차';
  $('wk-month').textContent = (d.getMonth() + 1) + '월';
  document.querySelector('.top').classList.toggle('other', shownDate !== t);
  renderStrip();
}
// ---------- 캘린더 탭 (구글 일정 보기 전용: 클릭·수정·삭제 없음) ----------
function renderGcal() {
  const list = $('gc-list'); list.textContent = '';
  const mon = mondayOf(shownDate), monD = dateOf(mon), sunD = new Date(monD.getFullYear(), monD.getMonth(), monD.getDate() + 6);
  $('gc-title').textContent = (monD.getMonth() + 1) + '/' + monD.getDate() + ' ~ ' + (sunD.getMonth() + 1) + '/' + sunD.getDate();
  const has = !!(gset.clientId || '').trim();
  $('gc-connect').hidden = !(has && !gready());
  const note = (t) => { const p = document.createElement('p'); p.className = 'empty'; p.textContent = t; list.appendChild(p); };
  if (!has) { note('구글 캘린더가 연결돼 있지 않습니다.\n설정 탭에서 클라이언트 ID를 넣고 연결하세요.'); return; }
  if (!gready()) { note('구글 캘린더에 연결해야 일정이 보입니다.\n위의 연결 버튼을 누르세요.'); return; }
  const c = gweek[mon];
  if (!c) { note('불러오는 중…'); return; }
  const t = todayStr();
  for (let i = 0; i < 7; i++) {
    const dd = new Date(monD.getFullYear(), monD.getMonth(), monD.getDate() + i), ds = dstr(dd), [d0, d1] = dayBounds(ds);
    const sec = document.createElement('div'); sec.className = 'gc-day' + (ds === t ? ' today' : '') + (ds === shownDate ? ' sel' : '');
    const h = document.createElement('div'); h.className = 'gc-dh';
    h.textContent = (dd.getMonth() + 1) + '월 ' + dd.getDate() + '일 (' + '일월화수목금토'[dd.getDay()] + ')' + (ds === t ? ' · 오늘' : '');
    sec.appendChild(h);
    const items = [];
    c.events.forEach(ev => {
      if (!ev.start) return;
      if (ev.start.date) { // 종일 일정(끝 날짜는 포함하지 않는다)
        const endD = (ev.end && ev.end.date) || ev.start.date;
        if (ev.start.date <= ds && (ds < endD || ev.start.date === endD && ds === endD)) items.push({ ev, allday: true, s: 0, e: 0 });
        return;
      }
      if (!ev.start.dateTime) return;
      const s = new Date(ev.start.dateTime).getTime(), e = new Date((ev.end && ev.end.dateTime) || ev.start.dateTime).getTime();
      if (s < d1 && (e > d0 || (e === s && s >= d0))) items.push({ ev, allday: false, s: Math.max(s, d0), e: Math.min(e, d1) });
    });
    items.sort((a, b) => (b.allday - a.allday) || a.s - b.s);
    if (!items.length) { const n = document.createElement('div'); n.className = 'gc-none'; n.textContent = '일정 없음'; sec.appendChild(n); }
    items.forEach(it => {
      const e = document.createElement('div'); e.className = 'gc-ev';
      e.style.setProperty('--c', own(GCOLOR, String(it.ev.colorId)) ? GCOLOR[it.ev.colorId] : '#5f6b7a');
      const a = document.createElement('div'); a.className = 'gc-et'; a.textContent = it.allday ? '종일' : clock(it.s, d1) + '~' + clock(it.e, d1);
      const b = document.createElement('div'); b.className = 'gc-en'; b.textContent = it.ev.summary || '(제목 없음)';
      e.append(a, b);
      if (it.ev.location) { const l = document.createElement('div'); l.className = 'gc-el'; l.textContent = '📍 ' + it.ev.location; e.appendChild(l); }
      sec.appendChild(e);
    });
    list.appendChild(sec);
  }
}
$('gc-prev').onclick = () => { const d = dateOf(shownDate); setDate(dstr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7))); };
$('gc-next').onclick = () => { const d = dateOf(shownDate); setDate(dstr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7))); };
$('gc-today').onclick = () => setDate(todayStr());
$('gc-connect').onclick = () => connectGoogle();
// 날짜 고르기: 제목 옆 "N주차 / M월"을 누르면 달력이 열린다
let calM = null;
function drawCal() {
  $('cal-title').textContent = calM.y + '년 ' + (calM.m + 1) + '월';
  const g = $('cal-grid'); g.textContent = '';
  ['월', '화', '수', '목', '금', '토', '일'].forEach((n, i) => { const h = document.createElement('div'); h.className = 'cal-h' + (i === 5 ? ' sat' : i === 6 ? ' sun' : ''); h.textContent = n; g.appendChild(h); });
  const off = (new Date(calM.y, calM.m, 1).getDay() + 6) % 7, days = new Date(calM.y, calM.m + 1, 0).getDate(), t = todayStr();
  for (let i = 0; i < off; i++) g.appendChild(document.createElement('div'));
  for (let d = 1; d <= days; d++) {
    const ds = dstr(new Date(calM.y, calM.m, d));
    const b = document.createElement('button'); b.type = 'button'; b.textContent = d;
    b.className = 'cal-d' + (ds === t ? ' today' : '') + (ds === shownDate ? ' sel' : '') + (cards.some(c => c.date === ds) ? ' has' : '');
    b.onclick = () => { $('cal').hidden = true; setDate(ds); };
    g.appendChild(b);
  }
}
$('wk').onclick = () => { const d = dateOf(shownDate); calM = { y: d.getFullYear(), m: d.getMonth() }; drawCal(); $('cal').hidden = false; };
$('cal-prev').onclick = () => { calM.m--; if (calM.m < 0) { calM.m = 11; calM.y--; } drawCal(); };
$('cal-next').onclick = () => { calM.m++; if (calM.m > 11) { calM.m = 0; calM.y++; } drawCal(); };
$('cal-today').onclick = () => { $('cal').hidden = true; setDate(todayStr()); };
$('cal-close').onclick = () => { $('cal').hidden = true; };
$('cal').onclick = (e) => { if (e.target === $('cal')) $('cal').hidden = true; };
let lastDay = todayStr();
function dayRoll() { // 자정(24시)이 지나면 오늘 화면을 새 날로 바꾼다(다른 날을 보고 있으면 그대로). 어제 못 끝낸 카드는 "오늘로 이월" 안내로 남는다
  const t = todayStr();
  if (t === lastDay) return;
  const wasToday = shownDate === lastDay;
  lastDay = t; if (wasToday) shownDate = t;
  render(); ensureG(shownDate);
}
setInterval(dayRoll, 20000);

// ---------- 알림 (소리·진동, 시작·완료 시각, 같은 시각은 한 번만) ----------
const MODES = ['both', 'sound', 'vibrate', 'off'];
aset = Object.assign({ mode: 'both', end: true, gcal: true }, load(KEY_ALARM, {}));
if (!MODES.includes(aset.mode)) aset.mode = 'both';
aset.end = aset.end !== false; aset.gcal = aset.gcal !== false;
let actx = null;
function unlockAudio() { // 브라우저 규칙: 화면을 한 번 눌러야 소리·진동이 허용된다
  try {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) actx = new AC(); }
    if (actx && actx.state === 'suspended') actx.resume();
  } catch (e) { /* 무시 */ }
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, unlockAudio, { passive: true }));
function beep() {
  if (!actx) return;
  const t0 = actx.currentTime;
  [0, 0.35, 0.7].forEach(off => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t0 + off); g.gain.exponentialRampToValueAtTime(0.5, t0 + off + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.25);
    o.connect(g); g.connect(actx.destination); o.start(t0 + off); o.stop(t0 + off + 0.3);
  });
}
function buzz() { try { if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 800]); } catch (e) { /* 무시 */ } }
function ring(lines, test) {
  if (aset.mode === 'off') { if (test) { $('alarm-text').textContent = '알림이 꺼져 있습니다(설정 > 알림 방식).'; $('alarm').hidden = false; } return; }
  const prev = !$('alarm').hidden && !test ? $('alarm-text').textContent.split('\n').filter(Boolean) : []; // 아직 확인하지 않은 앞 알림은 지우지 않고 아래에 이어 붙인다
  $('alarm-text').textContent = (prev.length ? prev.join('\n') + '\n' : '') + '⏰ ' + lines.join('\n⏰ ');
  $('alarm').hidden = false;
  if (aset.mode === 'sound' || aset.mode === 'both') beep();
  if (aset.mode === 'vibrate' || aset.mode === 'both') buzz();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) { // 화면 밖일 때(https에서 허용했을 때만)
    navigator.serviceWorker.getRegistration().then(r => { if (r) r.showNotification('수영!일해야지!', { body: lines.join('\n'), tag: 'suyoung-alarm', renotify: true, vibrate: [400, 150, 400], icon: 'icon-192.png' }); }).catch(() => {});
  }
}
$('alarm-ok').onclick = () => { $('alarm').hidden = true; };
let fired = load(KEY_FIRED, {});
let lastTick = Number(localStorage.getItem(KEY_TICK)) || Date.now();
function alarmTick() { // 지난 확인 이후(최대 5분) 지나간 분들의 시작·완료를 모아서 한 번만 울린다
  const now = Date.now();
  const from = Math.max(lastTick, now - 5 * 60000);
  lastTick = now; try { localStorage.setItem(KEY_TICK, String(now)); } catch (e) { /* 무시 */ }
  if (aset.mode === 'off') return;
  const lines = [];
  for (let t = Math.floor(from / 60000) * 60000; t <= now; t += 60000) {
    const dt = new Date(t), d = dstr(dt), hhmm = pad2(dt.getHours()) + ':' + pad2(dt.getMinutes());
    cards.forEach(c => {
      if (c.date !== d || c.done || !c.start) return;
      const kinds = [];
      if (c.start === hhmm && c.alarmS !== false) kinds.push('start');
      if (aset.end && c.alarmE !== false && c.end && c.end === hhmm) kinds.push('end');
      kinds.forEach(k => {
        const key = c.id + '|' + k + '|' + d + '|' + hhmm;
        if (fired[key]) return;
        fired[key] = 1;
        lines.push((k === 'end' ? '완료 ' + c.end : '시작 ' + c.start) + ' · ' + c.title);
      });
    });
  }
  if (!lines.length) return;
  const keys = Object.keys(fired); if (keys.length > 300) keys.slice(0, keys.length - 150).forEach(k => delete fired[k]);
  saveKey(KEY_FIRED, fired);
  ring(lines, false);
}
// 끝 시각이 지난 카드는 버튼을 누르지 않아도 자동으로 완료로 바꾼다(끝 시각이 없는 카드는 그대로). 완료 알림이 먼저 울린 뒤에 완료 처리한다.
function autoDone() {
  if (drag) return;
  const t = todayStr(), now = nowHM();
  let ch = false;
  cards.forEach(c => { if (!c.done && c.end && (c.date < t || (c.date === t && c.end <= now))) { c.done = true; ch = true; } });
  if (ch) { save(); render(); }
}
function tickAll() { alarmTick(); autoDone(); }
setInterval(tickAll, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { dayRoll(); tickAll(); } });
$('a-mode').value = aset.mode; $('a-end').checked = aset.end; $('a-gcal').checked = aset.gcal;
$('a-mode').onchange = () => { aset.mode = MODES.includes($('a-mode').value) ? $('a-mode').value : 'both'; saveKey(KEY_ALARM, aset); };
$('a-end').onchange = () => { aset.end = $('a-end').checked; saveKey(KEY_ALARM, aset); };
$('a-gcal').onchange = () => { aset.gcal = $('a-gcal').checked; saveKey(KEY_ALARM, aset); $('a-note').textContent = '이 설정은 앞으로 만들거나 다시 저장하는 카드의 구글 일정에 반영됩니다(이미 올라간 일정은 카드를 열어 다시 저장하면 바뀝니다).'; };
$('a-test').onclick = () => { unlockAudio(); ring(['알림 시험입니다'], true); };
function updatePerm() { $('a-perm').hidden = !('Notification' in window && window.isSecureContext && Notification.permission === 'default'); }
$('a-perm').onclick = () => { Notification.requestPermission().then(updatePerm).catch(() => {}); };
updatePerm();
$('a-note').textContent = '이 앱의 소리·진동은 앱 화면을 켜 둔 동안만 울립니다. 폰 화면이 꺼지거나 앱을 닫으면 브라우저가 멈춰서 웹앱은 진동·소리를 낼 수 없습니다(폰의 규칙). 화면이 꺼져도 울리려면 ① 카드 입력창의 "시계 앱 알람"(시작·완료 시각 모두, 안드로이드) 또는 ② 위의 "구글 캘린더에도 시작 알림 넣기"(시작 시각만)를 쓰세요. 소리·진동은 앱을 연 뒤 화면을 한 번 눌러야 켜집니다.';
showHeader();
// 홈 화면 설치·오프라인: 인터넷 주소(https)나 이 PC(localhost)에서만 동작한다
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 등록 실패해도 앱은 그대로 쓴다 */ });
}
updateGUi();
if ((gset.clientId || '').trim()) loadGis(() => {}, () => {}); // 로그인 버튼을 눌렀을 때 창이 바로 열리도록 미리 불러 둔다
render();
tickAll();
