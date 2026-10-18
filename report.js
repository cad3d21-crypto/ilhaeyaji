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

  let kinds = lsGet(KEY_K, ['현장조사']); if (!Array.isArray(kinds) || !kinds.length) kinds = ['현장조사'];
  let kindSel = kinds[0];
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
        b = { t, lines: [] }; blocks.push(b); continue;
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
        ss.forEach((s, j) => out.push({ t: Math.round(bk.t + (end - bk.t) * (j / Math.max(1, ss.length))), txt: s }));
      });
    }
    return { info, sentences: out.map((s) => ({ t: s.t, txt: s.txt, flag: isBad(s.txt), on: false })) };
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
  function timeline(r) {
    const base = baseTs(r), a = []; let n = 0;
    r.sentences.forEach((s) => { if (s.on) a.push({ k: 's', n: n++, ts: base != null ? base + s.t * 1000 : s.t * 1000, txt: s.txt }); });
    r.photos.forEach((p) => { if (p.sel && !p.skip) a.push({ k: 'p', n: n++, ts: p.ts, p }); });
    // 같은 시각이면 문장이 사진보다 먼저, 같은 종류끼리는 말한 순서를 지킨다
    return a.sort((x, y) => x.ts - y.ts || (x.k === y.k ? x.n - y.n : (x.k === 's' ? -1 : 1)));
  }

  // ---------- 쪽 그리기(A4, 150dpi) → PDF ----------
  async function renderPages(r) {
    const W = 1240, H = 1754, M = 110, FOOT = 80, FONT = '"Malgun Gothic","Noto Sans KR",sans-serif';
    const pages = []; let c, x, y;
    const newPage = () => { c = document.createElement('canvas'); c.width = W; c.height = H; x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.textBaseline = 'top'; pages.push(c); y = M; };
    const need = (h) => { if (y + h > H - M - FOOT + 40) newPage(); };
    const wrap = (t, maxW) => {
      const out = []; let ln = '';
      for (const ch of t) { const nx = ln + ch; if (x.measureText(nx).width > maxW && ln) { out.push(ln); ln = ch === ' ' ? '' : ch; } else ln = nx; }
      if (ln) out.push(ln); return out;
    };
    const bmps = new Map();
    for (const p of r.photos) if (p.sel && !p.skip) { try { bmps.set(p.id, await createImageBitmap(p.blob)); } catch (e) { /* 건너뜀 */ } }
    newPage();
    x.fillStyle = '#2d5a49'; x.font = 'bold 54px ' + FONT; x.fillText(r.kind + ' 보고', M, y);
    x.strokeStyle = '#d9776b'; x.lineWidth = 3; x.strokeRect(W - M - 110, y + 2, 110, 56);
    x.fillStyle = '#b5594d'; x.font = 'bold 32px ' + FONT; x.fillText('초안', W - M - 82, y + 12);
    y += 86;
    x.fillStyle = '#7b847e'; x.font = '26px ' + FONT; x.fillText('현장에서 바로 만든 초안입니다. 정식 보고서는 따로 보내 드립니다.', M, y);
    y += 64;
    const rows = [['현장명', r.site || '[ 미기입 ]'], ['일시', dateKo(r)], ['참석자', r.attendees || '[ 미기입 ]'], ['종류', r.kind]];
    x.font = '28px ' + FONT;
    rows.forEach(([k, v]) => {
      const ls = wrap(v, W - 2 * M - 240 - 24), h = Math.max(1, ls.length) * 40 + 24;
      need(h);
      x.fillStyle = '#eef3f0'; x.fillRect(M, y, 220, h); x.strokeStyle = '#cfd6d0'; x.lineWidth = 2; x.strokeRect(M, y, W - 2 * M, h); x.beginPath(); x.moveTo(M + 220, y); x.lineTo(M + 220, y + h); x.stroke();
      x.fillStyle = '#2d5a49'; x.font = 'bold 28px ' + FONT; x.fillText(k, M + 16, y + 12);
      x.fillStyle = '#26302d'; x.font = '28px ' + FONT; ls.forEach((l, i) => x.fillText(l, M + 240, y + 12 + i * 40));
      y += h;
    });
    y += 50; need(80);
    x.fillStyle = '#2d5a49'; x.font = 'bold 38px ' + FONT; x.fillText('시간별 기록', M, y); y += 70;
    const items = timeline(r), base = baseTs(r);
    if (!items.length) { x.fillStyle = '#9aa39d'; x.font = '28px ' + FONT; x.fillText('선택한 문장과 사진이 없습니다.', M, y); y += 60; }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.k === 's') {
        x.font = '28px ' + FONT;
        const ls = wrap(it.txt, W - 2 * M - 210), h = ls.length * 42 + 16;
        need(h);
        x.fillStyle = '#7b847e'; x.font = '24px ' + FONT; x.fillText(base != null ? hms(it.ts) : mmss(Math.round(it.ts / 1000)), M, y + 6);
        x.fillStyle = '#26302d'; x.font = '28px ' + FONT; ls.forEach((l, j) => x.fillText(l, M + 210, y + j * 42));
        y += h;
      } else {
        const row = [it]; if (items[i + 1] && items[i + 1].k === 'p') { row.push(items[i + 1]); i++; }
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
    pages.forEach((pg, i) => { const g = pg.getContext('2d'); g.fillStyle = '#9aa39d'; g.font = '22px ' + FONT; g.textBaseline = 'top'; g.textAlign = 'center'; g.fillText('초안 · ' + (i + 1) + ' / ' + pages.length, W / 2, H - 80); g.textAlign = 'left'; });
    bmps.forEach((b) => { if (b.close) b.close(); });
    return pages;
  }
  const jpgOf = (cv, q) => new Promise((res) => cv.toBlob((b) => b.arrayBuffer().then((a) => res(new Uint8Array(a))), 'image/jpeg', q));
  async function makePdf(pages) {
    const enc = new TextEncoder(), parts = [], xref = []; let off = 0;
    const w = (s) => { const b = typeof s === 'string' ? enc.encode(s) : s; parts.push(b); off += b.length; };
    const jpgs = []; for (const p of pages) jpgs.push(await jpgOf(p, 0.88));
    const n = pages.length, size = 3 + n * 3;
    const obj = (num, fn) => { xref[num] = off; w(num + ' 0 obj\n'); fn(); w('\nendobj\n'); };
    w('%PDF-1.4\n');
    obj(1, () => w('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => w('<< /Type /Pages /Kids [' + pages.map((_, i) => (3 + i * 3) + ' 0 R').join(' ') + '] /Count ' + n + ' >>'));
    pages.forEach((p, i) => {
      const pg = 3 + i * 3, ct = pg + 1, im = pg + 2, cs = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
      obj(pg, () => w('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ' + im + ' 0 R >> >> /Contents ' + ct + ' 0 R >>'));
      obj(ct, () => w('<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream'));
      obj(im, () => { w('<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpgs[i].length + ' >>\nstream\n'); w(jpgs[i]); w('\nendstream'); });
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

  // ---------- 화면: 목록 ----------
  let showTrash = false;
  function renderList() {
    document.body.classList.remove('rpt-edit');
    const trash = reports.filter((r) => r.deleted), live = reports.filter((r) => !r.deleted), items = showTrash ? trash : live;
    const card = (r) => {
      const ns = r.sentences.filter((s) => s.on).length, np = r.photos.filter((p) => p.sel && !p.skip).length;
      return '<div class="rp-card"' + (showTrash ? '' : ' data-id="' + r.id + '"') + '><div class="rp-row"><b>' + esc(r.site || '(현장명 없음)') + '</b>' + (r.exported ? '<span class="rp-tag g">PDF 내보냄</span>' : '<span class="rp-tag">초안</span>') + '</div>' +
        '<div class="rp-meta">' + esc(r.kind) + ' · ' + esc(r.date ? r.date.slice(5).replace('-', '.') : '') + ' · 사진 ' + np + ' · 문장 ' + ns + '</div>' +
        (showTrash ? '<button type="button" class="rp-del" data-restore="' + r.id + '">복원</button>' : '<button type="button" class="rp-del" data-del="' + r.id + '">휴지통으로</button>') + '</div>';
    };
    root.innerHTML =
      '<div class="rp-top"><div class="rp-ttl">' + (showTrash ? '휴지통' : '보고') + '</div><div class="rp-sub">' + (showTrash ? '지운 보고는 사진과 함께 폰에 남아 있어요' : '현장에서 바로 초안을 만들어요') + '</div></div>' +
      (showTrash
        ? '<button type="button" class="rp-btn2" id="rp-tback">← 보고 목록으로</button><div class="rp-lb">복원을 누르면 목록으로 돌아가요.</div>'
        : '<div class="rp-chips">' + kinds.map((k) => '<button type="button" class="rp-chip' + (k === kindSel ? ' on' : '') + '" data-k="' + esc(k) + '">' + esc(k) + '</button>').join('') + '<button type="button" class="rp-chip add" id="rp-addk">+ 종류 추가</button></div>' +
          '<button type="button" class="rp-btn" id="rp-new">+ 새 ' + esc(kindSel) + ' 보고</button><div class="rp-lb">최근 보고</div>') +
      (items.length ? items.map(card).join('') : '<div class="rp-empty">' + (showTrash ? '휴지통이 비어 있어요.' : '아직 보고가 없어요.<br>새 보고를 눌러 시작하세요.') + '</div>') +
      (showTrash ? '' : '<button type="button" class="rp-link dim" id="rp-trash">휴지통 (' + trash.length + ')</button>');
  }
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button,[data-id],.rp-s,.rp-ph');
    if (!t) return;
    if (t.classList.contains('rp-chip') && t.dataset.k) { kindSel = t.dataset.k; renderList(); return; }
    if (t.id === 'rp-addk') {
      const nm = (prompt('새 보고 종류 이름 (예: 감리)') || '').trim().slice(0, 12);
      if (nm && !kinds.includes(nm)) { kinds.push(nm); lsSet(KEY_K, kinds); kindSel = nm; toast('"' + nm + '" 종류를 만들었어요. 지금은 현장조사와 같은 방식으로 만들어집니다.'); }
      renderList(); return;
    }
    if (t.id === 'rp-new') { newReport(); return; }
    if (t.id === 'rp-trash') { showTrash = true; renderList(); return; }
    if (t.id === 'rp-tback') { showTrash = false; renderList(); return; }
    if (t.dataset.del) {
      e.stopPropagation(); if (!confirm('이 보고를 휴지통으로 보낼까요? 휴지통에서 다시 꺼낼 수 있어요.')) return;
      const r = reports.find((x) => x.id === t.dataset.del); if (r) { r.deleted = Date.now(); lsSet(KEY_R, reports); toast('휴지통으로 보냈어요.'); }
      renderList(); return;
    }
    if (t.dataset.restore) {
      const r = reports.find((x) => x.id === t.dataset.restore); if (r) { r.deleted = 0; lsSet(KEY_R, reports); toast('목록으로 복원했어요.'); }
      renderList(); return;
    }
    const card = t.closest('.rp-card'); if (card && card.dataset.id && !t.matches('button')) { openReport(card.dataset.id); return; }
  });

  // ---------- 새 보고·열기 ----------
  function newReport() {
    const d = new Date();
    cur = { id: uid(), kind: kindSel, site: '', date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), start: '', attendees: '', raw: '', sentences: [], photos: [], created: Date.now(), exported: '', deleted: 0 };
    step = 1; pdfCache = null; clearUrls(); renderWiz();
  }
  async function openReport(id) {
    const m = reports.find((x) => x.id === id); if (!m) return;
    cur = JSON.parse(JSON.stringify(m)); cur.photos = []; clearUrls();
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
      '<div class="rp-top"><div class="rp-ttl"><button type="button" class="rp-back" id="rp-back" aria-label="목록으로">‹</button>' + esc(cur.kind) + ' 보고</div></div>' +
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
    $q('#rp-body').innerHTML =
      field('현장명', '<input id="rp-site" maxlength="40" autocomplete="off" value="' + esc(cur.site) + '">') +
      '<div class="rp-two f">' + field('날짜', '<input id="rp-date" type="date" value="' + esc(cur.date) + '">') + field('녹음 시작 시각', '<input id="rp-start" type="time" step="1" value="' + esc(cur.start) + '">') + '</div>' +
      field('참석자', '<input id="rp-att" maxlength="60" autocomplete="off" value="' + esc(cur.attendees) + '">') +
      '<div class="rp-lb">클로바노트 글자</div>' +
      '<textarea id="rp-raw" rows="4" placeholder="여기에 붙여넣거나 txt 파일을 고르세요">' + esc(cur.raw) + '</textarea>' +
      '<div class="rp-two"><button type="button" class="rp-btn2" id="rp-paste">붙여넣기</button><button type="button" class="rp-btn2" id="rp-file">txt 선택</button></div>' +
      '<input id="rp-txt" type="file" accept=".txt,text/plain" hidden>' +
      '<button type="button" class="rp-btn2 wide" id="rp-split">문장 나누기</button>' +
      '<div class="rp-lb">넣을 문장만 체크하세요 <small>(체크하지 않은 문장은 초안에 들어가지 않아요. 욕설 표시는 목록에 있는 말만 잡아내니, 체크한 문장은 직접 한 번 더 읽어 보세요)</small></div>' +
      '<div class="rp-two"><button type="button" class="rp-btn2" id="rp-all">전체 선택(욕설 제외)</button><button type="button" class="rp-btn2" id="rp-none">전체 해제</button></div>' +
      '<div id="rp-slist"></div>' +
      '<div class="rp-foot"><button type="button" class="rp-btn" id="rp-next">다음 · 사진</button></div>';
    const bind = (id, k) => { $q(id).oninput = () => { cur[k] = $q(id).value; }; };
    bind('#rp-site', 'site'); bind('#rp-date', 'date'); bind('#rp-start', 'start'); bind('#rp-att', 'attendees'); bind('#rp-raw', 'raw');
    $q('#rp-paste').onclick = async () => {
      try { const t = await navigator.clipboard.readText(); if (!t) { toast('복사된 글자가 없어요.'); return; } $q('#rp-raw').value = t; cur.raw = t; doSplit(); }
      catch (e) { toast('붙여넣기 권한이 없어요. 글자칸을 길게 눌러 붙여넣으세요.'); }
    };
    $q('#rp-file').onclick = () => $q('#rp-txt').click();
    $q('#rp-txt').onchange = async () => { const f = $q('#rp-txt').files[0]; if (!f) return; const t = await f.text(); $q('#rp-raw').value = t; cur.raw = t; $q('#rp-txt').value = ''; doSplit(); };
    $q('#rp-split').onclick = doSplit;
    $q('#rp-all').onclick = () => { cur.sentences.forEach((s) => { s.on = !s.flag; }); drawSentences(); };
    $q('#rp-none').onclick = () => { cur.sentences.forEach((s) => { s.on = false; }); drawSentences(); };
    $q('#rp-next').onclick = () => { saveCur(); step = 2; renderWiz(); };
    drawSentences();
  }
  function doSplit() {
    if (cur.sentences.some((s) => s.on) && !confirm('이미 체크한 문장이 있어요. 새로 나누면 체크가 지워져요. 계속할까요?')) return;
    const r = parseClova(cur.raw || '');
    cur.sentences = r.sentences;
    if (r.info.date) { cur.date = r.info.date; $q('#rp-date').value = cur.date; }
    if (r.info.start) { cur.start = r.info.start; $q('#rp-start').value = cur.start; }
    drawSentences();
    toast(r.sentences.length ? '문장 ' + r.sentences.length + '개로 나눴어요.' + (r.sentences.some((s) => s.flag) ? ' 욕설이 의심되는 문장은 빨갛게 표시했어요.' : '') : '나눌 글자가 없어요.');
  }
  function drawSentences() {
    const el = $q('#rp-slist'); if (!el) return;
    el.innerHTML = cur.sentences.length ? cur.sentences.map((s, i) =>
      '<div class="rp-s' + (s.flag ? ' bad' : '') + '" data-i="' + i + '"><span class="rp-bx' + (s.on ? ' on' : '') + '">' + (s.on ? '✓' : '') + '</span>' +
      '<div class="rp-st"><span class="rp-t">' + mmss(s.t) + '</span>' + esc(s.txt) + (s.flag ? ' <em>욕설 의심</em>' : '') + '</div>' +
      '<button type="button" class="rp-ed" data-ed="' + i + '" aria-label="문장 고치기">✎</button></div>').join('') : '<div class="rp-empty">글자를 붙여넣고 "문장 나누기"를 누르세요.</div>';
  }
  root.addEventListener('click', (e) => {
    if (!cur || step !== 1) return;
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
      const blob = await makePdf(await getPages()), res = await deliver(blob, fileBase(cur) + '_현장초안.pdf');
      if (res !== 'cancel') { cur.exported = new Date().toISOString(); saveCur(); toast(res === 'saved' ? '다운로드 폴더에 저장했어요.' : '공유 화면으로 보냈어요.'); }
    } catch (e) { toast('PDF를 만들지 못했어요.'); }
    busy = false; const b2 = $q('#rp-pdf'); if (b2) b2.textContent = 'PDF 내보내기';
  }
  async function exportZip() {
    if (busy) return; busy = true; const b = $q('#rp-zip'); b.textContent = '묶는 중…';
    try {
      const enc = new TextEncoder(), files = [];
      const u8 = async (blob) => new Uint8Array(await blob.arrayBuffer());
      const meta = { kind: cur.kind, site: cur.site, date: cur.date, start: cur.start, attendees: cur.attendees, 문장: cur.sentences.map((s) => ({ 녹음초: s.t, 글: s.txt, 넣음: s.on, 욕설의심: s.flag })), 사진: [] };
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
      sentences: r.sentences.map((s) => ({ t: Number(s && s.t) || 0, txt: String((s && s.txt) || ''), flag: !!(s && s.flag), on: !!(s && s.on) })),
      created: Number(r.created) || Date.now(), exported: r.exported ? String(r.exported) : '', deleted: Number(r.deleted) || 0,
      photos: r.photos.filter((p) => p && idOk(p.id)).map((p) => ({ id: p.id, ts: Number(p.ts) || 0, w: Number(p.w) || 0, h: Number(p.h) || 0, sharp: Number(p.sharp) || 0, mean: Number(p.mean) || 0, dark: Number(p.dark) || 0, bright: Number(p.bright) || 0, sel: !!p.sel, manual: !!p.manual, skip: !!p.skip, grp: Number(p.grp) || 0 })),
    };
  }
  async function exportBackup() {
    if (busy) return; busy = true;
    try {
      const files = [], enc = new TextEncoder(); let np = 0;
      for (const r of reports) for (const p of r.photos) { try { const b = await getPhoto(p.id); if (b) { files.push({ name: 'photos/' + p.id + '.jpg', data: new Uint8Array(await b.arrayBuffer()) }); np++; } } catch (e) { /* 건너뜀 */ } }
      files.unshift({ name: 'backup.json', data: enc.encode(JSON.stringify({ app: 'suyoung-reports', version: 1, exported: new Date().toISOString(), reports, kinds, set })) });
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
