'use strict';
// 수영!일해야지! — 보고 탭 1단계(현장조사): 클로바노트 글자 + 사진 → 시간순 초안 PDF.
// 모든 처리는 이 폰 안에서만 한다(외부 서비스·AI 없음). 사진은 IndexedDB, 보고 정보는 localStorage에 저장한다.
// 앱은 PDF를 자동으로 보내지 않는다. 내보내기를 누르면 폰의 공유 화면이 열리고, 보내는 것은 소장이 직접 한다.
(function () {
  const root = document.getElementById('rp-root');
  if (!root) return;

  const KEY_R = 'suyoung_reports_v1';      // [{id, kind, site, date, start, attendees, raw, sentences, photos(메타), created, exported}]
  const KEY_K = 'suyoung_rkinds_v1';       // 보고 종류 이름 목록
  const KEY_S = 'suyoung_rset_v1';         // { gap: 같은 뷰로 묶는 초 }
  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const KEY_KM = 'suyoung_rkmeta_v1';      // 종류별 { icon, tpl } (양식 성격). 이 값이 없는 옛 종류는 이름으로 양식을 짐작한다
  // 종류를 만들 때 고르는 성격(= 보고서 양식)과 아이콘
  const TPLS = [['site', '현장조사형', '시간별 기록과 사진'], ['meet', '회의형', '논의·결정·할 일로 나눔'], ['call', '통화형', '통화 내용과 핵심 요약'], ['memo', '자유메모형', '제목과 글, 사진']];
  const ICON_DEF = { site: '🏗️', meet: '👥', call: '📞', memo: '📝' };
  const ICONS = ['🏗️', '🏠', '🚧', '📐', '🔍', '📷', '👥', '🤝', '💼', '📅', '📞', '💬', '📝', '📋', '🗂️', '🧾', '📊', '✅', '📌', '🔧'];
  let kinds = lsGet(KEY_K, null); if (!Array.isArray(kinds)) kinds = ['현장조사'];
  let kmeta = lsGet(KEY_KM, {}); if (!kmeta || typeof kmeta !== 'object' || Array.isArray(kmeta)) kmeta = {};
  if (!kmeta.__seed) { // 처음 한 번만 PM회의(회의형)와 자유메모(자유메모형)를 만들어 둔다. 지워도 다시 생기지 않는다
    [['PM회의', 'meet'], ['자유메모', 'memo']].forEach(([n, t]) => { if (!kinds.includes(n)) { kinds.push(n); kmeta[n] = { icon: ICON_DEF[t], tpl: t }; } });
    kmeta.__seed = 1; lsSet(KEY_K, kinds); lsSet(KEY_KM, kmeta);
  }
  if (!kmeta.__seed2) { // 처음 한 번만 전화통화(통화형)와 현장회의(회의형)를 만들어 둔다. 지워도 다시 생기지 않는다
    [['전화통화', 'call', '📞'], ['현장회의', 'meet', '🤝']].forEach(([n, t, ic]) => { if (!kinds.includes(n)) { kinds.push(n); kmeta[n] = { icon: ic, tpl: t }; } });
    kmeta.__seed2 = 1; lsSet(KEY_K, kinds); lsSet(KEY_KM, kmeta);
  }
  let kindSel = null;      // null이면 종류 아이콘 화면, 이름이면 그 종류 안(보고 목록)
  let newIcon = '', newTpl = 'site'; // 종류 만들기 화면에서 고른 값
  let set = Object.assign({ gap: 10, warnDate: true }, lsGet(KEY_S, {}));
  let reports = lsGet(KEY_R, []); if (!Array.isArray(reports)) reports = [];
  let cur = null;          // 편집 중인 보고(사진은 blob 포함)
  let step = 1;
  let urls = new Map();    // 사진 id -> 화면용 주소
  let pdfCache = null;     // 미리보기에서 만든 쪽 캔버스
  let busy = false;

  // ---------- 저장(사진 = IndexedDB) ----------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const q = indexedDB.open('suyoung_report_db', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('photos');
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    return dbp;
  }
  const idb = (mode, fn) => db().then((d) => new Promise((res, rej) => {
    const t = d.transaction('photos', mode); const r = fn(t.objectStore('photos'));
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
  const putPhoto = (id, blob) => idb('readwrite', (s) => s.put(blob, id));
  const getPhoto = (id) => idb('readonly', (s) => s.get(id));
  const delPhoto = (id) => idb('readwrite', (s) => s.delete(id));

  function metaOf(r) {
    return {
      id: r.id, kind: r.kind, site: r.site, date: r.date, start: r.start, attendees: r.attendees, raw: r.raw,
      place: r.place || '', agenda: r.agenda || '', party: r.party || '', phone: r.phone || '', dur: Number(r.dur) || 0,
      dir: r.dir || '', author: r.author || '', sum: Object.assign({}, r.sum || {}),
      sentences: r.sentences, created: r.created, exported: r.exported || '', deleted: r.deleted || 0,
      photos: r.photos.map((p) => ({ id: p.id, ts: p.ts, w: p.w, h: p.h, sharp: p.sharp, mean: p.mean, dark: p.dark, bright: p.bright, sel: !!p.sel, manual: !!p.manual, skip: !!p.skip, grp: p.grp })),
    };
  }
  function saveCur() {
    if (!cur) return;
    const i = reports.findIndex((x) => x.id === cur.id), m = metaOf(cur);
    if (i >= 0) reports[i] = m; else reports.unshift(m);
    if (!lsSet(KEY_R, reports)) toast('저장 공간이 부족합니다. 오래된 보고를 지워 주세요.');
  }

  // ---------- 작은 안내 ----------
  let toastT = 0;
  function toast(msg) {
    let t = document.getElementById('rp-toast');
    if (!t) { t = document.createElement('div'); t.id = 'rp-toast'; t.className = 'rp-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---------- 클로바노트 글자 → 문장 ----------
  const BAD = ['씨발', '시발', '씨바', '시바', '쉬발', '씹', '병신', '개새끼', '새끼', '좆', '좃', '존나', '지랄', '염병', 'ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅈㄹ', 'ㅈㄴ', '미친놈', '미친년', '미친 놈', '미친 년', '썅', '개놈', '엿먹', '닥쳐', '꺼져'];
  const isBad = (s) => { const t = s.replace(/시발점|시발역|시발지|시바견/g, ''); return BAD.some((w) => t.includes(w)); }; // 공사 용어 '시발점'은 제외
  function splitSentences(txt) {
    return txt.split(/(?<=[.!?。？！])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  }
  function parseClova(raw) {
    const text = raw.replace(/\r/g, '');
    const info = {};
    const hm = text.match(/(\d{4})\.\s?(\d{1,2})\.\s?(\d{1,2})[^\n]*?(오전|오후)\s*(\d{1,2}):(\d{2})/);
    if (hm) {
      let h = Number(hm[5]) % 12; if (hm[4] === '오후') h += 12;
      info.date = hm[1] + '-' + pad(hm[2]) + '-' + pad(hm[3]); info.start = pad(h) + ':' + hm[6] + ':00';
    }
    const dm = text.match(/[・·]\s*(?:(\d+)\s*시간\s*)?(?:(\d+)\s*분\s*)?(\d+)\s*초/);
    const total = dm ? (Number(dm[1] || 0) * 3600 + Number(dm[2] || 0) * 60 + Number(dm[3])) : 0;
    const blocks = []; let b = null;
    for (const ln of text.split('\n')) {
      const m = ln.match(/^\s*(\S+(?:\s\S+)?)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/);
      if (m && m[1].length <= 12 && !/[.!?]$/.test(m[1])) {
        const t = m[4] != null ? Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]) : Number(m[2]) * 60 + Number(m[3]);
        b = { t, sp: m[1], lines: [] }; blocks.push(b); continue;
      }
      if (!b) continue;
      if (/clovanote\.naver\.com/i.test(ln)) continue;
      if (ln.trim()) b.lines.push(ln.trim());
    }
    const out = [];
    if (!blocks.length) { // 시각 표시가 없는 글자: 전부 0초로 둔다
      splitSentences(text.trim()).forEach((s) => out.push({ t: 0, txt: s }));
    } else {
      blocks.forEach((bk, i) => {
        const ss = splitSentences(bk.lines.join(' '));
        const end = i + 1 < blocks.length ? blocks[i + 1].t : (total > bk.t ? total : bk.t);
        ss.forEach((s, j) => out.push({ t: Math.round(bk.t + (end - bk.t) * (j / Math.max(1, ss.length))), txt: s, sp: bk.sp }));
      });
    }
    info.total = total;
    return { info, sentences: out.map((s) => ({ t: s.t, txt: s.txt, sp: s.sp || '', cat: 'disc', flag: isBad(s.txt), on: false })) };
  }
  // 클로바노트의 말한 사람 표시: 참석자 1 = 나(소장), 참석자 2 = 상대방. 그 밖의 이름은 그대로 쓴다.
  function spLabel(sp) {
    const m = String(sp || '').match(/^참석자\s*(\d+)$/);
    if (!m) return String(sp || '');
    return '참석자' + m[1] + (m[1] === '1' ? '(나)' : m[1] === '2' ? '(상대방)' : '');
  }
  function speakersOf(r) { // 글에 나온 말한 사람을 처음 나온 순서로
    const seen = []; r.sentences.forEach((s) => { if (s.sp && !seen.includes(s.sp)) seen.push(s.sp); });
    return seen.map(spLabel).sort().join(', ');
  }

  // ---------- 사진 읽기: 촬영 시각, 크기 줄이기, 선명도·밝기 ----------
  async function exifTime(file) {
    try {
      const v = new DataView(await file.slice(0, 131072).arrayBuffer());
      if (v.getUint16(0) !== 0xFFD8) return null;
      let o = 2;
      while (o < v.byteLength - 4) {
        const mk = v.getUint16(o), len = v.getUint16(o + 2);
        if (mk === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) {
          const t = o + 10, le = v.getUint16(t) === 0x4949;
          const g16 = (p) => v.getUint16(p, le), g32 = (p) => v.getUint32(p, le);
          const find = (ifd, tag) => { const n = g16(ifd); for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (g16(e) === tag) return e; } return -1; };
          const ex = find(t + g32(t + 4), 0x8769); if (ex < 0) return null;
          const dt = find(t + g32(ex + 8), 0x9003); if (dt < 0) return null;
          const off = t + g32(dt + 8); let s = '';
          for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(off + i));
          const m = s.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)$/);
          return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
        }
        if (mk === 0xFFDA) break;
        o += 2 + len;
      }
    } catch (e) { /* 시각을 못 읽으면 다음 방법으로 */ }
    return null;
  }
  function nameTime(name) {
    const m = name.match(/(20\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  }
  function quality(bmp) {
    const W = 192, H = Math.max(24, Math.round(bmp.height * W / bmp.width));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
    let sum = 0, dark = 0, bright = 0;
    for (let i = 0; i < W * H; i++) {
      const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; g[i] = v; sum += v;
      if (v < 30) dark++; if (v > 235) bright++;
    }
    const lap = (x0, x1, y0, y1) => {
      let s = 0, s2 = 0, n = 0;
      for (let yy = Math.max(1, y0); yy < Math.min(H - 1, y1); yy++) for (let xx = Math.max(1, x0); xx < Math.min(W - 1, x1); xx++) {
        const i = yy * W + xx, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W];
        s += l; s2 += l * l; n++;
      }
      return n ? s2 / n - (s / n) * (s / n) : 0;
    };
    const all = lap(0, W, 0, H), mid = lap(W * 0.25, W * 0.75, H * 0.25, H * 0.75); // 가운데(찍은 대상)를 더 크게 본다
    return { sharp: 0.6 * mid + 0.4 * all, mean: sum / (W * H), dark: dark / (W * H), bright: bright / (W * H) };
  }
  async function prepPhoto(file) {
    const ts = (await exifTime(file)) || nameTime(file.name) || file.lastModified || Date.now();
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(file); }
    const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    const q = quality(bmp); if (bmp.close) bmp.close();
    return Object.assign({ id: uid(), ts, blob, w, h, sel: false, manual: false, skip: false, grp: 0 }, q);
  }

  // ---------- 같은 뷰 묶기와 가장 좋은 한 장 고르기 ----------
  function regroup() {
    const ps = cur.photos.sort((a, b) => a.ts - b.ts), gap = Math.max(1, Number(set.gap) || 10) * 1000;
    let g = 0; ps.forEach((p, i) => { if (i && p.ts - ps[i - 1].ts > gap) g++; p.grp = g; });
    for (let k = 0; k <= g; k++) {
      const m = ps.filter((p) => p.grp === k); if (!m.length) continue;
      const maxS = Math.max(...m.map((p) => p.sharp), 1e-6);
      m.forEach((p) => {
        const expo = Math.max(0.3, 1 - Math.abs(p.mean - 125) / 160) * (1 - Math.min(0.5, p.dark + p.bright));
        p.score = (p.sharp / maxS) * 0.65 + expo * 0.35; p.rel = Math.round((p.sharp / maxS) * 100);
      });
      const man = m.find((p) => p.sel && p.manual);
      const best = man || m.slice().sort((a, b) => b.score - a.score)[0];
      const skip = m.every((p) => p.skip);
      m.forEach((p) => { p.sel = p === best; p.skip = skip; });
    }
  }
  const groupsOf = () => { const o = []; cur.photos.forEach((p) => { (o[p.grp] = o[p.grp] || []).push(p); }); return o.filter(Boolean); };
  const urlOf = (p) => { if (!urls.has(p.id)) urls.set(p.id, URL.createObjectURL(p.blob)); return urls.get(p.id); };
  const clearUrls = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = new Map(); };

  // ---------- 시각 표시 ----------
  const hms = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  const mmss = (t) => pad(Math.floor(t / 60)) + ':' + pad(t % 60);
  const baseTs = (r) => { if (!r.date || !r.start) return null; const v = new Date(r.date + 'T' + (r.start.length === 5 ? r.start + ':00' : r.start)).getTime(); return isNaN(v) ? null : v; };
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  function dateKo(r) {
    if (!r.date) return '[ 미기입 ]'; const d = new Date(r.date + 'T00:00:00');
    return r.date.replace(/-/g, '.') + '(' + DOW[d.getDay()] + ')' + (r.start ? ' ' + r.start.slice(0, 5) : '');
  }
  // 보고 양식: 종류를 만들 때 고른 성격을 쓴다. 성격이 없는 옛 종류는 이름에 '통화'가 들어가면 통화기록, '회의'가 들어가면 회의록, 그 밖에는 현장 보고
  const kmOf = (k) => (Object.prototype.hasOwnProperty.call(kmeta, k) && kmeta[k] && TPLS.some((t) => t[0] === kmeta[k].tpl)) ? kmeta[k] : null;
  const tplOf = (kind) => { const k = String(kind || ''), m = kmOf(k); return m ? m.tpl : k.includes('통화') ? 'call' : k.includes('회의') ? 'meet' : 'site'; };
  const iconOf = (k) => { const m = kmOf(k); return (m && m.icon) || ICON_DEF[tplOf(k)]; };
  const CATS = [['disc', '논의'], ['decide', '결정'], ['todo', '할 일']];
  const SUMS = [['goal', '목적'], ['main', '주요 내용'], ['agree', '확인·합의 사항'], ['next', '후속 조치']]; // 통화기록 핵심 요약 틀
  const SUMS_MEET = [['goal', '회의 목적'], ['main', '핵심 논의'], ['agree', '미결 사항'], ['next', '다음 회의·일정']]; // 회의 요약 틀(저장 키는 통화와 같다)
  const sumsOf = (t) => t === 'meet' ? SUMS_MEET : SUMS;
  const cleanSum = (o) => { const s = {}; SUMS.forEach(([k]) => { s[k] = o && typeof o[k] === 'string' ? o[k].slice(0, 600) : ''; }); return s; };
  const KEY_AU = 'suyoung_rauthor_v1'; // 마지막에 쓴 작성자 이름
  const lastAuthor = () => { try { return localStorage.getItem(KEY_AU) || '이수영'; } catch (e) { return '이수영'; } };
  const catOf = (s) => CATS.some((c) => c[0] === s.cat) ? s.cat : 'disc';
  const dateDot = (ts) => { const d = new Date(Number(ts) || Date.now()); return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()); };
  function durKo(r) {
    const t = Math.round(Number(r.dur) || r.sentences.reduce((m, s) => Math.max(m, s.t), 0));
    if (!(t > 0) || !isFinite(t) || t > 86400 * 2) return '[ 미기입 ]';
    const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return (h ? h + '시간 ' : '') + (m || h ? m + '분 ' : '') + s + '초';
  }
  function timeline(r) {
    const base = baseTs(r), a = []; let n = 0;
    r.sentences.forEach((s) => { if (s.on) a.push({ k: 's', n: n++, ts: base != null ? base + s.t * 1000 : s.t * 1000, txt: s.txt, sp: s.sp || '', cat: catOf(s) }); });
    r.photos.forEach((p) => { if (p.sel && !p.skip) a.push({ k: 'p', n: n++, ts: p.ts, p }); });
    // 같은 시각이면 문장이 사진보다 먼저, 같은 종류끼리는 말한 순서를 지킨다
    return a.sort((x, y) => x.ts - y.ts || (x.k === y.k ? x.n - y.n : (x.k === 's' ? -1 : 1)));
  }

  // ---------- 쪽 그리기(A4, 150dpi) → PDF ----------
  async function renderPages(r) {
    const W = 1240, H = 1754, M = 110, FOOT = 80, FONT = '"Malgun Gothic","Noto Sans KR",sans-serif';
    const pages = []; let c, x, y;
    const newPage = () => {
      c = document.createElement('canvas'); c.width = W; c.height = H; x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.textBaseline = 'top'; pages.push(c); y = M;
      // 그린 글자를 쪽마다 기록해 두었다가 PDF에 보이지 않는 글자 층으로 넣는다(복사·검색용)
      const cv = c, cx = x, runs = cv._runs = [], ft = cx.fillText.bind(cx);
      cx.fillText = (t, px, py, mw) => {
        const s = String(t), m = /(\d+(?:\.\d+)?)px/.exec(cx.font);
        if (s.trim() && m) runs.push({ t: s, x: px, y: py, s: Number(m[1]), w: cx.measureText(s).width, a: cx.textAlign });
        ft(t, px, py, mw);
      };
    };
    const need = (h) => { if (y + h > H - M - FOOT + 40) newPage(); };
    const wrap = (t, maxW) => {
      const out = []; let ln = '';
      for (const ch of t) { const nx = ln + ch; if (x.measureText(nx).width > maxW && ln) { out.push(ln); ln = ch === ' ' ? '' : ch; } else ln = nx; }
      if (ln) out.push(ln); return out;
    };
    const bmps = new Map();
    for (const p of r.photos) if (p.sel && !p.skip) { try { bmps.set(p.id, await createImageBitmap(p.blob)); } catch (e) { /* 건너뜀 */ } }
    const tpl = tplOf(r.kind), NA = '[ 미기입 ]';
    newPage();
    x.fillStyle = '#2d5a49'; x.font = 'bold 54px ' + FONT; x.fillText(tpl === 'site' ? r.kind + ' 보고' : tpl === 'call' ? '통화기록' : r.kind, M, y);
    x.strokeStyle = tpl === 'call' ? '#2d5a49' : '#d9776b'; x.lineWidth = 3; x.strokeRect(W - M - 110, y + 2, 110, 56);
    x.fillStyle = tpl === 'call' ? '#2d5a49' : '#b5594d'; x.font = 'bold 32px ' + FONT; x.fillText(tpl === 'call' ? '기록' : '초안', W - M - 82, y + 12);
    y += 86;
    x.fillStyle = '#7b847e'; x.font = '26px ' + FONT;
    x.fillText(tpl === 'call' ? '통화 내용을 말한 그대로, 시간 순서대로 남긴 기록입니다.' : tpl === 'meet' ? '회의 내용을 정리한 초안입니다. 정식 회의록은 따로 보내 드립니다.' : tpl === 'memo' ? '자유롭게 적은 메모입니다.' : '현장에서 바로 만든 초안입니다. 정식 보고서는 따로 보내 드립니다.', M, y);
    y += 64;
    const who = r.attendees || speakersOf(r) || NA;
    const rows = tpl === 'meet' ? [['회의명', r.site || NA], ['일시', dateKo(r)], ['장소', r.place || NA], ['참석자', who], ['안건', r.agenda || NA], ['작성자', (r.author || NA) + '  (작성일 ' + dateDot(r.created) + ')']]
      : tpl === 'call' ? [['건명', r.site || NA], ['통화일시', dateKo(r)], ['통화시간', durKo(r)], ['통화 유형', r.dir || NA], ['상대방', r.party || NA], ['연락처', r.phone || NA], ['참석자', who], ['작성자', (r.author || NA) + '  (작성일 ' + dateDot(r.created) + ')']]
        : tpl === 'memo' ? [['제목', r.site || NA], ['일시', dateKo(r)], ['종류', r.kind]]
          : [['현장명', r.site || NA], ['일시', dateKo(r)], ['참석자', who], ['종류', r.kind]];
    const drawRows = (arr) => arr.forEach(([k, v]) => {
      x.font = '28px ' + FONT;
      const ls = String(v).split('\n').flatMap((p) => wrap(p || ' ', W - 2 * M - 240 - 24)), h = Math.max(1, ls.length) * 40 + 24;
      need(h);
      x.fillStyle = '#eef3f0'; x.fillRect(M, y, 220, h); x.strokeStyle = '#cfd6d0'; x.lineWidth = 2; x.strokeRect(M, y, W - 2 * M, h); x.beginPath(); x.moveTo(M + 220, y); x.lineTo(M + 220, y + h); x.stroke();
      x.fillStyle = '#2d5a49'; x.font = 'bold 28px ' + FONT; x.fillText(k, M + 16, y + 12);
      x.fillStyle = '#26302d'; x.font = '28px ' + FONT; ls.forEach((l, i) => x.fillText(l, M + 240, y + 12 + i * 40));
      y += h;
    });
    drawRows(rows);
    // 제목만 쪽 맨 아래에 홀로 남지 않게 아래 내용 자리까지 함께 확인한다(need 200)
    const heading = (t) => { y += 50; need(250); x.fillStyle = '#2d5a49'; x.font = 'bold 38px ' + FONT; x.fillText(t, M, y); y += 70; };
    const none = (t) => { x.fillStyle = '#9aa39d'; x.font = '28px ' + FONT; x.fillText(t, M, y); y += 60; };
    if (tpl === 'call' || tpl === 'meet') { // 핵심 요약: 칸을 하나라도 채웠을 때만 넣는다
      const sr = sumsOf(tpl).map(([k, t]) => [t, String((r.sum && r.sum[k]) || '').trim()]);
      if (sr.some((q) => q[1])) {
        heading(tpl === 'meet' ? '회의 요약' : '핵심 요약'); drawRows(sr.map(([t, v]) => [t, v || NA]));
        x.font = '22px ' + FONT; const sn = wrap(tpl === 'meet' ? '※ 위 요약은 작성자가 정리한 것이며, 회의 내용은 아래 논의·결정·할 일을 따릅니다.' : '※ 위 요약은 작성자가 정리한 것이며, 원문은 아래 "통화 내용"을 따릅니다.', W - 2 * M);
        y += 14; need(sn.length * 32 + 10); x.fillStyle = '#9aa39d'; sn.forEach((l, j) => x.fillText(l, M, y + j * 32)); y += sn.length * 32;
      }
    }
    const items = timeline(r), base = baseTs(r);
    const drawItems = (list, opt) => {
      let lastSp = null, seenPg = pages.length; // 말한 사람이 바뀔 때(또는 사진 뒤, 새 쪽 첫 줄)에만 이름을 한 줄 적는다
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (it.k === 's') {
          x.font = '28px ' + FONT;
          const ls = wrap((opt && opt.todo ? '□ ' : '') + it.txt, W - 2 * M - 210), extra = opt && opt.todo ? 36 : 0, h = ls.length * 42 + 16 + (it.sp ? 40 : 0) + extra;
          need(h);
          if (pages.length !== seenPg) { seenPg = pages.length; lastSp = null; } // 새 쪽이 시작되면 이름을 다시 적는다
          const showSp = !!it.sp && it.sp !== lastSp;
          if (showSp) {
            x.fillStyle = it.sp === '참석자 1' || it.sp === '참석자1' ? '#2d5a49' : '#b5594d'; x.font = 'bold 26px ' + FONT; x.fillText(spLabel(it.sp), M + 210, y + 4);
            y += 40;
          }
          lastSp = it.sp || null;
          x.fillStyle = '#7b847e'; x.font = '24px ' + FONT; x.fillText(base != null ? hms(it.ts) : mmss(Math.round(it.ts / 1000)), M, y + 6);
          x.fillStyle = '#26302d'; x.font = '28px ' + FONT; ls.forEach((l, j) => x.fillText(l, M + 210, y + j * 42));
          y += ls.length * 42 + 16;
          if (extra) { x.fillStyle = '#9aa39d'; x.font = '22px ' + FONT; x.fillText('담당 [ 미기입 ]   기한 [ 미기입 ]', M + 210, y); y += extra; }
        } else {
          lastSp = null;
          const row = [it]; if (list[i + 1] && list[i + 1].k === 'p') { row.push(list[i + 1]); i++; }
          const bw = (W - 2 * M - 24) / 2, bh = 620;
          const sz = row.map((q) => { const b = bmps.get(q.p.id); if (!b) return { w: 0, h: 0 }; const s = Math.min(bw / b.width, bh / b.height); return { w: b.width * s, h: b.height * s }; });
          const rh = Math.max(...sz.map((s) => s.h)) + 56; need(rh);
          row.forEach((q, j) => {
            const b = bmps.get(q.p.id), px = M + j * (bw + 24); if (!b) return;
            x.drawImage(b, px, y, sz[j].w, sz[j].h);
            x.fillStyle = '#7b847e'; x.font = '24px ' + FONT; x.fillText(hms(q.ts), px, y + sz[j].h + 10);
          });
          y += rh;
        }
      }
    };
    if (tpl === 'meet') {
      [['1. 논의 내용', 'disc'], ['2. 결정사항', 'decide'], ['3. 다음 할 일', 'todo']].forEach(([t, cat]) => {
        heading(t);
        const l = items.filter((q) => q.k === 's' && q.cat === cat);
        if (!l.length) none('내용 없음'); else drawItems(l, { todo: cat === 'todo' });
      });
      const ph = items.filter((q) => q.k === 'p');
      if (ph.length) { heading('첨부 사진'); drawItems(ph); }
    } else {
      heading(tpl === 'call' ? '통화 내용' : tpl === 'memo' ? '내용' : '시간별 기록');
      if (!items.length) none('선택한 문장과 사진이 없습니다.'); else drawItems(items);
      if (tpl === 'call') {
        x.font = '22px ' + FONT; const nl = wrap('※ 이 기록은 통화 녹음을 자동으로 글자로 바꾼 것이라 잘못 옮겨진 글자가 있을 수 있습니다.', W - 2 * M);
        y += 20; need(nl.length * 32 + 10); x.fillStyle = '#9aa39d'; nl.forEach((l, j) => x.fillText(l, M, y + j * 32)); y += nl.length * 32;
      }
    }
    const foot = tpl === 'call' ? '통화기록' : tpl === 'meet' ? '회의록 초안' : tpl === 'memo' ? '메모' : '초안';
    pages.forEach((pg, i) => { const g = pg.getContext('2d'); g.fillStyle = '#9aa39d'; g.font = '22px ' + FONT; g.textBaseline = 'top'; g.textAlign = 'center'; g.fillText(foot + ' · ' + (i + 1) + ' / ' + pages.length, W / 2, H - 80); g.textAlign = 'left'; });
    bmps.forEach((b) => { if (b.close) b.close(); });
    return pages;
  }
  const jpgOf = (cv, q) => new Promise((res) => cv.toBlob((b) => b.arrayBuffer().then((a) => res(new Uint8Array(a))), 'image/jpeg', q));
  async function makePdf(pages) {
    const enc = new TextEncoder(), parts = [], xref = []; let off = 0;
    const w = (s) => { const b = typeof s === 'string' ? enc.encode(s) : s; parts.push(b); off += b.length; };
    const jpgs = []; for (const p of pages) jpgs.push(await jpgOf(p, 0.88));
    const n = pages.length, FB = 3 + n * 3, size = FB + 4; // FB.. = 글자 층용 글꼴 개체 4개
    // 글자 층: 모양은 그림 그대로 두고, 같은 자리에 보이지 않는 글자(Tr 3)를 얹는다. 글자마다 번호(CID)를 매기고 ToUnicode로 실제 글자를 알려 준다.
    const cidOf = new Map(), uni = [0];
    const cid = (cp) => { let v = cidOf.get(cp); if (!v) { v = uni.length; uni.push(cp); cidOf.set(cp, v); } return v; };
    const hex4 = (v) => v.toString(16).padStart(4, '0');
    const u16 = (cp) => cp > 0xFFFF ? hex4(0xD800 + ((cp - 0x10000) >> 10)) + hex4(0xDC00 + ((cp - 0x10000) & 0x3FF)) : hex4(cp);
    const K = 595.28 / 1240; // 화면 픽셀 -> PDF 포인트
    const textOf = (pg) => {
      let o = '';
      (pg._runs || []).forEach((r) => {
        const cps = Array.from(r.t).map((ch) => ch.codePointAt(0)).filter((cp) => cp >= 32 && cp !== 0x7f && cp < 0x110000 && !(cp >= 0xD800 && cp <= 0xDFFF) && uni.length < 60000);
        if (!cps.length || !(r.s > 0) || !(r.w > 0)) return;
        const tz = Math.max(10, Math.min(400, r.w / (cps.length * r.s) * 100)), xp = (r.a === 'center' ? r.x - r.w / 2 : r.a === 'right' ? r.x - r.w : r.x) * K, yp = 841.89 - (r.y + r.s * 0.82) * K;
        o += '/F1 ' + (r.s * K).toFixed(2) + ' Tf ' + tz.toFixed(1) + ' Tz 1 0 0 1 ' + xp.toFixed(2) + ' ' + yp.toFixed(2) + ' Tm <' + cps.map((cp) => hex4(cid(cp))).join('') + '> Tj\n';
      });
      return o ? 'BT 3 Tr\n' + o + 'ET' : '';
    };
    const texts = pages.map(textOf);
    const obj = (num, fn) => { xref[num] = off; w(num + ' 0 obj\n'); fn(); w('\nendobj\n'); };
    w('%PDF-1.4\n');
    obj(1, () => w('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => w('<< /Type /Pages /Kids [' + pages.map((_, i) => (3 + i * 3) + ' 0 R').join(' ') + '] /Count ' + n + ' >>'));
    pages.forEach((p, i) => {
      const pg = 3 + i * 3, ct = pg + 1, im = pg + 2, cs = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q\n' + texts[i];
      obj(pg, () => w('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ' + im + ' 0 R >> /Font << /F1 ' + FB + ' 0 R >> >> /Contents ' + ct + ' 0 R >>'));
      obj(ct, () => w('<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream'));
      obj(im, () => { w('<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpgs[i].length + ' >>\nstream\n'); w(jpgs[i]); w('\nendstream'); });
    });
    // 글자 층 글꼴: 글꼴 파일은 넣지 않는다(보이지 않는 글자라 그릴 필요가 없다). 복사·검색에는 ToUnicode가 쓰인다.
    obj(FB, () => w('<< /Type /Font /Subtype /Type0 /BaseFont /MalgunGothic /Encoding /Identity-H /DescendantFonts [' + (FB + 1) + ' 0 R] /ToUnicode ' + (FB + 3) + ' 0 R >>'));
    obj(FB + 1, () => w('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /MalgunGothic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ' + (FB + 2) + ' 0 R /DW 1000 /CIDToGIDMap /Identity >>'));
    obj(FB + 2, () => w('<< /Type /FontDescriptor /FontName /MalgunGothic /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>'));
    obj(FB + 3, () => {
      let cm = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
      for (let i = 1; i < uni.length; i += 100) {
        const part = uni.slice(i, Math.min(uni.length, i + 100));
        cm += part.length + ' beginbfchar\n' + part.map((cp, j) => '<' + hex4(i + j) + '> <' + u16(cp) + '>').join('\n') + '\nendbfchar\n';
      }
      cm += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
      w('<< /Length ' + cm.length + ' >>\nstream\n' + cm + '\nendstream');
    });
    const start = off;
    let x = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
    for (let i = 1; i < size; i++) x += String(xref[i]).padStart(10, '0') + ' 00000 n \n';
    w(x + 'trailer\n<< /Size ' + size + ' /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF');
    return new Blob(parts, { type: 'application/pdf' });
  }

  // ---------- 묶음(zip, 압축 없이 담기) ----------
  const CRCT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u) => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRCT[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(files) {
    const enc = new TextEncoder(), out = [], cen = []; let off = 0;
    files.forEach((f) => {
      const nm = enc.encode(f.name), crc = crc32(f.data), L = new DataView(new ArrayBuffer(30)), C = new DataView(new ArrayBuffer(46));
      L.setUint32(0, 0x04034b50, true); L.setUint16(4, 20, true); L.setUint16(6, 0x0800, true); L.setUint16(10, 0, true); L.setUint16(12, 33, true);
      L.setUint32(14, crc, true); L.setUint32(18, f.data.length, true); L.setUint32(22, f.data.length, true); L.setUint16(26, nm.length, true);
      C.setUint32(0, 0x02014b50, true); C.setUint16(4, 20, true); C.setUint16(6, 20, true); C.setUint16(8, 0x0800, true); C.setUint16(14, 33, true);
      C.setUint32(16, crc, true); C.setUint32(20, f.data.length, true); C.setUint32(24, f.data.length, true); C.setUint16(28, nm.length, true); C.setUint32(42, off, true);
      out.push(new Uint8Array(L.buffer), nm, f.data); cen.push(new Uint8Array(C.buffer), nm); off += 30 + nm.length + f.data.length;
    });
    let cs = 0; cen.forEach((b) => { cs += b.length; });
    const E = new DataView(new ArrayBuffer(22)); E.setUint32(0, 0x06054b50, true); E.setUint16(8, files.length, true); E.setUint16(10, files.length, true); E.setUint32(12, cs, true); E.setUint32(16, off, true);
    return new Blob([...out, ...cen, new Uint8Array(E.buffer)], { type: 'application/zip' });
  }
  async function deliver(blob, name) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); return 'saved';
  }
  const safeName = (s) => (s || '현장').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
  const fileBase = (r) => (r.date || 'nodate').replace(/-/g, '') + '_' + safeName(r.site);

  // ---------- 화면: 종류 아이콘 → 종류 안 목록 ----------
  let showTrash = false, showKinds = false;
  const liveOf = (k) => reports.filter((r) => !r.deleted && r.kind === k);
  // 종류 목록에서 지워졌어도 보고가 남아 있으면 아이콘이 계속 보이게 한다(보고가 숨지 않게)
  const allKinds = () => kinds.concat(Array.from(new Set(reports.filter((r) => !r.deleted && !kinds.includes(r.kind)).map((r) => r.kind))));
  const TRASH_SVG = '<svg viewBox="0 0 24 26" aria-hidden="true"><path d="M5 8h14l-1.2 14a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M3.5 5.5h17M9.5 5.5V3.2h5v2.3M10 12l4 8M14 12l-4 8"/></svg>';
  const card = (r, trash) => {
    const ns = r.sentences.filter((s) => s.on).length, np = r.photos.filter((p) => p.sel && !p.skip).length;
    return '<div class="rp-card"' + (trash ? '' : ' data-id="' + r.id + '"') + '><div class="rp-row"><b>' + esc(r.site || '(제목 없음)') + '</b>' + (r.exported ? '<span class="rp-tag g">PDF 내보냄</span>' : '<span class="rp-tag">초안</span>') + '</div>' +
      '<div class="rp-meta">' + esc(trash ? r.kind + ' · ' : '') + esc(r.date ? r.date.slice(5).replace('-', '.') : '') + ' · 사진 ' + np + ' · 문장 ' + ns + '</div>' +
      (trash ? '<div class="rp-acts"><button type="button" class="rp-del" data-restore="' + r.id + '">복원</button><button type="button" class="rp-del purge" data-purge="' + r.id + '" aria-label="완전 삭제">' + TRASH_SVG + '완전 삭제</button></div>'
        : '<div class="rp-acts"><button type="button" class="rp-del purge" data-del="' + r.id + '" aria-label="삭제">' + TRASH_SVG + '삭제</button></div>') + '</div>';
  };
  // 종류 만들기: 이름 · 아이콘 · 성격(양식)
  function renderKinds() {
    document.body.classList.remove('rpt-edit');
    root.innerHTML =
      '<div class="rp-top"><div class="rp-ttl">새 종류 만들기</div><div class="rp-sub">이름·아이콘·성격을 고르면 보고서 양식이 정해져요</div></div>' +
      '<button type="button" class="rp-btn2" id="rp-kback">← 돌아가기</button>' +
      '<div class="rp-lb">이름</div>' +
      '<input type="text" id="rp-kin" maxlength="12" placeholder="예: 업무미팅" aria-label="새 종류 이름" style="font:inherit;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#fff;width:100%;box-sizing:border-box">' +
      '<div class="rp-lb">아이콘 <small>(고르지 않으면 성격에 맞는 기본 아이콘)</small></div>' +
      '<div class="rp-icons">' + ICONS.map((ic) => '<button type="button" class="rp-ic' + (ic === newIcon ? ' on' : '') + '" data-ic="' + ic + '" aria-label="아이콘 ' + ic + '">' + ic + '</button>').join('') + '</div>' +
      '<div class="rp-lb">성격 <small>(보고서 양식이 이에 맞게 만들어져요)</small></div>' +
      TPLS.map(([v, t, d]) => '<button type="button" class="rp-tp' + (v === newTpl ? ' on' : '') + '" data-tp="' + v + '"><b>' + t + '</b><small>' + d + '</small></button>').join('') +
      '<div class="rp-foot"><button type="button" class="rp-btn" id="rp-kadd">만들기</button></div>';
  }
  function renderHome() {
    const nTrash = reports.filter((r) => r.deleted).length;
    root.innerHTML =
      '<div class="rp-top"><div class="rp-ttl">보고</div><div class="rp-sub">종류를 눌러 시작하세요</div></div>' +
      '<div class="rp-tiles">' + allKinds().map((k) => '<button type="button" class="rp-tile" data-k="' + esc(k) + '"><span class="ti">' + iconOf(k) + '</span><b>' + esc(k) + '</b><small>' + liveOf(k).length + '개</small></button>').join('') +
      '<button type="button" class="rp-tile add" id="rp-addk"><span class="ti">＋</span><b>종류 추가</b></button></div>' +
      '<button type="button" class="rp-btn2 wide" id="rp-bin">휴지통 (' + nTrash + '개)</button>';
  }
  function renderKind() {
    const items = liveOf(kindSel), tp = TPLS.find((t) => t[0] === tplOf(kindSel));
    root.innerHTML =
      '<div class="rp-top"><div class="rp-ttl"><button type="button" class="rp-back" id="rp-khome" aria-label="종류 목록으로">‹</button>' + iconOf(kindSel) + ' ' + esc(kindSel) + '</div><div class="rp-sub">' + (tp ? tp[1] + ' · ' + tp[2] : '') + '</div></div>' +
      '<button type="button" class="rp-btn" id="rp-new">+ 새 ' + esc(kindSel) + (tplOf(kindSel) === 'site' ? ' 보고' : '') + '</button>' +
      '<div class="rp-lb">보고 ' + items.length + '개 <small>· 삭제하면 휴지통으로 가요</small></div>' +
      (items.length ? items.map((r) => card(r, false)).join('') : '<div class="rp-empty">아직 보고가 없어요.<br>위 버튼을 눌러 시작하세요.</div>') +
      (kinds.includes(kindSel) ? '<button type="button" class="rp-btn2 wide" id="rp-kdel0">이 종류 지우기</button>' : '');
  }
  function renderTrash() {
    const items = reports.filter((r) => r.deleted);
    root.innerHTML =
      '<div class="rp-top"><div class="rp-ttl">휴지통</div><div class="rp-sub">복원하거나, 완전 삭제하면 사진까지 지워져요</div></div>' +
      '<button type="button" class="rp-btn2" id="rp-tback">← 보고로 돌아가기</button><div class="rp-lb">복원을 누르면 원래 종류로 돌아가요. 완전 삭제는 되돌릴 수 없어요.</div>' +
      (items.length ? items.map((r) => card(r, true)).join('') : '<div class="rp-empty">휴지통이 비어 있어요.</div>');
  }
  function renderList() {
    document.body.classList.remove('rpt-edit');
    if (kindSel && !allKinds().includes(kindSel)) kindSel = null;
    if (showKinds) renderKinds(); else if (showTrash) renderTrash(); else if (kindSel) renderKind(); else renderHome();
  }
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button,[data-id],.rp-s,.rp-ph');
    if (!t) return;
    if (t.classList.contains('rp-tile') && t.dataset.k) { kindSel = t.dataset.k; renderList(); document.querySelector('main').scrollTop = 0; return; }
    if (t.id === 'rp-khome') { kindSel = null; renderList(); return; }
    if (t.id === 'rp-addk') { showKinds = true; newIcon = ''; newTpl = 'site'; renderList(); document.querySelector('main').scrollTop = 0; return; }
    if (t.id === 'rp-kback') { showKinds = false; renderList(); return; }
    if (t.dataset.ic) { newIcon = t.dataset.ic; root.querySelectorAll('.rp-ic').forEach((b) => b.classList.toggle('on', b === t)); return; }
    if (t.dataset.tp) { newTpl = t.dataset.tp; root.querySelectorAll('.rp-tp').forEach((b) => b.classList.toggle('on', b === t)); return; }
    if (t.id === 'rp-kadd') {
      const inp = document.getElementById('rp-kin'), nm = ((inp && inp.value) || '').trim().slice(0, 12);
      if (!nm) { toast('종류 이름을 적어 주세요.'); return; }
      if (allKinds().includes(nm) || nm === '__seed' || nm === '__proto__') { toast('이미 있는 종류예요.'); return; }
      kinds.push(nm); kmeta[nm] = { icon: newIcon || ICON_DEF[newTpl], tpl: newTpl }; lsSet(KEY_K, kinds); lsSet(KEY_KM, kmeta);
      showKinds = false; kindSel = null; toast('"' + nm + '" 종류를 만들었어요.'); renderList(); return;
    }
    if (t.id === 'rp-kdel0') {
      const n = liveOf(kindSel).length;
      if (n) { toast('이 종류에 보고가 ' + n + '개 있어요. 먼저 보고를 지워 주세요.'); return; }
      if (!confirm('"' + kindSel + '" 종류를 지울까요?')) return;
      const k = kindSel; kinds = kinds.filter((x) => x !== k); lsSet(KEY_K, kinds); // 아이콘·성격(kmeta)은 남겨 둔다: 휴지통의 보고를 복원해도 같은 양식으로 돌아온다
      kindSel = null; toast('"' + k + '" 종류를 지웠어요.'); renderList(); return;
    }
    if (t.id === 'rp-new') { newReport(); return; }
    if (t.id === 'rp-bin') { showTrash = true; renderList(); return; }
    if (t.id === 'rp-tback') { showTrash = false; renderList(); return; }
    if (t.dataset.del) {
      e.stopPropagation(); if (!confirm('이 보고를 휴지통으로 보낼까요? 휴지통에서 다시 꺼낼 수 있어요.')) return;
      const r = reports.find((x) => x.id === t.dataset.del); if (r) { r.deleted = Date.now(); lsSet(KEY_R, reports); toast('휴지통으로 보냈어요.'); }
      renderList(); return;
    }
    if (t.dataset.purge) { // 휴지통에서 완전히 지운다(사진 포함, 되돌릴 수 없다)
      e.stopPropagation();
      const r = reports.find((x) => x.id === t.dataset.purge); if (!r || !r.deleted) return;
      if (!confirm('"' + (r.site || '제목 없음') + '" 보고를 완전히 지울까요?\n사진도 함께 지워지고 다시 꺼낼 수 없어요.')) return;
      Promise.all((r.photos || []).map((p) => delPhoto(p.id).catch(() => null))).then(() => {
        reports = reports.filter((x) => x.id !== r.id); lsSet(KEY_R, reports); toast('완전히 지웠어요.'); renderList();
      });
      return;
    }
    if (t.dataset.restore) {
      const r = reports.find((x) => x.id === t.dataset.restore); if (r) { r.deleted = 0; lsSet(KEY_R, reports); toast('원래 종류로 복원했어요.'); }
      renderList(); return;
    }
    const cd = t.closest('.rp-card'); if (cd && cd.dataset.id && !t.matches('button')) { openReport(cd.dataset.id); return; }
  });

  // ---------- 새 보고·열기 ----------
  function newReport() {
    const d = new Date();
    cur = { id: uid(), kind: kindSel, site: '', date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), start: '', attendees: '', place: '', agenda: '', party: '', phone: '', dur: 0, dir: '', author: lastAuthor(), sum: cleanSum(null), raw: '', sentences: [], photos: [], created: Date.now(), exported: '', deleted: 0 };
    step = 1; pdfCache = null; clearUrls(); renderWiz();
  }
  async function openReport(id) {
    const m = reports.find((x) => x.id === id); if (!m) return;
    cur = JSON.parse(JSON.stringify(m)); cur.photos = []; clearUrls();
    ['place', 'agenda', 'party', 'phone'].forEach((k) => { if (typeof cur[k] !== 'string') cur[k] = ''; }); // 새 칸이 없던 옛 보고
    if (!(Number(cur.dur) > 0)) cur.dur = 0;
    if (!['', '수신', '발신'].includes(cur.dir)) cur.dir = '';
    if (typeof cur.author !== 'string') cur.author = ''; // 옛 보고는 작성자를 비워 둔다(마음대로 채우지 않는다)
    cur.sum = cleanSum(cur.sum);
    for (const pm of m.photos) { try { const blob = await getPhoto(pm.id); if (blob) cur.photos.push(Object.assign({}, pm, { blob })); } catch (e) { /* 사진 없음 */ } }
    regroup(); step = 3; pdfCache = null; renderWiz();
  }
  function leaveWiz() {
    if (!cur.site && !cur.sentences.length && !cur.photos.length) { // 아무것도 안 넣은 빈 초안은 남기지 않는다
      const i = reports.findIndex((x) => x.id === cur.id); if (i >= 0) { reports.splice(i, 1); lsSet(KEY_R, reports); }
    } else saveCur();
    cur = null; pdfCache = null; clearUrls(); renderList(); }

  // ---------- 화면: 마법사 ----------
  function renderWiz() {
    document.body.classList.add('rpt-edit');
    root.innerHTML =
      '<div class="rp-top"><div class="rp-ttl"><button type="button" class="rp-back" id="rp-back" aria-label="목록으로">‹</button>' + esc(cur.kind) + (tplOf(cur.kind) === 'site' ? ' 보고' : '') + '</div></div>' +
      '<div class="rp-steps">' + [1, 2, 3].map((n) => '<span class="' + (n <= step ? 'd' : '') + '"></span>').join('') + '</div>' +
      '<div class="rp-sn">' + ['', '1. 글자 정리', '2. 사진', '3. 미리보기와 내보내기'][step] + '</div>' +
      '<div id="rp-body"></div>';
    $q('#rp-back').onclick = leaveWiz;
    if (step === 1) wizText(); else if (step === 2) wizPhoto(); else wizPreview();
    document.querySelector('main').scrollTop = 0;
  }
  const $q = (s) => root.querySelector(s);

  function field(label, html) { return '<label class="rp-f"><span>' + label + '</span>' + html + '</label>'; }

  function wizText() {
    const tpl = tplOf(cur.kind), inp = (id, v, ml, ph) => '<input id="' + id + '" maxlength="' + ml + '" autocomplete="off" placeholder="' + (ph || '') + '" value="' + esc(v) + '">';
    $q('#rp-body').innerHTML =
      field(tpl === 'meet' ? '회의명 (현장·건명)' : tpl === 'call' ? '건명 (현장·통화 내용)' : tpl === 'memo' ? '제목' : '현장명', inp('rp-site', cur.site, 40)) +
      '<div class="rp-two f">' + field(tpl === 'call' ? '통화 날짜' : '날짜', '<input id="rp-date" type="date" value="' + esc(cur.date) + '">') + field(tpl === 'call' ? '통화 시작 시각' : tpl === 'memo' ? '시각' : '녹음 시작 시각', '<input id="rp-start" type="time" step="1" value="' + esc(cur.start) + '">') + '</div>' +
      (tpl === 'call' ? '<div class="rp-two f">' + field('상대방 (회사·성명)', inp('rp-party', cur.party, 60)) + field('연락처', inp('rp-phone', cur.phone, 30, '010-0000-0000')) + '</div>' +
        '<div class="rp-two f">' + field('통화 유형', '<select id="rp-dir">' + [['', '선택 안 함'], ['수신', '수신 (상대가 걸어옴)'], ['발신', '발신 (내가 검)']].map(([v, t]) => '<option value="' + v + '"' + (cur.dir === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>') + field('작성자', inp('rp-author', cur.author, 20)) + '</div>' : '') +
      (tpl === 'meet' ? '<div class="rp-two f">' + field('장소', inp('rp-place', cur.place, 60)) + field('작성자', inp('rp-author', cur.author, 20)) + '</div>' : '') +
      (tpl === 'memo' ? '' : field('참석자', inp('rp-att', cur.attendees, 60, tpl === 'call' ? '비우면 참석자1(나)·참석자2(상대방)으로 채워요' : ''))) +
      (tpl === 'meet' ? field('안건', inp('rp-agenda', cur.agenda, 120)) : '') +
      '<div class="rp-lb">클로바노트 글자</div>' +
      '<textarea id="rp-raw" rows="4" placeholder="여기에 붙여넣거나 txt 파일을 고르세요">' + esc(cur.raw) + '</textarea>' +
      '<div class="rp-two"><button type="button" class="rp-btn2" id="rp-paste">붙여넣기</button><button type="button" class="rp-btn2" id="rp-file">txt 선택</button></div>' +
      '<input id="rp-txt" type="file" accept=".txt,text/plain" hidden>' +
      '<button type="button" class="rp-btn2 wide" id="rp-split">문장 나누기</button>' +
      '<div class="rp-lb">' + (tpl === 'call' ? '통화 전체가 기록에 들어가요 <small>(빼고 싶은 문장만 체크를 풀어요. 문장을 눌러 켜고 끌 수 있어요)</small>'
        : tpl === 'meet' ? '넣을 문장을 체크하고 <b>논의·결정·할 일</b> 중 어디에 넣을지 고르세요 <small>(체크하지 않은 문장은 들어가지 않아요)</small>'
          : tpl === 'memo' ? '넣을 문장을 체크하세요 <small>(체크하지 않은 문장은 메모에 들어가지 않아요)</small>'
          : '넣을 문장만 체크하세요 <small>(체크하지 않은 문장은 초안에 들어가지 않아요. 욕설 표시는 목록에 있는 말만 잡아내니, 체크한 문장은 직접 한 번 더 읽어 보세요)</small>') + '</div>' +
      '<div class="rp-two"><button type="button" class="rp-btn2" id="rp-all">' + (tpl === 'site' ? '전체 선택(욕설 제외)' : '전체 선택') + '</button><button type="button" class="rp-btn2" id="rp-none">전체 해제</button></div>' +
      '<div id="rp-slist"></div>' +
      ((tpl === 'call' || tpl === 'meet') ? '<div class="rp-lb"><b>' + (tpl === 'meet' ? '회의 요약' : '핵심 요약') + '</b> <small>(첫 쪽 표 아래에 들어가요. 칸을 모두 비우면 요약 없이 만들어져요. 클로바노트 AI 요약을 붙여넣어도 돼요)</small></div>' +
        sumsOf(tpl).map(([k, t]) => field(t, '<textarea id="rp-sum-' + k + '" rows="2" maxlength="600" placeholder="' + (k === 'goal' ? (tpl === 'meet' ? '예: 외벽 마감 재료와 공정 일정 협의' : '예: 루버 부재의 생산 규격과 연결 방식 협의') : k === 'next' ? (tpl === 'meet' ? '예: 다음 회의 일시 · 준비할 자료' : '예: 누가 · 언제까지 · 무엇을') : '') + '">' + esc(cur.sum[k] || '') + '</textarea>')).join('') : '') +
      '<div class="rp-foot"><button type="button" class="rp-btn" id="rp-next">다음 · 사진</button></div>';
    const bind = (id, k) => { $q(id).oninput = () => { cur[k] = $q(id).value; }; };
    bind('#rp-site', 'site'); bind('#rp-date', 'date'); bind('#rp-start', 'start'); bind('#rp-raw', 'raw');
    [['#rp-att', 'attendees'], ['#rp-party', 'party'], ['#rp-phone', 'phone'], ['#rp-place', 'place'], ['#rp-agenda', 'agenda']].forEach(([id, k]) => { if ($q(id)) bind(id, k); });
    if ($q('#rp-dir')) $q('#rp-dir').onchange = () => { cur.dir = $q('#rp-dir').value; };
    if ($q('#rp-author')) $q('#rp-author').oninput = () => { cur.author = $q('#rp-author').value; try { localStorage.setItem(KEY_AU, cur.author); } catch (e) { /* 저장 못 해도 괜찮다 */ } };
    SUMS.forEach(([k]) => { const el = $q('#rp-sum-' + k); if (el) el.oninput = () => { cur.sum[k] = el.value; }; });
    $q('#rp-paste').onclick = async () => {
      try { const t = await navigator.clipboard.readText(); if (!t) { toast('복사된 글자가 없어요.'); return; } $q('#rp-raw').value = t; cur.raw = t; doSplit(); }
      catch (e) { toast('붙여넣기 권한이 없어요. 글자칸을 길게 눌러 붙여넣으세요.'); }
    };
    $q('#rp-file').onclick = () => $q('#rp-txt').click();
    $q('#rp-txt').onchange = async () => { const f = $q('#rp-txt').files[0]; if (!f) return; const t = await f.text(); $q('#rp-raw').value = t; cur.raw = t; $q('#rp-txt').value = ''; doSplit(); };
    $q('#rp-split').onclick = doSplit;
    $q('#rp-all').onclick = () => { cur.sentences.forEach((s) => { s.on = tpl === 'site' ? !s.flag : true; }); drawSentences(); };
    $q('#rp-none').onclick = () => { cur.sentences.forEach((s) => { s.on = false; }); drawSentences(); };
    $q('#rp-next').onclick = () => { saveCur(); step = 2; renderWiz(); };
    drawSentences();
  }
  function doSplit() {
    if (cur.sentences.some((s) => s.on) && !confirm('이미 체크한 문장이 있어요. 새로 나누면 체크가 지워져요. 계속할까요?')) return;
    const r = parseClova(cur.raw || '');
    cur.sentences = r.sentences;
    cur.dur = r.info.total || 0;
    if (tplOf(cur.kind) === 'call') cur.sentences.forEach((s) => { s.on = true; }); // 통화기록은 처음부터 전체를 넣는다
    if (r.info.date) { cur.date = r.info.date; $q('#rp-date').value = cur.date; }
    if (r.info.start) { cur.start = r.info.start; $q('#rp-start').value = cur.start; }
    drawSentences();
    toast(r.sentences.length ? '문장 ' + r.sentences.length + '개로 나눴어요.' + (r.sentences.some((s) => s.flag) ? ' 욕설이 의심되는 문장은 빨갛게 표시했어요.' : '') : '나눌 글자가 없어요.');
  }
  function drawSentences() {
    const el = $q('#rp-slist'); if (!el) return;
    el.innerHTML = cur.sentences.length ? cur.sentences.map((s, i) =>
      '<div class="rp-s' + (s.flag ? ' bad' : '') + '" data-i="' + i + '"><span class="rp-bx' + (s.on ? ' on' : '') + '">' + (s.on ? '✓' : '') + '</span>' +
      '<div class="rp-st"><span class="rp-t">' + mmss(s.t) + '</span>' + (s.sp ? '<b>' + esc(spLabel(s.sp)) + '</b> ' : '') + esc(s.txt) + (s.flag ? ' <em>욕설 의심</em>' : '') +
      (s.on && tplOf(cur.kind) === 'meet' ? '<div class="rp-cats">' + CATS.map((c) => '<button type="button" class="rp-cat' + (catOf(s) === c[0] ? ' on' : '') + '" data-ci="' + i + '" data-cat="' + c[0] + '">' + c[1] + '</button>').join('') + '</div>' : '') + '</div>' +
      '<button type="button" class="rp-ed" data-ed="' + i + '" aria-label="문장 고치기">✎</button></div>').join('') : '<div class="rp-empty">글자를 붙여넣고 "문장 나누기"를 누르세요.</div>';
  }
  root.addEventListener('click', (e) => {
    if (!cur || step !== 1) return;
    const ct = e.target.closest('[data-cat]');
    if (ct) { const s = cur.sentences[Number(ct.dataset.ci)]; if (s) { s.cat = ct.dataset.cat; drawSentences(); } e.stopPropagation(); return; }
    const ed = e.target.closest('[data-ed]');
    if (ed) { const s = cur.sentences[Number(ed.dataset.ed)]; const v = prompt('문장 고치기', s.txt); if (v != null && v.trim()) { s.txt = v.trim(); s.flag = isBad(s.txt); drawSentences(); } e.stopPropagation(); return; }
    const row = e.target.closest('.rp-s');
    if (row) { const s = cur.sentences[Number(row.dataset.i)]; s.on = !s.on; drawSentences(); }
  });

  // ----- 사진 -----
  function wizPhoto() {
    $q('#rp-body').innerHTML =
      '<div class="rp-two"><button type="button" class="rp-btn2" id="rp-pick">사진 선택</button><button type="button" class="rp-btn2 warm" id="rp-cam">바로 촬영</button></div>' +
      '<input id="rp-in" type="file" accept="image/*" multiple hidden><input id="rp-cin" type="file" accept="image/*" capture="environment" hidden>' +
      '<div id="rp-pl"></div>' +
      '<p class="rp-note">안 쓴 사진은 지우지 않고 후보로 보관해요. 같은 뷰 기준은 설정에서 바꿀 수 있어요(지금 ' + (Number(set.gap) || 10) + '초).</p>' +
      '<div class="rp-foot two"><button type="button" class="rp-btn2" id="rp-prev">이전</button><button type="button" class="rp-btn" id="rp-next">다음 · 미리보기</button></div>';
    $q('#rp-pick').onclick = () => $q('#rp-in').click();
    $q('#rp-cam').onclick = () => $q('#rp-cin').click();
    $q('#rp-in').onchange = () => addPhotos([...$q('#rp-in').files]).then(() => { $q('#rp-in').value = ''; });
    $q('#rp-cin').onchange = () => addPhotos([...$q('#rp-cin').files]).then(() => { $q('#rp-cin').value = ''; });
    $q('#rp-prev').onclick = () => { saveCur(); step = 1; renderWiz(); };
    $q('#rp-next').onclick = () => { saveCur(); step = 3; renderWiz(); };
    drawPhotos();
  }
  async function addPhotos(files) {
    if (!files.length || busy) return; busy = true; toast('사진 ' + files.length + '장을 읽는 중…');
    let ok = 0, fail = 0;
    for (const f of files) {
      try {
        const p = await prepPhoto(f);
        if (cur.photos.some((q) => Math.abs(q.ts - p.ts) < 500 && q.w === p.w && q.h === p.h && Math.abs(q.sharp - p.sharp) < 1e-6)) continue; // 같은 사진 두 번
        await putPhoto(p.id, p.blob); cur.photos.push(p); ok++;
      } catch (e) { fail++; }
    }
    busy = false; regroup(); pdfCache = null; saveCur(); drawPhotos();
    toast(ok + '장을 넣었어요.' + (fail ? ' (읽지 못한 사진 ' + fail + '장)' : ''));
  }
  const ymd = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  function dateWarn(g) {
    if (!set.warnDate || !cur || !cur.date) return '';
    const o = g.find((p) => ymd(p.ts) !== cur.date);
    return o ? '<div class="rp-warn">보고 날짜(' + cur.date.slice(5).replace('-', '.') + ')와 다른 날(' + ymd(o.ts).slice(5).replace('-', '.') + ') 찍은 사진이에요.</div>' : '';
  }
  function drawPhotos() {
    const el = $q('#rp-pl'); if (!el) return;
    const gs = groupsOf();
    el.innerHTML = gs.length ? gs.map((g, gi) => {
      const sel = g.find((p) => p.sel), skip = g.every((p) => p.skip);
      return '<div class="rp-card"><div class="rp-row"><b>같은 뷰 ' + g.length + '장</b><span class="rp-tag">' + hms(g[0].ts) + (g.length > 1 ? '~' + hms(g[g.length - 1].ts) : '') + '</span></div>' +
        '<div class="rp-ths">' + g.map((p) => '<button type="button" class="rp-ph' + (p.sel && !skip ? ' sel' : '') + (skip ? ' off' : '') + '" data-g="' + gi + '" data-p="' + p.id + '" style="background-image:url(' + urlOf(p) + ')">' + (p.sel && !skip ? '<i>★</i>' : '') + '</button>').join('') + '</div>' +
        dateWarn(g) + '<div class="rp-meta">' + (skip ? '이 뷰는 넣지 않아요' : sel ? ('선명도 ' + sel.rel + ' · 밝기 ' + (sel.mean < 70 ? '어두움' : sel.mean > 200 ? '밝음' : '적정') + (g.length > 1 ? (sel.manual ? ' · 직접 선택' : ' · 자동 선택') : '')) : '') + '</div>' +
        '<button type="button" class="rp-link" data-skip="' + gi + '">' + (skip ? '이 뷰 넣기' : '이 뷰 넣지 않기') + '</button></div>';
    }).join('') : '<div class="rp-empty">사진을 선택하거나 바로 찍으세요.<br>촬영 시각 순서로 글자와 맞춰요.</div>';
  }
  root.addEventListener('click', async (e) => {
    if (!cur || step !== 2) return;
    const gs = groupsOf();
    const ph = e.target.closest('.rp-ph');
    if (ph) { const g = gs[Number(ph.dataset.g)]; g.forEach((p) => { p.sel = p.id === ph.dataset.p; p.manual = true; p.skip = false; }); pdfCache = null; saveCur(); drawPhotos(); return; }
    const sk = e.target.closest('[data-skip]');
    if (sk) { const g = gs[Number(sk.dataset.skip)], v = !g.every((p) => p.skip); g.forEach((p) => { p.skip = v; }); pdfCache = null; saveCur(); drawPhotos(); return; }
  });

  // ----- 미리보기와 내보내기 -----
  async function wizPreview() {
    pdfCache = null; // 1·2단계에서 고친 내용이 항상 반영되도록 들어올 때마다 새로 그린다
    $q('#rp-body').innerHTML =
      '<div id="rp-pv" class="rp-pv"><div class="rp-empty">미리보기를 만드는 중…</div></div>' +
      '<p class="rp-note">앱은 자동으로 보내지 않아요. 확인한 뒤 직접 보내세요. 사진 위치정보(GPS)는 들어가지 않아요.</p>' +
      '<div class="rp-foot col"><button type="button" class="rp-btn" id="rp-pdf">PDF 내보내기</button><button type="button" class="rp-btn2" id="rp-zip">2단계용 묶음 내보내기</button><button type="button" class="rp-btn2" id="rp-prev">이전</button></div>';
    $q('#rp-prev').onclick = () => { saveCur(); step = 2; renderWiz(); };
    $q('#rp-pdf').onclick = exportPdf; $q('#rp-zip').onclick = exportZip;
    try {
      const pages = await getPages(); const pv = $q('#rp-pv'); if (!pv) return;
      pv.innerHTML = ''; pages.forEach((pg) => { const im = document.createElement('img'); im.src = pg.toDataURL('image/jpeg', 0.7); im.alt = '미리보기'; pv.appendChild(im); });
      if (!baseTs(cur)) { const n = document.createElement('p'); n.className = 'rp-note warn'; n.textContent = '녹음 시작 시각이 비어 있어요. 글자와 사진 순서가 맞지 않을 수 있어요. 이전 단계에서 입력하세요.'; pv.appendChild(n); }
      if (set.warnDate && cur.date && cur.photos.some((p) => p.sel && !p.skip && ymd(p.ts) !== cur.date)) { const n = document.createElement('p'); n.className = 'rp-note warn'; n.textContent = '보고 날짜와 다른 날 찍은 사진이 들어 있어요. 사진이 글자보다 앞이나 뒤로 갈 수 있어요.'; pv.appendChild(n); }
    } catch (e) { const pv = $q('#rp-pv'); if (pv) pv.innerHTML = '<div class="rp-empty">미리보기를 만들지 못했어요. 다시 시도해 주세요.</div>'; }
  }
  async function getPages() { if (!pdfCache) pdfCache = await renderPages(cur); return pdfCache; }
  async function exportPdf() {
    if (busy) return; busy = true; const b = $q('#rp-pdf'); b.textContent = '만드는 중…';
    try {
      const blob = await makePdf(await getPages()), res = await deliver(blob, fileBase(cur) + (tplOf(cur.kind) === 'call' ? '_통화기록.pdf' : tplOf(cur.kind) === 'meet' ? '_회의록초안.pdf' : tplOf(cur.kind) === 'memo' ? '_메모.pdf' : '_현장초안.pdf'));
      if (res !== 'cancel') { cur.exported = new Date().toISOString(); saveCur(); toast(res === 'saved' ? '다운로드 폴더에 저장했어요.' : '공유 화면으로 보냈어요.'); }
    } catch (e) { toast('PDF를 만들지 못했어요.'); }
    busy = false; const b2 = $q('#rp-pdf'); if (b2) b2.textContent = 'PDF 내보내기';
  }
  async function exportZip() {
    if (busy) return; busy = true; const b = $q('#rp-zip'); b.textContent = '묶는 중…';
    try {
      const enc = new TextEncoder(), files = [];
      const u8 = async (blob) => new Uint8Array(await blob.arrayBuffer());
      const meta = { kind: cur.kind, site: cur.site, date: cur.date, start: cur.start, attendees: cur.attendees, 장소: cur.place || '', 안건: cur.agenda || '', 상대방: cur.party || '', 연락처: cur.phone || '', 통화유형: cur.dir || '', 작성자: cur.author || '', 핵심요약: cur.sum || {}, 문장: cur.sentences.map((s) => ({ 녹음초: s.t, 말한사람: s.sp || '', 구분: s.cat || 'disc', 글: s.txt, 넣음: s.on, 욕설의심: s.flag })), 사진: [] };
      const ps = cur.photos.slice().sort((a, c) => a.ts - c.ts);
      let n = 0;
      for (const p of ps) {
        n++; const inc = p.sel && !p.skip, nm = '사진/' + (inc ? '선택' : '후보') + '/' + pad(n) + '_' + hms(p.ts).replace(/:/g, '') + '.jpg';
        files.push({ name: nm, data: await u8(p.blob) }); meta.사진.push({ 파일: nm, 촬영: new Date(p.ts).toISOString(), 선택: inc, 뷰: p.grp + 1 });
      }
      files.unshift({ name: '전체글자.txt', data: enc.encode(cur.raw || '') });
      files.unshift({ name: '보고.json', data: enc.encode(JSON.stringify(meta, null, 1)) });
      files.push({ name: '초안.pdf', data: await u8(await makePdf(await getPages())) });
      const res = await deliver(makeZip(files), fileBase(cur) + '_묶음.zip');
      if (res !== 'cancel') toast(res === 'saved' ? '다운로드 폴더에 저장했어요.' : '공유 화면으로 보냈어요.');
    } catch (e) { toast('묶음을 만들지 못했어요.'); }
    busy = false; const b2 = $q('#rp-zip'); if (b2) b2.textContent = '2단계용 묶음 내보내기';
  }

  // ---------- 설정: 같은 뷰 기준(초) ----------
  const gapIn = document.getElementById('r-gap');
  if (gapIn) { gapIn.value = String(Number(set.gap) || 10); gapIn.onchange = () => { const n = Number(gapIn.value), v = Math.min(120, Math.max(1, Math.round(gapIn.value === '' || isNaN(n) ? 10 : n))); gapIn.value = String(v); set.gap = v; lsSet(KEY_S, set); }; }

  const warnIn = document.getElementById('r-warn');
  if (warnIn) { warnIn.checked = !!set.warnDate; warnIn.onchange = () => { set.warnDate = warnIn.checked; lsSet(KEY_S, set); if (cur && step === 2 && $q('#rp-pl')) drawPhotos(); }; }

  // ---------- 보고 백업(사진 포함, 압축 없는 zip). 카드 백업과는 따로 저장한다 ----------
  const bkMsg = (t) => { const e = document.getElementById('r-bk-msg'); if (e) e.textContent = t; };
  const idOk = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);
  function cleanReport(r) {
    if (!r || !idOk(r.id) || !Array.isArray(r.photos) || !Array.isArray(r.sentences)) return null;
    return {
      id: r.id, kind: String(r.kind || '현장조사').slice(0, 12), site: String(r.site || '').slice(0, 40),
      date: /^\d{4}-\d\d-\d\d$/.test(r.date) ? r.date : '', start: /^\d\d:\d\d(:\d\d)?$/.test(r.start) ? r.start : '',
      attendees: String(r.attendees || '').slice(0, 60), raw: String(r.raw || ''),
      place: String(r.place || '').slice(0, 60), agenda: String(r.agenda || '').slice(0, 120), party: String(r.party || '').slice(0, 60), phone: String(r.phone || '').slice(0, 30), dur: Number(r.dur) > 0 && Number(r.dur) < 172800 ? Math.round(Number(r.dur)) : 0,
      dir: ['수신', '발신'].includes(r.dir) ? r.dir : '', author: String(r.author || '').slice(0, 20), sum: cleanSum(r.sum),
      sentences: r.sentences.map((s) => ({ t: Number(s && s.t) || 0, txt: String((s && s.txt) || ''), sp: String((s && s.sp) || '').slice(0, 12), cat: s && CATS.some((c) => c[0] === s.cat) ? s.cat : 'disc', flag: !!(s && s.flag), on: !!(s && s.on) })),
      created: Number(r.created) || Date.now(), exported: r.exported ? String(r.exported) : '', deleted: Number(r.deleted) || 0,
      photos: r.photos.filter((p) => p && idOk(p.id)).map((p) => ({ id: p.id, ts: Number(p.ts) || 0, w: Number(p.w) || 0, h: Number(p.h) || 0, sharp: Number(p.sharp) || 0, mean: Number(p.mean) || 0, dark: Number(p.dark) || 0, bright: Number(p.bright) || 0, sel: !!p.sel, manual: !!p.manual, skip: !!p.skip, grp: Number(p.grp) || 0 })),
    };
  }
  async function exportBackup() {
    if (busy) return; busy = true;
    try {
      const files = [], enc = new TextEncoder(); let np = 0;
      for (const r of reports) for (const p of r.photos) { try { const b = await getPhoto(p.id); if (b) { files.push({ name: 'photos/' + p.id + '.jpg', data: new Uint8Array(await b.arrayBuffer()) }); np++; } } catch (e) { /* 건너뜀 */ } }
      files.unshift({ name: 'backup.json', data: enc.encode(JSON.stringify({ app: 'suyoung-reports', version: 1, exported: new Date().toISOString(), reports, kinds, kmeta, set })) });
      const d = new Date(), name = '수영일해야지_보고백업_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.zip';
      const res = await deliver(makeZip(files), name);
      bkMsg(res === 'cancel' ? '저장을 취소했어요.' : '보고 ' + reports.length + '개(휴지통 포함), 사진 ' + np + '장을 ' + (res === 'saved' ? '다운로드 폴더에 저장했어요.' : '공유 화면으로 보냈어요.') + ' 파일 이름: ' + name);
    } catch (e) { bkMsg('내보내지 못했어요: ' + (e && e.message ? e.message : e)); }
    busy = false;
  }
  function readZip(buf) {
    const v = new DataView(buf), u = new Uint8Array(buf), dec = new TextDecoder(); let e = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('zip 파일이 아니에요');
    const n = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true); const out = {};
    for (let i = 0; i < n; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('깨진 파일이에요');
      const method = v.getUint16(p + 10, true), size = v.getUint32(p + 24, true), nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
      const name = dec.decode(u.subarray(p + 46, p + 46 + nl));
      if (method !== 0) throw new Error('지원하지 않는 압축이에요');
      const ds = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
      out[name] = u.subarray(ds, ds + size); p += 46 + nl + el + cl;
    }
    return out;
  }
  async function importBackup(file) {
    if (busy) return; busy = true;
    try {
      const z = readZip(await file.arrayBuffer()), j0 = z['backup.json'];
      if (!j0) throw new Error('보고 백업 파일이 아니에요');
      let d; try { d = JSON.parse(new TextDecoder().decode(j0)); } catch (er) { throw new Error('보고 백업 파일이 아니에요'); }
      if (!d || d.app !== 'suyoung-reports' || !Array.isArray(d.reports)) throw new Error('보고 백업 파일이 아니에요');
      const have = new Set(reports.map((r) => r.id)), add = d.reports.map(cleanReport).filter((r) => r && !have.has(r.id));
      if (!add.length) { bkMsg('새로 들어올 보고가 없어요(이미 있는 보고는 건너뜁니다).'); busy = false; return; }
      if (!confirm('보고 ' + add.length + '개를 추가할까요? (이미 있는 보고는 그대로 둡니다)')) { busy = false; return; }
      let np = 0;
      for (const r of add) for (const p of r.photos) {
        const f = z['photos/' + p.id + '.jpg'];
        if (!f || f.length < 4 || f[0] !== 0xFF || f[1] !== 0xD8) continue;           // 사진(JPEG)이 아니면 건너뜀
        if (await getPhoto(p.id)) continue;                                             // 폰에 이미 있는 사진은 덮어쓰지 않는다
        await putPhoto(p.id, new Blob([f], { type: 'image/jpeg' })); np++;
      }
      const prev = reports; reports = add.concat(reports);
      if (!lsSet(KEY_R, reports)) { reports = prev; bkMsg('불러오지 못했어요: 저장 공간이 부족해요.'); busy = false; return; }
      if (Array.isArray(d.kinds)) { d.kinds.forEach((k) => { if (typeof k === 'string' && k.trim() && !kinds.includes(k.trim().slice(0, 12))) kinds.push(k.trim().slice(0, 12)); }); lsSet(KEY_K, kinds); }
      if (d.kmeta && typeof d.kmeta === 'object') { // 종류의 아이콘·성격(이 폰에 없는 종류만 받는다)
        Object.keys(d.kmeta).forEach((k) => { const m = d.kmeta[k]; if (k !== '__seed' && kinds.includes(k) && !kmOf(k) && m && TPLS.some((t) => t[0] === m.tpl)) kmeta[k] = { icon: String(m.icon || '').slice(0, 8), tpl: m.tpl }; });
        lsSet(KEY_KM, kmeta);
      }
      if (!cur) renderList();
      bkMsg('불러왔어요: 보고 ' + add.length + '개, 사진 ' + np + '장.');
    } catch (e) { bkMsg('불러오지 못했어요: ' + (e && e.message ? e.message : '올바른 보고 백업 파일이 아니에요.')); }
    busy = false;
  }
  const bkE = document.getElementById('r-bk-export'), bkI = document.getElementById('r-bk-import'), bkF = document.getElementById('r-bk-file');
  if (bkE) bkE.onclick = exportBackup;
  if (bkI && bkF) { bkI.onclick = () => bkF.click(); bkF.onchange = () => { const f = bkF.files[0]; bkF.value = ''; if (f) importBackup(f); }; }

  renderList();
})();
