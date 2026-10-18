'use strict';
// 회사 할일보드 캡처 -> 카드 후보 -> 소장이 확인한 것만 카드로 저장.
// 글자 읽기(OCR)는 이 폰 안에서만 한다(ocr/ 폴더의 Tesseract.js, Apache-2.0). 사진·글자는 어디로도 보내지 않고 저장하지도 않는다.
// 화면 배치가 바뀌어도 되도록 "자리"가 아니라 "이름표(날짜·IN·OUT)와 모양"으로 찾는다.
const KEY_CAP = 'suyoung_cap_v1'; // { name: 카드 위에 보이는 내 이름 }
const CAP_SOURCE = '회사 할일보드';

// ---------- 글자 -> 카드 후보 (순수 함수: 시험하기 쉽게 따로 둔다) ----------
const capPad = (n) => String(n).padStart(2, '0');
function capCoreName(name) { return String(name || '').split(/[_\s]/)[0].replace(/[^\p{L}\p{N}]/gu, ''); } // '이수영_소장' -> '이수영'
function capSq(s) { return String(s || '').replace(/[\s_\-.·,]/g, ''); }
function capTime(ap, h, m) { // 오전/오후 + 시·분 -> 'HH:MM' (이상하면 '')
  h = +h; m = +m;
  if (!(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return '';
  if (ap === '오후' && h < 12) h += 12;
  if (ap === '오전' && h === 12) h = 0;
  if (ap && h > 23) return '';
  return capPad(h) + ':' + capPad(m);
}
const CAP_DATE = /(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/;
const CAP_REL = /^(\d+\s*(일|시간|분|주|개월|달)\s*전|오늘|어제|내일|방금|지금)$/;
function capValidDate(y, m, d) {
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? y + '-' + capPad(m) + '-' + capPad(d) : '';
}
function capTrimNoise(s) { // 줄 앞뒤의 체크박스·점 같은 찌꺼기를 걷어 낸다
  return String(s).replace(/^[\s□ㅁ☐▢口ㅣㅇ、。\[\]()|¦:;'"`~*•·@-]+/, '').replace(/[\s|¦:;'"`~*•·-]+$/, '').replace(/\s{2,}/g, ' ').trim();
}

function capParse(text, myName, todayDate) {
  const today = todayDate || new Date();
  const core = capCoreName(myName);
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const isMine = (l) => core && capSq(l).includes(core);
  const starts = [];
  lines.forEach((l, i) => { if (isMine(l)) starts.push(i); });
  const blocks = [];
  let noOwner = false;
  if (!starts.length) { noOwner = true; if (lines.length) blocks.push(lines); }
  else starts.forEach((s, k) => blocks.push(lines.slice(s + 1, k + 1 < starts.length ? starts[k + 1] : lines.length)));
  const out = [];
  blocks.forEach((b) => {
    const cand = capBlock(b, today);
    if (cand) { if (noOwner) cand.notes.push('내 이름을 찾지 못해 이 글자 전체를 한 카드로 봤어요. 내 카드가 맞는지 확인하세요.'); out.push(cand); }
  });
  return { cards: out, noOwner, lines: lines.length };
}

function capBlock(lines, today) {
  const text = lines.join('\n');
  const notes = [];
  // 날짜: 이름표 "날짜" 뒤의 날짜가 우선, 없으면 블록의 첫 날짜
  let date = '';
  const dm = text.match(CAP_DATE);
  if (dm) date = capValidDate(+dm[1], +dm[2], +dm[3]);
  // IN / OUT 시각: 이름표 뒤에 오는 시각을 가장 가까운 이름표에 붙인다
  const labelRe = /(O[UuVv][TtlI1]|0UT|\bI[Nn]\b|\b[1lI]N\b)(?![가-힣])/g;
  const timeRe = /(오전|오후)?\s*(\d{1,2})\s*[:;：]\s*(\d{2})/g;
  const labels = []; let m;
  while ((m = labelRe.exec(text))) labels.push({ i: m.index, k: /^[O0]/.test(m[1]) ? 'out' : 'in', end: m.index + m[0].length });
  const times = [];
  while ((m = timeRe.exec(text))) times.push({ i: m.index, ap: m[1] || '', h: m[2], mi: m[3] });
  let start = '', end = '', apGuess = false;
  const stash = []; // 이름표가 없거나 이미 쓴 이름표에 딸린 시각(OUT 글자가 깨졌을 때 등)
  times.forEach((t) => {
    let lab = null;
    labels.forEach((l) => { if (l.end <= t.i) lab = l; });
    let ap = t.ap, h = +t.h;
    if (!ap && h >= 1 && h <= 11) { apGuess = true; if (h <= 6) ap = '오후'; } // 오전/오후를 못 읽으면 업무 시간대로 추측(1~6시는 오후)
    const v = capTime(ap, h, t.mi);
    if (!v) return;
    if (lab && lab.k === 'in' && !start) start = v;
    else if (lab && lab.k === 'out' && !end) end = v;
    else stash.push(v);
  });
  if (!start && stash.length) { start = stash.shift(); notes.push('IN 글자를 못 읽어 첫 시각을 시작으로 봤어요. 확인하세요.'); }
  if (start && !end && stash.length) { end = stash.shift(); notes.push('OUT 글자를 못 읽어 다음 시각을 완료로 봤어요. 확인하세요.'); }
  if (apGuess) notes.push('오전/오후를 못 읽은 시각이 있어 업무 시간대로 추측했어요. 시각을 확인하세요.');
  if (!date) { // IN 줄의 "10.12." 에서 월·일을 가져온다
    const md = text.match(/\b(\d{1,2})\s*\.\s*(\d{1,2})\s*\./);
    if (md) {
      let y = today.getFullYear(); let d = capValidDate(y, +md[1], +md[2]);
      if (d && new Date(d) - today > 31 * 864e5) d = capValidDate(y - 1, +md[1], +md[2]);
      if (d) { date = d; notes.push('날짜를 IN·OUT 줄에서 가져왔어요. 확인하세요.'); }
    }
  }
  if (end && start && end <= start) { notes.push('OUT 시각(' + end + ')이 IN(' + start + ')보다 늦지 않아 완료 시각은 비웠어요.'); end = ''; }
  if (end && !start) { notes.push('IN 시각을 못 읽어 완료 시각만 있어요. 완료 시각은 비웠어요.'); end = ''; }
  // 제목·프로젝트·메모: 이름표·시각·날짜·"N일 전" 줄을 빼고 남은 줄
  let project = ''; const rest = [];
  lines.forEach((raw) => {
    const l = capTrimNoise(raw);
    if (!l || l.length < 2 && !/[가-힣]/.test(l)) return;
    if (!/[가-힣A-Za-z]{2,}/.test(l)) return; // 글자 두 개 이상 이어진 줄만(아이콘·점이 글자로 잘못 읽힌 줄은 버린다)
    if (CAP_REL.test(l.replace(/\s/g, '')) ) return;
    if (/^날\s*짜$/.test(l) || CAP_DATE.test(l)) return;
    if (/(\bIN\b|\bOUT\b|0UT|\b[1lI]N\b)/.test(l) && /\d/.test(l)) return;
    if (/\d{1,2}\s*[:;：]\s*\d{2}/.test(l)) return;
    if (/^(20\d{2})\s*[_\-.]\s*\d{1,2}\b/.test(l) && !project) { project = l; return; }
    rest.push(l);
  });
  const title = (rest[0] || '').slice(0, 100);
  const memo = rest.slice(1).join(' / ').slice(0, 500);
  if (!title && !date && !start) return null; // 카드로 볼 만한 내용이 없는 덩어리
  if (!title) notes.push('제목을 읽지 못했어요. 직접 쓰세요.');
  if (!date) notes.push('날짜를 읽지 못했어요. 직접 고르세요.');
  project = project.replace(/^(20\d{2})\s*[.\-]\s*(\d{1,2})/, '$1_$2'); // 글자 읽기가 "_"를 "."로 읽는 일이 많다
  return { title, memo, project: project.slice(0, 40), date, start, end, notes };
}

// ---------- 글자 읽기 (Tesseract.js, 폰 안에서) ----------
let capWorker = null, capBusy = false;
function capLoadScript(src) {
  return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('글자 읽기 파일을 불러오지 못했어요(' + src + ')')); document.head.appendChild(s); });
}
async function capGetWorker(say) {
  if (capWorker) return capWorker;
  if (!window.Tesseract) await capLoadScript('ocr/tesseract.min.js');
  const abs = (p) => new URL(p, location.href).href;
  say('글자 읽기 준비 중… (처음에는 조금 걸려요)');
  capWorker = await Tesseract.createWorker(['kor', 'eng'], 1, {
    workerPath: abs('ocr/worker.min.js'), corePath: abs('ocr/core'), langPath: abs('ocr/lang'),
    workerBlobURL: false, gzip: false, cacheMethod: 'none',
    logger: (m) => { if (m && m.status === 'recognizing text') say('글자 읽는 중… ' + Math.round((m.progress || 0) * 100) + '%'); }
  });
  return capWorker;
}
function capPrep(file, maxScale) { // 작은 캡처는 키워서(최대 3배) 흑백으로: 시험해 보니 문턱값으로 이진화하면 색 알약 속 글자를 오히려 잃는다
  return new Promise((ok, no) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      try {
        const w0 = img.naturalWidth, h0 = img.naturalHeight;
        const sc = Math.max(1, Math.min(maxScale || 3, 1400 / w0, 6000 / h0));
        const cv = document.createElement('canvas'); cv.width = Math.round(w0 * sc); cv.height = Math.round(h0 * sc);
        const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, cv.width, cv.height);
        const d = g.getImageData(0, 0, cv.width, cv.height), p = d.data;
        for (let i = 0; i < p.length; i += 4) { const y = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = p[i + 1] = p[i + 2] = y; }
        g.putImageData(d, 0, 0); URL.revokeObjectURL(url); ok(cv);
      } catch (e) { URL.revokeObjectURL(url); no(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); no(new Error('사진을 열지 못했어요: ' + (file.name || ''))); };
    img.src = url;
  });
}

// ---------- 화면 ----------
(function capUi() {
  const $c = (id) => document.getElementById(id);
  let modal = null, cands = [], rawText = '', rawText2 = '';
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const myName = () => { try { return (JSON.parse(localStorage.getItem(KEY_CAP)) || {}).name || '이수영_소장'; } catch (e) { return '이수영_소장'; } };
  const setName = (v) => { try { localStorage.setItem(KEY_CAP, JSON.stringify({ name: v })); } catch (e) { /* 무시 */ } };
  const todayS = () => { const t = new Date(); return t.getFullYear() + '-' + capPad(t.getMonth() + 1) + '-' + capPad(t.getDate()); };
  const dup = (c) => cards.some((x) => x.date === c.date && x.title === c.title && (x.start || '') === (c.start || ''));

  function build() {
    modal = el('div', 'sheet'); modal.id = 'cap-sheet'; modal.hidden = true;
    const box = el('div', 'sheet-box');
    box.appendChild(el('h2', null, '회사 할일보드 캡처 넣기'));
    box.appendChild(el('p', 'note', '할일보드 카드를 캡처한 사진을 고르면 이 폰 안에서 글자를 읽어 확실한 카드는 바로 만들어요. 불확실한 것만 아래에 남겨 두니 확인하고 저장하세요. 사진과 글자는 어디로도 보내거나 저장하지 않아요. 읽은 값이 틀렸으면 할일 탭에서 카드를 눌러 고치거나 지울 수 있어요.'));
    const nm = el('label', null, '카드 위에 보이는 내 이름'); const ni = el('input'); ni.id = 'cap-name'; ni.value = myName(); ni.maxLength = 30; ni.autocomplete = 'off'; nm.appendChild(ni); box.appendChild(nm);
    ni.onchange = () => setName(ni.value.trim() || '이수영_소장');
    const pick = el('button', 'wide', '📷 캡처 사진 고르기 (여러 장 가능)'); pick.type = 'button'; box.appendChild(pick);
    const fi = el('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.multiple = true; fi.hidden = true; box.appendChild(fi);
    pick.onclick = () => { if (!capBusy) fi.click(); };
    fi.onchange = () => { const fs = Array.from(fi.files || []); fi.value = ''; if (fs.length) runFiles(fs); };
    const st = el('p', 'note'); st.id = 'cap-status'; box.appendChild(st);
    const det = el('details', 'clk'); det.id = 'cap-raw';
    det.appendChild(el('summary', null, '읽은 글자 보기·고쳐서 다시 분석'));
    const ta = el('textarea'); ta.id = 'cap-text'; ta.rows = 6; det.appendChild(ta);
    const re = el('button', 'wide', '이 글자로 다시 분석'); re.type = 'button'; det.appendChild(re); box.appendChild(det);
    re.onclick = () => { rawText = ta.value; rawText2 = ''; analyze(); };
    const list = el('div'); list.id = 'cap-list'; list.className = 'cap-list'; box.appendChild(list);
    const bt = el('div', 'sheet-btns'); const close = el('button', null, '닫기'); close.type = 'button';
    bt.appendChild(el('span', 'grow')); bt.appendChild(close);
    const save = el('button', 'primary', '선택한 카드 저장'); save.type = 'button'; save.id = 'cap-save'; bt.appendChild(save); box.appendChild(bt);
    close.onclick = () => { modal.hidden = true; };
    save.onclick = saveSelected;
    modal.appendChild(box); document.body.appendChild(modal);
  }
  const say = (t) => { const s = $c('cap-status'); if (s) s.textContent = t || ''; };

  async function runFiles(files) {
    capBusy = true; $c('cap-save').disabled = true; rawText = ''; rawText2 = '';
    try {
      const w = await capGetWorker(say); const parts = [], parts2 = [];
      for (let i = 0; i < files.length; i++) {
        say('사진 ' + (i + 1) + '/' + files.length + ' 읽는 중…');
        await w.setParameters({ tessedit_pageseg_mode: '3' });
        const a = (await w.recognize(await capPrep(files[i], 3))).data.text || '';
        parts.push(a);
        const pa = capParse(a, $c('cap-name').value.trim() || '이수영_소장').cards;
        // 시각이나 날짜를 못 읽은 카드가 있으면 다른 방식으로 한 번 더 읽어 빈칸을 메운다
        if (!pa.length || pa.some((c) => !c.date || !c.title || c.notes.length)) {
          say('사진 ' + (i + 1) + '/' + files.length + ' 한 번 더 읽는 중…');
          await w.setParameters({ tessedit_pageseg_mode: '6' });
          parts2.push((await w.recognize(await capPrep(files[i], 2))).data.text || '');
        } else parts2.push(a);
      }
      rawText = parts.join('\n'); rawText2 = parts2.join('\n');
      $c('cap-text').value = rawText;
      analyze(true);
    } catch (e) { say('글자를 읽지 못했어요: ' + (e && e.message ? e.message : e) + ' (인터넷이 필요한 것이 아니라 파일 문제일 수 있어요. 아래 "읽은 글자"에 직접 붙여넣어 분석할 수도 있어요.)'); }
    capBusy = false; $c('cap-save').disabled = false;
  }

  function analyze(autoNow) {
    const nameV = $c('cap-name').value.trim() || '이수영_소장'; setName(nameV);
    const r = capParse(rawText, nameV);
    if (rawText2) { // 두 번째 읽기에서 빈칸만 가져온다(두 결과의 카드 수가 같을 때만)
      const r2 = capParse(rawText2, nameV);
      if (r2.cards.length === r.cards.length) r.cards.forEach((c, i) => {
        const o = r2.cards[i]; let used = false;
        ['title', 'date', 'start', 'end', 'project'].forEach((k) => { if (!c[k] && o[k]) { c[k] = o[k]; used = true; } });
        if (used) { c.notes = c.notes.filter((n) => !/읽지 못했어요|못 읽어/.test(n)); c.notes.push('빈칸 일부를 다른 방식으로 읽어 채웠어요. 확인하세요.'); }
      });
    }
    cands =r.cards.map((c) => Object.assign(c, { on: !dup(c) && !!c.title && !!c.date, isDup: false }));
    cands.forEach((c) => { if (c.title && c.date && dup(c)) { c.isDup = true; c.on = false; } });
    const found = cands.length;
    drawList();
    // 사진을 막 읽었을 때만 바로 만든다(읽은 글자를 고쳐 다시 분석할 때는 소장이 확인하고 저장한다)
    const made = autoNow ? autoSave() : 0;
    const left = cands.length;
    say(found ? (made ? made + '개 카드를 바로 만들었어요. 할일 탭에서 고치거나 지울 수 있어요.' + (left ? ' 확인이 필요한 후보 ' + left + '개는 아래에 남겨 뒀어요.' : '') : '카드 후보 ' + found + '개를 찾았어요. 맞는지 확인하고 저장하세요.') : (r.lines ? '카드로 볼 만한 내용을 찾지 못했어요. 읽은 글자를 확인해 보세요.' : '글자를 하나도 읽지 못했어요. 캡처를 더 크게·또렷하게 찍어 보세요.'));
    if (!found || !rawText) $c('cap-raw').open = true;
  }

  function drawList() {
    const list = $c('cap-list'); list.textContent = '';
    cands.forEach((c, i) => {
      const row = el('div', 'cap-card');
      const top = el('label', 'chk2'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = c.on; cb.onchange = () => { c.on = cb.checked; };
      top.appendChild(cb); top.appendChild(el('span', null, c.isDup ? '이미 있는 카드예요(체크하면 또 만들어요)' : '이 카드 저장')); row.appendChild(top);
      const f = (lab, key, type, ph) => { const l = el('label', null, lab); const inp = el('input'); inp.type = type || 'text'; inp.value = c[key] || ''; if (ph) inp.placeholder = ph; inp.maxLength = key === 'memo' ? 500 : 100; inp.onchange = () => { c[key] = inp.value.trim(); }; l.appendChild(inp); return l; };
      row.appendChild(f('제목', 'title')); row.appendChild(f('날짜', 'date', 'date'));
      const r2 = el('div', 'row2'); r2.appendChild(f('시작(IN)', 'start', 'time')); r2.appendChild(f('완료(OUT)', 'end', 'time')); row.appendChild(r2);
      row.appendChild(f('프로젝트', 'project')); row.appendChild(f('메모', 'memo'));
      c.notes.forEach((n) => row.appendChild(el('p', 'rp-note warn', '⚠ ' + n)));
      list.appendChild(row);
    });
  }

  // 카드로 저장해도 되는지 검사한다(문제가 있으면 안내 글, 없으면 '')
  function capProblem(c) {
    if (!c.title) return '제목이 빈 카드가 있어요. 제목을 쓰세요.';
    if (!isDate(c.date)) return '날짜가 빈 카드가 있어요(' + c.title + '). 날짜를 고르세요.';
    if (c.start && !isTime(c.start)) return '시작 시각 형식이 맞지 않아요(' + c.title + ').';
    if (c.end && !isTime(c.end)) return '완료 시각 형식이 맞지 않아요(' + c.title + ').';
    if (c.end && (!c.start || c.end <= c.start)) return '완료 시각은 시작 시각보다 늦어야 해요(' + c.title + ').';
    return '';
  }
  // 사진을 읽은 직후: 확실한 후보(제목·날짜 있음, 경고 없음, 이미 있는 카드 아님)는 확인 없이 바로 카드로 만든다.
  // 불확실한 후보와 겹치는 후보는 남겨 두고 소장이 확인한 뒤 저장한다. 만든 카드는 할일 탭에서 고치거나 지울 수 있다.
  function autoSave() {
    // 시작 시각을 못 읽은 후보는 불확실로 본다. 같은 묶음 안에서 같은 카드(제목·날짜·시작)는 한 번만 저장한다.
    const seen = new Set(); const sure = [];
    cands.forEach((c) => {
      if (!(c.on && !c.isDup && !c.notes.length && c.start && !capProblem(c))) return;
      const key = c.date + '|' + c.title + '|' + c.start;
      if (seen.has(key)) return; seen.add(key); sure.push(c);
    });
    if (!sure.length) return 0;
    const n = commit(sure);
    cands = cands.filter((c) => !sure.includes(c));
    // 방금 저장한 카드와 같은 남은 후보는 '이미 있는 카드'로 바꿔 꺼 둔다
    cands.forEach((c) => { if (c.title && c.date && dup(c)) { c.isDup = true; c.on = false; } });
    drawList();
    return n;
  }
  function saveSelected() {
    const pick = cands.filter((c) => c.on);
    if (!pick.length) { say('저장할 카드를 체크하세요.'); return; }
    for (const c of pick) { const p = capProblem(c); if (p) { say(p); return; } }
    const n = commit(pick);
    cands = cands.filter((c) => !pick.includes(c)); drawList();
    say(n + '개 카드를 저장했어요. 남은 후보는 아래에 그대로 있어요.');
  }
  function commit(pick) {
    const t = todayS(); const added = [];
    pick.forEach((c) => {
      if (c.project && !own(projects, c.project)) projects[c.project] = COLOR_DEFAULT.work;
      const past = c.date < t; // 지난 날 카드는 알람을 켜지 않는다(이미 지난 일)
      const card = norm({ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), title: c.title, memo: c.memo, start: c.start, end: c.end, time: c.start,
        done: false, source: CAP_SOURCE, kind: 'work', side: '', project: c.project, color: '', gid: '', gdirty: false, alarmS: !past, alarmE: !past, date: c.date, created: new Date().toISOString() });
      if (card) { cards.push(card); added.push(card); }
    });
    const toG = (gset.clientId || '').trim();
    added.forEach((cd) => { if (toG && cd.start && cd.date >= t) cd.gdirty = true; });
    saveAll(); if (typeof autoDone === 'function') autoDone(); render();
    added.forEach((cd) => { if (cd.gdirty) pushCard(cd).then(() => render()); });
    return added.length;
  }

  function open() { if (!modal) build(); modal.hidden = false; }
  // 첫 화면(할일 탭)의 + 버튼 바로 밑에 항상 보이는 "캡처+" 버튼 (소장 지시 2026-10-18: 카드 목록 위 점선 버튼은 없앰)
  const fabCap = el('button', 'cap-fab', '캡처+'); fabCap.type = 'button'; fabCap.id = 'cap-fab'; fabCap.setAttribute('aria-label', '회사 할일보드 캡처 넣기'); fabCap.onclick = open;
  const todoView = $c('view-todo'); if (todoView) todoView.appendChild(fabCap);
})();
