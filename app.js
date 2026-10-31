'use strict';
// ソフトテニス部 戦績管理アプリ（画面の処理）
// データは Google スプレッドシート（apps-script/Code.gs）に保存し、この端末にも写しを持っておく

const APP_VERSION = '2026-10-31';
const UNKNOWN = '?';
const UNKNOWN_NAME = '（不明）';

// ── 小さな道具 ──

const $ = (sel, el = document) => el.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const store = {
  get(k, d) {
    try { const v = localStorage.getItem('stn_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('stn_' + k, JSON.stringify(v)); } catch (e) { /* 保存できなくても動くように */ }
  },
  del(k) {
    try { localStorage.removeItem('stn_' + k); } catch (e) { /* 同上 */ }
  }
};

function deviceId() {
  let d = store.get('device');
  if (!d) { d = 'D' + Math.random().toString(36).slice(2, 10); store.set('device', d); }
  return d;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function today() { return ymd(new Date()); }

function dateLabel(s, withYear) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s || '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const w = '日月火水木金土'[d.getDay()];
  return (withYear ? m[1] + '年' : '') + (+m[2]) + '月' + (+m[3]) + '日（' + w + '）';
}

// 年度は4月はじまり
function fiscalStart(offset) {
  const d = new Date();
  const y = (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1) + (offset || 0);
  return y + '-04-01';
}

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms || 2600);
}

function b64url(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function rateText(w, l) {
  return w + l ? (w / (w + l) * 100).toFixed(1) + '%' : '—';
}

function byName(a, b) { return a.localeCompare(b, 'ja'); }

// ── スプレッドシート（Apps Script）とのやりとり ──
// 学校アカウントにログインしたままのブラウザでも動くよう、<script> タグ（JSONP）で呼び出す

function callApi(action, params) {
  return new Promise((resolve, reject) => {
    if (typeof API_URL === 'undefined' || !API_URL) { reject(Object.assign(new Error('スプレッドシートとまだつながっていません（config.js の API_URL を設定してください）'), { server: true })); return; }
    const cb = '__stn' + Date.now() + Math.floor(Math.random() * 10000);
    const s = document.createElement('script');
    const timer = setTimeout(() => { done(); reject(new Error('スプレッドシートから応答がありません')); }, 40000);
    function done() { clearTimeout(timer); delete window[cb]; s.remove(); }
    window[cb] = data => {
      done();
      if (data && data.ok) resolve(data);
      else reject(Object.assign(new Error((data && data.error) || '読み込みに失敗しました'), { server: true }));
    };
    s.onerror = () => { done(); reject(new Error('スプレッドシートに接続できませんでした')); };
    const q = Object.assign({ action, key: store.get('key', '') }, params || {});
    if (store.get('admin')) q.admin = store.get('admin');
    if (q.data !== undefined) q.data = b64url(q.data);
    q.callback = cb;
    q.t = Date.now();
    s.src = API_URL + '?' + new URLSearchParams(q);
    document.head.appendChild(s);
  });
}

// ── データ ──

const DB = { home: (typeof HOME_SCHOOL !== 'undefined' && HOME_SCHOOL) || '', players: [], matches: [], byId: new Map(), loaded: false };

function setData(d) {
  DB.home = d.homeSchool || DB.home;
  DB.players = d.players || [];
  DB.matches = d.matches || [];
  DB.loaded = true;
  reindex();
}

function reindex() {
  DB.byId = new Map(DB.players.map(p => [p.id, p]));
  store.set('cache', { homeSchool: DB.home, players: DB.players, matches: DB.matches });
}

const isActive = p => p.status !== '引退';
const gradeNum = p => parseInt(p.grade, 10) || 0;
const gradeText = p => (p && p.grade ? p.grade + '年' : '');

function sortPlayers(list) {
  return list.slice().sort((a, b) => (gradeNum(b) || -1) - (gradeNum(a) || -1) || byName(a.name, b.name));
}

function playersOf(school, gender, withRetired) {
  return sortPlayers(DB.players.filter(p => p.school === school && (!gender || p.gender === gender) && (withRetired || isActive(p))));
}

function allSchools() {
  const set = new Set(DB.players.map(p => p.school));
  DB.matches.forEach(m => set.add(m.oppSchool));
  set.delete(DB.home);
  set.delete('');
  return [...set].sort(byName);
}

function pName(id, fallback) {
  if (id === UNKNOWN) return UNKNOWN_NAME;
  const p = DB.byId.get(id);
  return p ? p.name : (fallback || UNKNOWN_NAME);
}

// 1試合を「A側（入力した自校のペア）」「B側（相手）」に分けて扱う
// 名前は今の名簿の名前を使う（名簿で名前を直したら、過去の試合も新しい名前で出る）
function slotNames(names, ids) {
  return names.map((n, i) => (ids[i] && DB.byId.has(ids[i]) ? DB.byId.get(ids[i]).name : n)).filter(Boolean);
}

function sidesOf(m) {
  return [
    { ids: [m.my1Id, m.my2Id].filter(Boolean), names: slotNames([m.my1, m.my2], [m.my1Id, m.my2Id]), school: DB.home, res: m.result },
    { ids: [m.opp1Id, m.opp2Id].filter(Boolean), names: slotNames([m.opp1, m.opp2], [m.opp1Id, m.opp2Id]), school: m.oppSchool, res: m.result === '勝' ? '負' : m.result === '負' ? '勝' : '-' }
  ];
}

function sideOf(m, id) {
  const s = sidesOf(m);
  if (s[0].ids.includes(id)) return { me: s[0], them: s[1], flip: false };
  if (s[1].ids.includes(id)) return { me: s[1], them: s[0], flip: true };
  return null;
}

function scoreText(m, flip) {
  const a = flip ? m.oppGames : m.myGames, b = flip ? m.myGames : m.oppGames;
  let t = a + '-' + b;
  if (m.finalMy !== '' && m.finalOpp !== '' && m.finalMy != null) t += '（F' + (flip ? m.finalOpp + '-' + m.finalMy : m.finalMy + '-' + m.finalOpp) + '）';
  return t;
}

function sideLabel(side) {
  return side.names.length ? side.names.join('・') : UNKNOWN_NAME;
}

// 勝率に数える試合か
function counts(m, withAbort) {
  return m.result !== '-' && (withAbort || m.end !== '打ち切り');
}

// よく組むペア（ペアが変わったときにすぐ切りかわるよう、最近の20試合で数える）
function partnerFreq(meId) {
  const c = new Map();
  DB.matches.filter(m => sideOf(m, meId))
    .sort((a, b) => (b.date + (b.createdAt || '')).localeCompare(a.date + (a.createdAt || '')))
    .slice(0, 20)
    .forEach(m => {
      sideOf(m, meId).me.ids.forEach(id => { if (id !== meId && id !== UNKNOWN) c.set(id, (c.get(id) || 0) + 1); });
    });
  return c;
}

function schoolFreq(gender) {
  const c = new Map();
  DB.matches.forEach(m => { if (m.gender === gender && m.oppSchool) c.set(m.oppSchool, (c.get(m.oppSchool) || 0) + 1); });
  return c;
}

function oppPairFreq(school, gender) {
  const c = new Map();
  DB.matches.forEach(m => {
    if (m.gender !== gender) return;
    sidesOf(m).forEach(s => {
      if (s.school !== school || s.ids.length !== 2 || s.ids.some(id => !DB.byId.has(id) || !isActive(DB.byId.get(id)))) return;
      const k = s.ids.slice().sort().join('+');
      c.set(k, (c.get(k) || 0) + 1);
    });
  });
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

function recentTournaments() {
  const seen = new Set(), out = [];
  DB.matches.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).forEach(m => {
    if (m.tournament && !seen.has(m.tournament)) { seen.add(m.tournament); out.push(m.tournament); }
  });
  return out;
}

// ── 送信待ち（電波が悪いとき） ──

function pending() { return store.get('pending', []); }

// 試合の中身がおかしくて、何回送っても登録できないエラーか（それ以外のエラーは送信待ちに残して、あとで送り直す）
function isBadMatchError(e) {
  return !!e.server && /選んでください|試合の内容|性別は/.test(e.message);
}

function addLocalMatch(m) {
  if (!DB.matches.some(x => x.id === m.id)) DB.matches.push(m);
  reindex();
}

function setPending(list) {
  store.set('pending', list);
  renderSync();
}

let flushing = false;

async function flushPending() {
  if (flushing || !pending().length) return;
  flushing = true;
  let sent = 0;
  try {
    for (const m of pending()) {
      try {
        const r = await callApi('addMatch', { data: m });
        setPending(pending().filter(x => x.id !== m.id));
        addLocalMatch(r.match);
        sent++;
      } catch (e) {
        if (isBadMatchError(e)) {
          setPending(pending().filter(x => x.id !== m.id));
          alert('送信できなかった試合があります：' + e.message);
        } else {
          break;
        }
      }
    }
  } finally {
    flushing = false;
  }
  if (sent) { toast('送信待ちの試合を ' + sent + ' 件送りました'); renderTab(); } else renderRecent();
}

function renderSync(msg) {
  const el = $('#sync');
  const n = pending().length;
  if (msg) { el.innerHTML = esc(msg); el.hidden = false; return; }
  if (n) {
    el.innerHTML = '送信待ちの試合が ' + n + ' 件あります（電波が戻ると自動で送ります） <button class="link" data-act="flush">今すぐ送る</button>';
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ── 画面の切り替え ──

let currentTab = 'entry';

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['entry', 'stats', 'daily', 'players', 'pdf'].forEach(t => { $('#p-' + t).hidden = t !== tab; });
  $('#login').hidden = true;
  renderTab();
  window.scrollTo(0, 0);
  // ほかの人が入力した試合も見えるよう、1分以上たっていたら読み直す
  if (tab !== 'entry' && lastLoad && Date.now() - lastLoad > 60000) refresh();
}

function renderTab() {
  ({ entry: renderEntry, stats: renderStats, daily: renderDaily, players: renderPlayers, pdf: renderPdf })[currentTab]();
}

function showLogin(msg) {
  ['entry', 'stats', 'daily', 'players', 'pdf'].forEach(t => { $('#p-' + t).hidden = true; });
  $('#login').hidden = false;
  $('#login-msg').textContent = msg || '';
  $('#login-key').focus();
}

let lastLoad = 0;

async function refresh() {
  try {
    const d = await callApi('data');
    setData(d);
    lastLoad = Date.now();
    if (!F.me && !F.fromPdf) loadMe();
    renderSync();
    renderTab();
    flushPending();
  } catch (e) {
    if (e.message === '合言葉がちがいます' || /PASSWORD/.test(e.message)) {
      store.del('key');
      showLogin(e.message);
    } else {
      renderSync('最新の情報を読み込めませんでした（' + e.message + '）。この端末に残っている情報を表示しています。');
    }
  }
}

// ═════════ 試合入力 ═════════

// 同じ日にアプリを開き直しても、大会名と試合の形式（何ゲームか）は残す
const DAY = store.get('day', {});
const sameDay = DAY.date === today();

const F = {
  date: today(),
  tournament: sameDay ? DAY.tournament || '' : '',
  event: store.get('event', 'ダブルス'),
  gender: store.get('gender', '男子'),
  me: '', partner: '', school: '', opp: ['', ''],
  format: sameDay && DAY.format ? DAY.format : 7, end: '', myG: null, opG: null, fMy: '', fOp: '', result: '',
  edit: {}, schoolQ: '', fromPdf: null
};

const pairSize = () => (F.event === 'シングルス' ? 1 : 2);

function saveDay() {
  if (F.date === today()) store.set('day', { date: F.date, tournament: F.tournament.trim(), format: F.format });
}

function loadMe() {
  const id = store.get('me_' + F.gender, '');
  F.me = DB.byId.has(id) ? id : '';
  F.partner = '';
  if (F.me) autoPartner();
}

function autoPartner() {
  if (pairSize() < 2 || F.partner || !F.me) return;
  const best = [...partnerFreq(F.me).entries()]
    .filter(([id]) => DB.byId.has(id) && isActive(DB.byId.get(id)) && DB.byId.get(id).gender === F.gender)
    .sort((a, b) => b[1] - a[1])[0];
  if (best) F.partner = best[0];
}

function chip(act, v, label, opts) {
  opts = opts || {};
  const cls = ['chip', opts.on ? 'on' : '', opts.fav ? 'fav' : '', opts.cls || ''].join(' ');
  return '<button class="' + cls + '" data-act="' + act + '" data-v="' + esc(v) + '">' + esc(label) + (opts.sub ? '<small>' + esc(opts.sub) + '</small>' : '') + '</button>';
}

function seg(act, items, cur) {
  return items.map(it => {
    const v = Array.isArray(it) ? it[0] : it, label = Array.isArray(it) ? it[1] : it;
    return '<button data-act="' + act + '" data-v="' + esc(v) + '" class="' + (String(cur) === String(v) ? 'on' : '') + '">' + esc(label) + '</button>';
  }).join('');
}

function picked(label, value, sub, editKey) {
  return '<div class="picked"><span class="lbl">' + esc(label) + '</span><span class="grow"><b>' + esc(value) + '</b> <small class="muted">' + esc(sub || '') + '</small></span>' +
    '<button class="btn small" data-act="edit" data-v="' + editKey + '">変える</button></div>';
}

function renderEntry() {
  $('#e-date').value = F.date;
  $('#e-tournament').value = F.tournament;
  $('#e-tournaments').innerHTML = recentTournaments().slice(0, 6).map(t => chip('tournament', t, t, { on: t === F.tournament })).join('');
  $('#e-event').innerHTML = seg('event', ['ダブルス', 'シングルス'], F.event);
  $('#e-gender').innerHTML = seg('gender', ['男子', '女子'], F.gender);
  $('#e-from-pdf').innerHTML = F.fromPdf
    ? '<div class="sync">PDF から「' + esc(F.fromPdf.label) + '」の試合を入力中です。 <button class="link" data-act="backToPdf">PDF取込に戻る</button></div>' : '';
  renderMe();
  renderSchool();
  renderOpp();
  renderScore();
  renderRecent();
}

function renderMe() {
  const home = playersOf(DB.home, F.gender);
  let h = '';
  if (!home.length) {
    h = '<p class="muted">名簿に自校（' + esc(DB.home) + '）の' + F.gender + 'がいません。</p>' + '<div class="chips">' + chip('addHome', 'me', '＋選手を追加', { cls: 'add' }) + '</div>';
    $('#e-me').innerHTML = h;
    $('#e-partner').innerHTML = '';
    return;
  }
  if (F.me && !F.edit.me) {
    h = picked(pairSize() === 2 ? '自分' : '選手', pName(F.me), gradeText(DB.byId.get(F.me)), 'me');
  } else {
    h = '<div class="label">あなたの名前（この端末で覚えます）</div><div class="chips">' +
      home.map(p => chip('me', p.id, p.name, { on: p.id === F.me, sub: gradeText(p) })).join('') + chip('addHome', 'me', '＋追加', { cls: 'add' }) + '</div>';
  }
  $('#e-me').innerHTML = h;

  let ph = '';
  if (pairSize() === 2) {
    if (!F.me) {
      ph = '<p class="muted">先に自分の名前を選んでください。</p>';
    } else if (F.partner && !F.edit.partner) {
      ph = picked('ペア', pName(F.partner), gradeText(DB.byId.get(F.partner)), 'partner');
    } else {
      const freq = partnerFreq(F.me);
      const list = home.filter(p => p.id !== F.me).sort((a, b) => (freq.get(b.id) || 0) - (freq.get(a.id) || 0));
      ph = '<div class="label">ペア（よく組む人が先に出ます）</div><div class="chips">' +
        list.map(p => chip('partner', p.id, p.name, { on: p.id === F.partner, fav: freq.get(p.id), sub: freq.get(p.id) ? freq.get(p.id) + '回' : gradeText(p) })).join('') +
        chip('addHome', 'partner', '＋追加', { cls: 'add' }) + '</div>';
    }
  }
  $('#e-partner').innerHTML = ph;
}

// mySchool：見ている側の学校（ほかの学校の選手から見た自校は「部内」ではなく学校名で出す）
function schoolLabel(s, mySchool) {
  return s === DB.home && (mySchool === undefined || mySchool === DB.home) ? '部内（自校対決）' : s;
}

function renderSchool() {
  if (F.school && !F.edit.school) {
    $('#e-school').innerHTML = picked('相手校', schoolLabel(F.school), '', 'school');
    return;
  }
  const freq = schoolFreq(F.gender);
  const fav = [...freq.entries()].filter(([s]) => s !== DB.home).sort((a, b) => b[1] - a[1]).slice(0, 8).map(e => e[0]);
  $('#e-school').innerHTML =
    '<div class="label">相手の学校</div><div class="chips small">' +
    chip('school', DB.home, '部内（自校対決）', { on: F.school === DB.home }) +
    fav.map(s => chip('school', s, s, { on: s === F.school, fav: true })).join('') + '</div>' +
    '<div class="label">学校名で探す</div><input id="e-school-q" type="search" placeholder="例：小松" value="' + esc(F.schoolQ) + '" autocomplete="off">' +
    '<div id="e-school-results" style="margin-top:8px"></div>';
  renderSchoolResults();
}

function renderSchoolResults() {
  const box = $('#e-school-results');
  if (!box) return;
  const q = F.schoolQ.normalize('NFKC').trim();
  const list = allSchools().filter(s => !q || s.includes(q));
  box.innerHTML = '<div class="chips">' + list.map(s => chip('school', s, s, { on: s === F.school })).join('') +
    (q && !list.includes(q) ? chip('newSchool', q, '「' + q + '」を追加', { cls: 'add' }) : '') + '</div>';
}

function oppComplete() {
  return F.opp.slice(0, pairSize()).every(Boolean);
}

function renderOpp() {
  const box = $('#e-opp');
  if (!F.school) { box.innerHTML = ''; return; }
  const n = pairSize();
  if (oppComplete() && !F.edit.opp) {
    box.innerHTML = picked('相手', F.opp.slice(0, n).map(id => pName(id)).join('・'), '', 'opp');
    return;
  }
  const exclude = F.school === DB.home ? [F.me, F.partner] : [];
  const list = playersOf(F.school, F.gender).filter(p => !exclude.includes(p.id));
  const pairs = n === 2 ? oppPairFreq(F.school, F.gender).filter(([k]) => !k.split('+').some(id => exclude.includes(id))).slice(0, 4) : [];
  let h = '<div class="label">相手の選手（' + n + '人選んでください）</div>';
  if (pairs.length) {
    h += '<div class="chips small" style="margin-bottom:8px">' +
      pairs.map(([k, c]) => chip('oppPair', k, k.split('+').map(id => pName(id)).join('・') + '（' + c + '回）', { fav: true, on: F.opp.slice().sort().join('+') === k })).join('') + '</div>';
  }
  h += '<div class="chips">' + list.map(p => chip('opp', p.id, p.name, { on: F.opp.includes(p.id), sub: gradeText(p) })).join('') +
    chip('opp', UNKNOWN, '不明', { on: F.opp.includes(UNKNOWN), cls: 'add', sub: '名前がわからない' }) +
    chip('addOpp', '', '＋追加', { cls: 'add', sub: '名簿にない選手' }) + '</div>';
  if (!list.length) h += '<p class="muted">この学校の' + F.gender + 'は名簿にいません。「＋追加」で追加できます。</p>';
  box.innerHTML = h;
}

const FINAL_WIN = [[7, 0], [7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [8, 6], [9, 7], [10, 8], [11, 9]];

function renderScore() {
  const n = (F.format + 1) / 2;
  let h = '<div class="label">試合の形式</div><div class="seg">' + seg('format', [[7, '7ゲーム'], [5, '5ゲーム'], [9, '9ゲーム'], [3, '3ゲーム']], F.format) + '</div>' +
    '<div class="seg">' + seg('end', [['', '最後までやった'], ['打ち切り', '途中で終わった（打ち切り・棄権）']], F.end) + '</div>';
  if (F.end !== '打ち切り') {
    const win = [], lose = [];
    for (let i = 0; i < n; i++) { win.push([n, i]); lose.push([i, n]); }
    const sc = ([a, b]) => {
      const on = F.myG === a && F.opG === b;
      const fin = Math.max(a, b) === n && Math.min(a, b) === n - 1 && n > 1;
      return '<button class="chip ' + (a > b ? 'w' : 'l') + (on ? ' on' : '') + '" data-act="score" data-v="' + a + '-' + b + '">' + a + '-' + b + (fin ? '<small>ファイナル</small>' : '') + '</button>';
    };
    h += '<div class="label" style="color:var(--win)">勝ち</div><div class="score-grid">' + win.map(sc).join('') + '</div>' +
      '<div class="label" style="color:var(--lose)">負け</div><div class="score-grid">' + lose.map(sc).join('') + '</div>';
    if (F.myG != null && Math.max(F.myG, F.opG) === n && Math.min(F.myG, F.opG) === n - 1 && n > 1) {
      const won = F.myG > F.opG;
      h += '<div class="final-box"><div class="label">ファイナルゲームの点数（わかれば）</div><div class="nums">' +
        FINAL_WIN.map(([a, b]) => {
          const [x, y] = won ? [a, b] : [b, a];
          return '<button class="chip' + (String(F.fMy) === String(x) && String(F.fOp) === String(y) ? ' on' : '') + '" data-act="final" data-v="' + x + '-' + y + '">' + x + '-' + y + '</button>';
        }).join('') + '</div>' +
        '<div class="vs-inputs"><span class="muted">その他：自分たち</span><input id="f-my" type="number" inputmode="numeric" min="0" value="' + esc(F.fMy) + '">' +
        '<span>-</span><input id="f-op" type="number" inputmode="numeric" min="0" value="' + esc(F.fOp) + '"><span class="muted">相手</span></div></div>';
    }
  } else {
    const nums = (act, cur) => '<div class="nums">' + Array.from({ length: n + 1 }, (_, i) =>
      '<button class="chip' + (cur === i ? ' on' : '') + '" data-act="' + act + '" data-v="' + i + '">' + i + '</button>').join('') + '</div>';
    h += '<div class="label">終わったときのゲーム数：自分たち</div>' + nums('abortMy', F.myG) +
      '<div class="label">終わったときのゲーム数：相手</div>' + nums('abortOp', F.opG) +
      '<div class="label">結果</div><div class="seg">' + seg('abortResult', [['勝', '勝ち'], ['負', '負け'], ['-', '決着なし']], F.result) + '</div>';
  }
  $('#e-score').innerHTML = h;
  renderSummary();
}

function entryError() {
  if (!F.date) return '試合日を選んでください';
  if (!F.me) return '自分の名前を選んでください';
  if (pairSize() === 2 && !F.partner) return 'ペアを選んでください';
  if (!F.school) return '相手の学校を選んでください';
  if (!oppComplete()) return '相手の選手を選んでください（わからなければ「不明」）';
  if (F.myG == null || F.opG == null) return 'スコアを選んでください';
  if (F.end === '打ち切り' && !F.result) return '結果（勝ち・負け・決着なし）を選んでください';
  return '';
}

function renderSummary() {
  const el = $('#e-summary');
  const err = entryError();
  if (err) { el.innerHTML = '<span class="muted">' + esc(err) + '</span>'; return; }
  const m = buildMatch();
  const res = m.result === '勝' ? '<span class="w">勝ち</span>' : m.result === '負' ? '<span class="l">負け</span>' : '決着なし';
  el.innerHTML = esc([m.my1, m.my2].filter(Boolean).join('・')) + ' vs ' + esc(schoolLabel(m.oppSchool) + ' ' + [m.opp1, m.opp2].filter(Boolean).join('・')) +
    '　<b>' + esc(scoreText(m)) + '</b> ' + res + (m.end ? '<span class="tag">打ち切り</span>' : '');
}

function buildMatch() {
  const n = pairSize();
  const ids = [F.me, n === 2 ? F.partner : ''];
  const opp = F.opp.slice(0, n).concat(['', '']).slice(0, 2);
  const nm = id => (id ? pName(id) : '');
  const realId = id => (id === UNKNOWN ? '' : id);
  const result = F.end === '打ち切り' ? F.result : (F.myG > F.opG ? '勝' : '負');
  return {
    id: newId('M'), date: F.date, tournament: F.tournament.trim(), event: F.event, gender: F.gender, format: F.format,
    my1: nm(ids[0]), my2: nm(ids[1]), oppSchool: F.school, opp1: nm(opp[0]), opp2: nm(opp[1]),
    myGames: F.myG, oppGames: F.opG,
    finalMy: F.end === '打ち切り' ? '' : F.fMy, finalOpp: F.end === '打ち切り' ? '' : F.fOp,
    end: F.end, result,
    my1Id: ids[0], my2Id: ids[1], opp1Id: realId(opp[0]), opp2Id: realId(opp[1]),
    enteredBy: nm(store.get('me_' + F.gender, '')) || '', device: deviceId()
  };
}

async function submitMatch(btn) {
  const err = entryError();
  if (err) { toast(err); return; }
  const m = buildMatch();
  setPending(pending().concat([m]));
  btn.disabled = true;
  btn.textContent = '送信中…';
  try {
    const r = await callApi('addMatch', { data: m });
    setPending(pending().filter(x => x.id !== m.id));
    addLocalMatch(r.match);
    toast('登録しました（' + (m.result === '勝' ? '勝ち' : m.result === '負' ? '負け' : '決着なし') + ' ' + scoreText(m) + '）');
    afterSubmit();
  } catch (e) {
    if (isBadMatchError(e)) {
      setPending(pending().filter(x => x.id !== m.id));
      alert('登録できませんでした：' + e.message);
    } else {
      toast(e.server ? '登録できなかったので「送信待ち」にしました（' + e.message + '）' : '電波が弱いので「送信待ち」にしました。つながったら自動で送ります', 4000);
      afterSubmit();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '登録する';
  }
}

// 続けて入力しやすいよう、日付・大会・自分たちのペア・相手校は残す
function afterSubmit() {
  if (F.fromPdf) { pdfState.done.add(F.fromPdf.key); }
  saveDay();
  dailyDate = F.date;
  F.opp = ['', ''];
  F.myG = F.opG = null;
  F.fMy = F.fOp = '';
  F.result = '';
  F.end = '';
  F.edit = { school: !!F.fromPdf };
  if (F.fromPdf) { F.school = ''; }
  renderEntry();
  const target = F.fromPdf ? $('#e-from-pdf') : $('.side.opp');
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function matchLine(m, opts) {
  opts = opts || {};
  const persp = (opts.player && sideOf(m, opts.player)) || { me: sidesOf(m)[0], them: sidesOf(m)[1], flip: false };
  const flip = persp.flip;
  const res = persp.me.res;
  const mark = res === '勝' ? '<span class="res w">○</span>' : res === '負' ? '<span class="res l">●</span>' : '<span class="res">△</span>';
  return '<div class="match">' + mark + '<div class="body">' +
    '<div>' + esc(sideLabel(persp.me)) + ' <span class="muted">vs</span> ' + esc(sideLabel(persp.them)) + ' <span class="muted">（' + esc(schoolLabel(persp.them.school, persp.me.school)) + '）</span></div>' +
    '<div class="meta">' + esc(dateLabel(m.date)) + ' ' + esc(m.tournament || '') + (m.format && m.format !== '7' && m.format !== 7 ? ' ・' + m.format + 'ゲーム' : '') + (m.event === 'シングルス' ? ' ・シングルス' : '') + '</div>' +
    '</div><div class="sc">' + esc(scoreText(m, flip)) + (m.end ? '<span class="tag">打ち切り</span>' : '') + (opts.pending ? '<span class="tag pending">送信待ち</span>' : '') + '</div>' +
    (opts.del ? '<button class="btn small danger" data-act="delMatch" data-v="' + esc(m.id) + '">消す</button>' : '') + '</div>';
}

function renderRecent() {
  const dev = deviceId();
  const mine = DB.matches.filter(m => m.device === dev).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 30);
  const pend = pending();
  const h = pend.map(m => matchLine(m, { pending: true })).join('') + mine.map(m => matchLine(m, { del: true })).join('');
  $('#e-recent').innerHTML = h || '<p class="muted">まだありません。</p>';
}

async function deleteMatch(id) {
  const m = DB.matches.find(x => x.id === id);
  if (!m || !confirm(dateLabel(m.date) + '　' + sideLabel(sidesOf(m)[0]) + ' vs ' + sideLabel(sidesOf(m)[1]) + '　' + scoreText(m) + '\nこの試合を消しますか？')) return;
  try {
    await callApi('deleteMatch', { id, device: deviceId() });
    DB.matches = DB.matches.filter(x => x.id !== id);
    reindex();
    toast('消しました');
    renderTab();
  } catch (e) {
    alert('消せませんでした：' + e.message);
  }
}

async function addPlayerQuick(school, gender, defaultName) {
  const name = prompt((school === DB.home ? '自校' : school) + 'の' + gender + 'の選手を追加します。氏名（名字だけでも可）を入れてください', defaultName || '');
  if (!name || !name.trim()) return null;
  let grade = '';
  if (school === DB.home) grade = (prompt('学年を数字で入れてください（わからなければ空のまま）', '') || '').trim();
  try {
    const r = await callApi('addPlayer', { data: { name: name.trim(), gender, grade, school } });
    if (!DB.byId.has(r.player.id)) DB.players.push(r.player);
    reindex();
    toast(r.player.name + 'を追加しました');
    return r.player.id;
  } catch (e) {
    alert('追加できませんでした：' + e.message);
    return null;
  }
}

async function onEntryAction(act, v, btn) {
  switch (act) {
    case 'tournament': F.tournament = v; $('#e-tournament').value = v; saveDay(); break;
    case 'event':
      F.event = v; store.set('event', v);
      if (v === 'シングルス') { F.partner = ''; F.opp[1] = ''; } else autoPartner();
      break;
    case 'gender':
      if (F.gender === v) return;
      F.gender = v; store.set('gender', v);
      F.opp = ['', '']; F.edit = {};
      loadMe();
      break;
    case 'edit': F.edit[v] = true; break;
    case 'me':
      // 自分を変えたら、その人がよく組むペアを入れ直す
      if (F.me !== v || F.partner === v) F.partner = '';
      F.me = v; store.set('me_' + F.gender, v);
      F.edit.me = false; F.edit.partner = false;
      autoPartner();
      break;
    case 'partner': F.partner = v; F.edit.partner = false; break;
    case 'addHome': {
      const id = await addPlayerQuick(DB.home, F.gender);
      if (!id) return;
      if (v === 'me') { F.me = id; F.partner = ''; store.set('me_' + F.gender, id); F.edit.me = false; autoPartner(); } else { F.partner = id; F.edit.partner = false; }
      break;
    }
    case 'school':
      if (F.school !== v) F.opp = ['', ''];
      F.school = v; F.edit.school = false; F.edit.opp = true; F.schoolQ = '';
      break;
    case 'newSchool':
      if (!confirm('「' + v + '」を新しい学校として使いますか？\n（選手を追加すると名簿に入ります）')) return;
      F.school = v; F.opp = ['', '']; F.edit.school = false; F.edit.opp = true; F.schoolQ = '';
      break;
    case 'opp': {
      const n = pairSize();
      const cur = F.opp.slice(0, n);
      const i = cur.indexOf(v);
      if (i >= 0 && v !== UNKNOWN) cur[i] = '';
      else {
        const empty = cur.indexOf('');
        cur[empty >= 0 ? empty : n - 1] = v;
      }
      F.opp = cur.concat(['', '']).slice(0, 2);
      if (oppComplete()) F.edit.opp = false;
      break;
    }
    case 'oppPair': F.opp = v.split('+'); F.edit.opp = false; break;
    case 'addOpp': {
      const id = await addPlayerQuick(F.school, F.gender);
      if (!id) return;
      onEntryAction('opp', id);
      return;
    }
    case 'format': F.format = +v; F.myG = F.opG = null; F.fMy = F.fOp = ''; F.result = ''; saveDay(); break;
    case 'end': F.end = v; F.myG = F.opG = null; F.fMy = F.fOp = ''; F.result = ''; break;
    case 'score': {
      const [a, b] = v.split('-').map(Number);
      if (F.myG !== a || F.opG !== b) { F.fMy = F.fOp = ''; }
      F.myG = a; F.opG = b;
      break;
    }
    case 'final': {
      const [a, b] = v.split('-');
      if (F.fMy === a && F.fOp === b) { F.fMy = F.fOp = ''; } else { F.fMy = a; F.fOp = b; }
      break;
    }
    case 'abortMy': F.myG = +v; break;
    case 'abortOp': F.opG = +v; break;
    case 'abortResult': F.result = v; break;
    case 'submit': submitMatch(btn); return;
    case 'delMatch': deleteMatch(v); return;
    case 'backToPdf': F.fromPdf = null; showTab('pdf'); return;
    default: return;
  }
  renderEntry();
}

// ═════════ 戦績 ═════════

const S = { mode: '個人', gender: '全員', school: '自校', period: '今年度', from: '', to: '', tournament: '', q: '', abort: false, sort: 'rate', dir: -1 };

function statMatches(includeUndecided) {
  let from = '', to = '';
  if (S.period === '今年度') from = fiscalStart(0);
  if (S.period === '昨年度') { from = fiscalStart(-1); to = ymd(new Date(+fiscalStart(0).slice(0, 4), 2, 31)); }
  if (S.period === '期間指定') { from = S.from; to = S.to; }
  return DB.matches.filter(m => (!from || m.date >= from) && (!to || m.date <= to) &&
    (S.gender === '全員' || m.gender === S.gender) &&
    (!S.tournament || m.tournament === S.tournament) &&
    (includeUndecided || counts(m, S.abort)));
}

function addWL(rec, res) {
  rec.n++;
  if (res === '勝') rec.w++;
  else if (res === '負') rec.l++;
}

function renderStats() {
  $('#s-mode').innerHTML = seg('sMode', ['個人', 'ペア'], S.mode);
  $('#s-gender').innerHTML = seg('sGender', ['全員', '男子', '女子'], S.gender);
  $('#s-school').innerHTML = seg('sSchool', [['自校', '自校（' + DB.home + '）'], ['全学校', 'ほかの学校も']], S.school);
  $('#s-period').innerHTML = seg('sPeriod', ['今年度', '昨年度', '全期間', '期間指定'], S.period);
  $('#s-range').hidden = S.period !== '期間指定';
  const ts = recentTournaments();
  $('#s-tournament').innerHTML = '<option value="">すべて</option>' + ts.map(t => '<option' + (t === S.tournament ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
  $('#s-abort').checked = S.abort;

  const ms = statMatches();
  const q = S.q.normalize('NFKC').trim();
  let rows = [];
  if (S.mode === '個人') {
    const rec = new Map();
    ms.forEach(m => sidesOf(m).forEach(s => s.ids.forEach(id => {
      if (!rec.has(id)) rec.set(id, { n: 0, w: 0, l: 0 });
      addWL(rec.get(id), s.res);
    })));
    let players = DB.players.filter(p => (S.gender === '全員' || p.gender === S.gender) && (S.school === '全学校' || p.school === DB.home));
    players = players.filter(p => rec.has(p.id) || (S.school === '自校' && isActive(p)));
    rows = players.map(p => Object.assign({ key: p.id, name: p.name, sub: (S.school === '全学校' ? p.school + ' ' : '') + gradeText(p) + (S.gender === '全員' ? ' ' + p.gender : ''), school: p.school }, rec.get(p.id) || { n: 0, w: 0, l: 0 }));
  } else {
    const rec = new Map();
    ms.forEach(m => sidesOf(m).forEach(s => {
      if (s.ids.length !== 2) return;
      if (S.school === '自校' && s.school !== DB.home) return;
      const k = s.ids.slice().sort().join('+');
      if (!rec.has(k)) rec.set(k, { n: 0, w: 0, l: 0, school: s.school, gender: m.gender });
      addWL(rec.get(k), s.res);
    }));
    rows = [...rec.entries()].map(([k, r]) => Object.assign({ key: k, name: k.split('+').map(id => pName(id)).join('・'), sub: (S.school === '全学校' ? r.school + ' ' : '') + (S.gender === '全員' ? r.gender : '') }, r));
  }
  if (q) rows = rows.filter(r => r.name.includes(q) || (r.sub || '').includes(q));
  rows.forEach(r => { r.rate = r.w + r.l ? r.w / (r.w + r.l) : -1; });
  const key = S.sort;
  rows.sort((a, b) => key === 'name' ? S.dir * -byName(a.name, b.name) : S.dir * ((a[key] - b[key]) || (a.n - b.n)) || byName(a.name, b.name));

  const th = (k, label) => '<th data-act="sSort" data-v="' + k + '" class="' + (S.sort === k ? 'sorted' : '') + '">' + label + (S.sort === k ? (S.dir < 0 ? '▼' : '▲') : '') + '</th>';
  $('#s-table').innerHTML = rows.length
    ? '<table class="tbl"><thead><tr>' + th('name', S.mode === '個人' ? '選手' : 'ペア') + th('n', '試合') + th('w', '勝') + th('l', '負') + th('rate', '勝率') + '</tr></thead><tbody>' +
      rows.map(r => '<tr data-act="' + (S.mode === '個人' ? 'openPlayer' : 'openPair') + '" data-v="' + esc(r.key) + '"><td>' + esc(r.name) + (r.sub ? '<small>' + esc(r.sub) + '</small>' : '') + '</td><td>' + r.n + '</td><td>' + r.w + '</td><td>' + r.l + '</td><td class="rate">' + rateText(r.w, r.l) + '</td></tr>').join('') +
      '</tbody></table>'
    : '<div class="empty">この条件の試合はまだありません。</div>';
}

function wlTable(title, map, labelFn) {
  const rows = [...map.entries()].sort((a, b) => (b[1].w + b[1].l) - (a[1].w + a[1].l));
  if (!rows.length) return '';
  return '<div class="card flush"><table class="tbl"><thead><tr><th>' + esc(title) + '</th><th>勝</th><th>負</th><th>勝率</th></tr></thead><tbody>' +
    rows.map(([k, r]) => '<tr' + (r.act ? ' data-act="' + r.act + '" data-v="' + esc(k) + '"' : '') + '><td>' + esc(labelFn(k)) + '</td><td>' + r.w + '</td><td>' + r.l + '</td><td class="rate">' + rateText(r.w, r.l) + '</td></tr>').join('') +
    '</tbody></table></div>';
}

function openSheet(html) {
  // スマホの「戻る」で、アプリを閉じずにこの画面だけ閉じるように
  if ($('#sheet').hidden) { try { history.pushState({ sheet: 1 }, ''); } catch (e) { /* 使えなくても動く */ } }
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  $('.sheet-in').scrollTop = 0;
}

function closeSheet(fromBack) {
  if ($('#sheet').hidden) return;
  $('#sheet').hidden = true;
  if (!fromBack && history.state && history.state.sheet) history.back();
}

function detailHtml(title, sub, ms, perspId, groupers) {
  let w = 0, l = 0;
  ms.forEach(m => {
    const s = perspId(m);
    if (!counts(m, S.abort)) return;
    if (s.me.res === '勝') w++; else if (s.me.res === '負') l++;
  });
  let h = '<h2>' + esc(title) + '</h2><p class="muted" style="margin:0 4px">' + esc(sub) + '（' + esc(S.period) + (S.tournament ? '・' + S.tournament : '') + '）</p>' +
    '<div class="big-stat"><div><b>' + ms.length + '</b><span>試合</span></div><div><b style="color:var(--win)">' + w + '</b><span>勝</span></div><div><b style="color:var(--lose)">' + l + '</b><span>負</span></div><div><b>' + rateText(w, l) + '</b><span>勝率</span></div></div>';
  groupers.forEach(g => {
    const map = new Map();
    ms.forEach(m => {
      if (!counts(m, S.abort)) return;
      const s = perspId(m);
      const k = g.key(s, m);
      if (!k) return;
      if (!map.has(k)) map.set(k, { n: 0, w: 0, l: 0, act: g.act });
      addWL(map.get(k), s.me.res);
    });
    h += wlTable(g.title, map, g.label);
  });
  h += '<div class="card"><h3>試合の記録（新しい順）</h3>' +
    (ms.slice().sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt)).map(m => matchLine(m, { player: perspId(m).me.ids[0] || '' })).join('') || '<p class="muted">ありません</p>') + '</div>';
  return h;
}

function openPlayer(id) {
  const p = DB.byId.get(id);
  if (!p) return;
  const ms = statMatches(true).filter(m => sideOf(m, id));
  openSheet(detailHtml(p.name, p.school + ' ' + p.gender + ' ' + gradeText(p), ms, m => sideOf(m, id), [
    { title: 'ペア別', key: (s, m) => (m.event === 'シングルス' ? 'シングルス' : s.me.ids.filter(x => x !== id).join('+') || UNKNOWN), label: k => (k === 'シングルス' ? 'シングルス' : pName(k)), act: '' },
    { title: '相手校別', key: s => s.them.school, label: k => schoolLabel(k, p.school) },
    { title: '対戦相手別', key: s => (s.them.ids.length ? s.them.ids.slice().sort().join('+') : ''), label: k => k.split('+').map(x => pName(x)).join('・') }
  ]));
}

function openPair(key) {
  const ids = key.split('+');
  const ms = statMatches(true).filter(m => sidesOf(m).some(s => s.ids.length === 2 && s.ids.slice().sort().join('+') === key));
  const p = DB.byId.get(ids[0]);
  openSheet(detailHtml(ids.map(x => pName(x)).join('・'), (p ? p.school + ' ' + p.gender : ''), ms, m => sideOf(m, ids[0]), [
    { title: '相手校別', key: s => s.them.school, label: k => schoolLabel(k, p ? p.school : DB.home) },
    { title: '対戦相手別', key: s => (s.them.ids.length ? s.them.ids.slice().sort().join('+') : ''), label: k => k.split('+').map(x => pName(x)).join('・') }
  ]));
}

function onStatsAction(act, v) {
  switch (act) {
    case 'sMode': S.mode = v; if (S.sort === 'name') S.sort = 'rate'; break;
    case 'sGender': S.gender = v; break;
    case 'sSchool': S.school = v; break;
    case 'sPeriod': S.period = v; break;
    case 'sSort': if (S.sort === v) S.dir = -S.dir; else { S.sort = v; S.dir = v === 'name' ? 1 : -1; } break;
    case 'openPlayer': openPlayer(v); return;
    case 'openPair': openPair(v); return;
    default: return;
  }
  renderStats();
}

// ═════════ 日別 ═════════

let dailyDate = '';

function renderDaily() {
  const dates = [...new Set(DB.matches.map(m => m.date))].sort().reverse();
  if (!dailyDate) dailyDate = dates.includes(today()) || !dates.length ? today() : dates[0];
  $('#d-date').value = dailyDate;
  $('#d-dates').innerHTML = dates.slice(0, 10).map(d => chip('dDate', d, dateLabel(d), { on: d === dailyDate })).join('');
  const ms = DB.matches.filter(m => m.date === dailyDate);
  let h = '';
  ['男子', '女子'].forEach(g => {
    const gm = ms.filter(m => m.gender === g);
    if (!gm.length) return;
    const ids = new Set();
    gm.forEach(m => sidesOf(m).forEach(s => { if (s.school === DB.home) s.ids.forEach(id => ids.add(id)); }));
    const players = sortPlayers([...ids].map(id => DB.byId.get(id) || { id, name: pName(id), grade: '' }));
    h += '<div class="card"><h3>' + g + '（' + gm.length + '試合）</h3>' + players.map(p => {
      const mine = gm.filter(m => sideOf(m, p.id)).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      let w = 0, l = 0;
      mine.forEach(m => { const r = sideOf(m, p.id).me.res; if (r === '勝') w++; else if (r === '負') l++; });
      return '<div class="day-player"><div class="head"><span>' + esc(p.name) + ' <small class="muted">' + esc(gradeText(p)) + '</small></span><span class="wl">' + w + '勝' + l + '敗</span></div>' +
        mine.map(m => {
          const s = sideOf(m, p.id);
          const partner = s.me.ids.filter(x => x !== p.id).map(x => pName(x)).join('');
          const r = s.me.res === '勝' ? '<span class="w">○</span>' : s.me.res === '負' ? '<span class="l">●</span>' : '△';
          return '<div class="m">' + r + ' ' + esc(scoreText(m, s.flip)) + (m.end ? '（打ち切り）' : '') + (partner ? '　ペア：' + esc(partner) : '') +
            '　vs ' + esc(schoolLabel(s.them.school)) + ' ' + esc(sideLabel(s.them)) + (m.tournament ? ' <span class="muted">' + esc(m.tournament) + '</span>' : '') + '</div>';
        }).join('') + '</div>';
    }).join('') + '</div>';
  });
  $('#d-list').innerHTML = '<h2 style="margin:16px 4px 0;font-size:1.1rem">' + esc(dateLabel(dailyDate, true)) + 'の結果</h2>' + (h || '<div class="card empty">この日の試合はまだありません。</div>');
}

// ═════════ 選手 ═════════

const P = { gender: store.get('gender', '男子'), grade: '', filterSchool: '', filterGender: '全員', retired: false };

function renderPlayers() {
  const schools = [DB.home].concat(allSchools());
  if (!P.filterSchool) P.filterSchool = DB.home;
  $('#pl-gender').innerHTML = seg('plGender', ['男子', '女子'], P.gender);
  $('#pl-grade').innerHTML = seg('plGrade', [['1', '1年'], ['2', '2年'], ['3', '3年'], ['', 'なし・不明']], P.grade);
  if (!$('#pl-school').value) $('#pl-school').value = DB.home;
  $('#school-list').innerHTML = schools.map(s => '<option value="' + esc(s) + '">').join('');
  $('#pl-filter-school').innerHTML = schools.map(s => '<option' + (s === P.filterSchool ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
  $('#pl-filter-gender').innerHTML = seg('plFilterGender', ['全員', '男子', '女子'], P.filterGender);
  $('#pl-show-retired').checked = P.retired;

  const admin = !!store.get('admin');
  const list = playersOf(P.filterSchool, P.filterGender === '全員' ? '' : P.filterGender, P.retired);
  const rec = new Map();
  DB.matches.forEach(m => { if (counts(m, false)) sidesOf(m).forEach(s => s.ids.forEach(id => { if (!rec.has(id)) rec.set(id, { n: 0, w: 0, l: 0 }); addWL(rec.get(id), s.res); })); });
  $('#pl-list').innerHTML = list.map(p => {
    const r = rec.get(p.id) || { w: 0, l: 0 };
    return '<div class="pl-row"><span class="nm">' + esc(p.name) + '<small>' + esc([p.gender, gradeText(p), p.status].filter(Boolean).join(' ')) + '　' + r.w + '勝' + r.l + '敗</small></span>' +
      (admin ? '<button class="btn small" data-act="editPlayer" data-v="' + esc(p.id) + '">直す</button>' : '') + '</div>';
  }).join('') || '<p class="muted">登録されている選手はいません。</p>';

  $('#admin-box').innerHTML = admin
    ? '<h3>先生用メニュー</h3>' +
      '<button class="btn wide" data-act="importR8">令和8年度 県新人大会の名簿（' + 528 + '人）を取り込む</button>' +
      '<div class="label" style="margin-top:14px">名簿をまとめて取り込む</div>' +
      '<p class="muted">1行に1人。「学校・氏名・性別・学年」の順に、タブ（エクセルからコピー）かカンマで区切って貼り付けます。同じ学校・氏名・性別の人はふえません（学年だけ新しくなります）。</p>' +
      '<textarea id="import-text" placeholder="金沢錦丘	山田	男子	2"></textarea>' +
      '<button class="btn wide" data-act="importText">取り込む</button>' +
      '<div class="label" style="margin-top:14px">新年度になったら</div>' +
      '<button class="btn wide" data-act="promote">自校の学年を1つ上げる（3年生は「引退」にする）</button>' +
      '<p id="admin-msg" class="muted">' + esc(adminMsg) + '</p>' +
      '<button class="link" data-act="adminLogout">先生用メニューを閉じる</button>'
    : '<h3>先生用</h3><p class="muted">名簿の一括取込・選手の修正・学年の繰り上げは、先生用の合言葉で使えます。</p><button class="btn" data-act="adminLogin">先生用の合言葉を入れる</button>';
}

function parseRoster(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let order = ['school', 'name', 'gender', 'grade'];
  const rows = [];
  lines.forEach(line => {
    const cells = line.split(/\t|,|，/).map(c => c.trim());
    if (cells.some(c => c === '氏名' || c === '名前')) {
      order = cells.map(c => (/学校/.test(c) ? 'school' : /氏名|名前/.test(c) ? 'name' : /性別/.test(c) ? 'gender' : /学年/.test(c) ? 'grade' : ''));
      return;
    }
    const r = {};
    order.forEach((k, i) => { if (k) r[k] = cells[i] || ''; });
    if (r.name) rows.push(r);
  });
  return rows;
}

let adminMsg = '';

function setAdminMsg(t) {
  adminMsg = t;
  const el = $('#admin-msg');
  if (el) el.textContent = t;
}

async function importRows(rows) {
  let added = 0, updated = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += 40) {
    setAdminMsg('取り込み中… ' + i + ' / ' + rows.length);
    const r = await callApi('importPlayers', { data: rows.slice(i, i + 40) });
    added += r.added; updated += r.updated; errors.push(...r.errors);
  }
  setAdminMsg('取り込みました：新しく ' + added + ' 人、学年の更新 ' + updated + ' 人' + (errors.length ? '。取り込めなかった行：' + errors.join('、') : ''));
  await refresh();
}

function editPlayerSheet(id) {
  const p = DB.byId.get(id);
  if (!p) return;
  openSheet('<h2>選手を直す</h2><div class="card">' +
    '<label class="fld"><span>氏名</span><input id="ed-name" value="' + esc(p.name) + '"></label>' +
    '<label class="fld"><span>性別</span><select id="ed-gender"><option' + (p.gender === '男子' ? ' selected' : '') + '>男子</option><option' + (p.gender === '女子' ? ' selected' : '') + '>女子</option></select></label>' +
    '<label class="fld"><span>学年</span><input id="ed-grade" inputmode="numeric" value="' + esc(p.grade) + '"></label>' +
    '<label class="fld"><span>学校</span><input id="ed-school" list="school-list" value="' + esc(p.school) + '"></label>' +
    '<label class="check"><input type="checkbox" id="ed-retired"' + (p.status === '引退' ? ' checked' : '') + '> 引退（試合入力の名前の一覧に出なくなります）</label>' +
    '<button class="btn primary wide" data-act="savePlayer" data-v="' + esc(id) + '">保存する</button>' +
    '<button class="btn wide danger" data-act="deletePlayer" data-v="' + esc(id) + '">この選手を消す</button>' +
    '<p class="muted">名前を直すと、これまでの戦績にも新しい名前で表示されます。</p></div>');
}

async function onPlayersAction(act, v) {
  try {
    switch (act) {
      case 'plGender': P.gender = v; break;
      case 'plGrade': P.grade = v; break;
      case 'plFilterGender': P.filterGender = v; break;
      case 'addPlayer': {
        const name = $('#pl-name').value.trim();
        const school = $('#pl-school').value.trim();
        if (!name) { toast('氏名を入れてください'); return; }
        if (!school) { toast('学校を入れてください'); return; }
        const r = await callApi('addPlayer', { data: { name, gender: P.gender, grade: P.grade, school } });
        if (!DB.byId.has(r.player.id)) DB.players.push(r.player);
        reindex();
        $('#pl-name').value = '';
        P.filterSchool = r.player.school;
        toast(r.player.name + '（' + r.player.school + '）を登録しました');
        break;
      }
      case 'adminLogin': {
        const k = prompt('先生用の合言葉を入れてください');
        if (!k) return;
        await callApi('checkAdmin', { admin: k });
        store.set('admin', k);
        toast('先生用メニューを開きました');
        break;
      }
      case 'adminLogout': store.del('admin'); break;
      case 'importR8': {
        if (!confirm('令和8年度 石川県高校新人大会（ソフトテニス）の組み合わせから作った名簿を取り込みます。よろしいですか？')) return;
        const res = await fetch('data/r8-shinjin.tsv');
        if (!res.ok) throw new Error('名簿のファイルを読み込めませんでした');
        await importRows(parseRoster(await res.text()));
        break;
      }
      case 'importText': {
        const rows = parseRoster($('#import-text').value);
        if (!rows.length) { toast('取り込む行がありません'); return; }
        if (!confirm(rows.length + ' 人を取り込みます。よろしいですか？')) return;
        await importRows(rows);
        if ($('#import-text')) $('#import-text').value = '';
        break;
      }
      case 'promote': {
        if (!confirm('自校の在籍選手の学年を1つ上げ、3年生を「引退」にします。新年度に1回だけ行ってください。よろしいですか？')) return;
        const r = await callApi('promote');
        toast('学年を上げました（' + r.up + '人）。引退：' + r.retired + '人', 4000);
        await refresh();
        return;
      }
      case 'editPlayer': editPlayerSheet(v); return;
      case 'savePlayer': {
        const r = await callApi('updatePlayer', { data: { id: v, name: $('#ed-name').value, gender: $('#ed-gender').value, grade: $('#ed-grade').value, school: $('#ed-school').value, status: $('#ed-retired').checked ? '引退' : '' } });
        DB.players = DB.players.map(p => (p.id === v ? r.player : p));
        reindex();
        closeSheet();
        toast('保存しました');
        break;
      }
      case 'deletePlayer': {
        if (!confirm('この選手を名簿から消しますか？')) return;
        await callApi('deletePlayer', { id: v });
        DB.players = DB.players.filter(p => p.id !== v);
        reindex();
        closeSheet();
        toast('消しました');
        break;
      }
      default: return;
    }
  } catch (e) {
    alert(e.message);
    if (act === 'adminLogin') return;
  }
  renderPlayers();
}

// ═════════ PDF取込 ═════════

const pdfState = { entries: [], pages: [], done: new Set(), picked: {} };

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('PDF を読む部品を読み込めませんでした（インターネットにつながっているか確かめてください）'));
    document.head.appendChild(s);
  });
}

// PDF の文字を、位置をもとに行ごとに並べ直す（離れた文字の間には空白を2つ入れる）
async function pdfLines(file) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const items = content.items.filter(it => it.str && it.str.trim()).map(it => ({
      s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || it.height || 10
    }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    items.forEach(it => {
      const row = rows.find(r => Math.abs(r.y - it.y) < Math.min(r.h, it.h) * 0.5);
      if (row) row.items.push(it); else rows.push({ y: it.y, h: it.h, items: [it] });
    });
    rows.sort((a, b) => b.y - a.y);
    pages.push(rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let line = '', end = null;
      r.items.forEach(it => {
        if (end != null) {
          const gap = it.x - end;
          line += gap > it.h * 1.2 ? '   ' : gap > it.h * 0.2 ? ' ' : '';
        }
        line += it.s;
        end = it.x + it.w;
      });
      return line.replace(/　/g, ' ');
    }));
  }
  return pages;
}

function warekiDate(text) {
  let m = text.match(/(令和|R)\s*(\d+|元)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return (2018 + (m[2] === '元' ? 1 : +m[2])) + '-' + String(m[3]).padStart(2, '0') + '-' + String(m[4]).padStart(2, '0');
  m = text.match(/(20\d\d)\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  return '';
}

// 「1 西川・中島 能登」「安藤・松田 能登 22」のような組み合わせの行から、ペアを取り出す
function parseEntries(pages) {
  const out = [];
  pages.forEach((lines, pi) => {
    const head = lines.slice(0, 8).join(' ');
    const gender = /女子/.test(head) ? '女子' : /男子/.test(head) ? '男子' : '';
    lines.forEach((line, li) => {
      const L = /(?:^\s*|\s{2,})(\d{1,3})\s+(\S+・\S+)\s+(\S+?)(?=\s{2,}|\s*$)/g;
      const R = /(?:^\s*|\s{2,})(\S+・\S+)\s+(\S+)\s+(\d{1,3})\s*$/;
      let m;
      while ((m = L.exec(line))) out.push({ page: pi, line: li, gender, num: +m[1], names: m[2].split('・'), school: m[3] });
      m = line.match(R);
      if (m) out.push({ page: pi, line: li, gender, num: +m[3], names: m[1].split('・'), school: m[2] });
    });
  });
  return out;
}

async function readPdf(file) {
  const msg = $('#pdf-msg');
  msg.textContent = 'PDF を読んでいます…';
  try {
    const pages = await pdfLines(file);
    const all = pages.map(p => p.join('\n')).join('\n');
    const title = (pages[0] || []).find(l => /大会|選手権|リーグ|総体|新人/.test(l));
    $('#pdf-tournament').value = title ? title.trim().replace(/\s+/g, ' ') : file.name.replace(/\.pdf$/i, '');
    $('#pdf-date').value = warekiDate(all) || today();
    pdfState.pages = pages;
    pdfState.entries = parseEntries(pages);
    pdfState.done = new Set();
    pdfState.picked = {};
    const homeN = pdfState.entries.filter(e => e.school === DB.home).length;
    msg.textContent = pdfState.entries.length
      ? pdfState.entries.length + ' ペアを読み取り、そのうち自校（' + DB.home + '）は ' + homeN + ' ペアでした。'
      : 'ペア（「名前・名前 学校名」の形）を見つけられませんでした。文字が画像になっている PDF は読み取れません。';
  } catch (e) {
    msg.textContent = '読み取れませんでした：' + e.message;
  }
  renderPdf();
}

function entryKey(e) { return e.page + ':' + e.gender + ':' + e.num; }

function renderPdf() {
  const home = pdfState.entries.filter(e => e.school === DB.home);
  $('#pdf-list').innerHTML = home.map(e => {
    const k = entryKey(e);
    const near = pdfState.entries.filter(x => x.gender === e.gender && x !== e && Math.abs(x.num - e.num) <= 4 && Math.sign(x.num - e.num) !== 0)
      .sort((a, b) => Math.abs(a.num - e.num) - Math.abs(b.num - e.num));
    const lines = pdfState.pages[e.page].slice(Math.max(0, e.line - 3), e.line + 4).join('\n');
    return '<div class="card pdf-entry' + (pdfState.done.has(k) ? ' done' : '') + '">' +
      '<b>' + esc(e.gender) + ' ' + e.num + '　' + esc(e.names.join('・')) + '</b>' + (pdfState.done.has(k) ? ' <span class="tag">入力済み</span>' : '') +
      '<pre>' + esc(lines) + '</pre>' +
      '<div class="label">相手（近くのペア。タップで選ぶ）</div><div class="chips small">' +
      near.map(x => chip('pdfOpp', k + '|' + entryKey(x), x.num + ' ' + x.names.join('・') + '（' + x.school + '）', { on: pdfState.picked[k] === entryKey(x) })).join('') + '</div>' +
      '<button class="btn primary wide" data-act="pdfEnter" data-v="' + esc(k) + '">この試合を入力</button></div>';
  }).join('');
}

function findPlayer(name, school, gender) {
  if (!name || /^open$/i.test(name)) return '';
  const list = DB.players.filter(p => p.school === school && p.gender === gender);
  const exact = list.filter(p => p.name === name || p.name.replace(/\s/g, '') === name);
  if (exact.length === 1) return exact[0].id;
  const loose = list.filter(p => p.name.replace(/[①②③\s]/g, '').startsWith(name));
  return loose.length === 1 ? loose[0].id : '';
}

async function ensurePlayer(name, school, gender) {
  if (!name || /^open$/i.test(name)) return UNKNOWN;
  const id = findPlayer(name, school, gender);
  if (id) return id;
  if (DB.players.some(p => p.school === school && p.gender === gender && p.name.replace(/[①②③\s]/g, '').startsWith(name))) return '';
  const r = await callApi('addPlayer', { data: { name, gender, grade: '', school } });
  if (!DB.byId.has(r.player.id)) DB.players.push(r.player);
  reindex();
  return r.player.id;
}

async function onPdfAction(act, v, btn) {
  if (act === 'pdfOpp') {
    const [k, ok] = v.split('|');
    pdfState.picked[k] = pdfState.picked[k] === ok ? '' : ok;
    renderPdf();
    return;
  }
  if (act !== 'pdfEnter') return;
  const e = pdfState.entries.find(x => entryKey(x) === v);
  if (!e) return;
  btn.disabled = true;
  try {
    const g = e.gender || F.gender;
    F.gender = g;
    F.event = e.names.length === 2 ? 'ダブルス' : 'シングルス';
    F.date = $('#pdf-date').value || today();
    F.tournament = $('#pdf-tournament').value.trim();
    const mine = [];
    for (const n of e.names) mine.push(await ensurePlayer(n, DB.home, g));
    const real = mine.filter(id => id && id !== UNKNOWN);
    F.me = real[0] || '';
    F.partner = real[1] || '';
    F.edit = {};
    F.opp = ['', ''];
    F.school = '';
    const o = pdfState.entries.find(x => entryKey(x) === pdfState.picked[v]);
    if (o) {
      F.school = o.school;
      const ids = [];
      for (const n of o.names) ids.push(await ensurePlayer(n, o.school, g));
      F.opp = ids.map(id => id || '').concat(['', '']).slice(0, 2);
      F.edit.opp = !oppComplete();
    }
    F.myG = F.opG = null; F.fMy = F.fOp = ''; F.result = ''; F.end = ''; F.format = 7;
    F.fromPdf = { key: v, label: e.num + ' ' + e.names.join('・') };
    showTab('entry');
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ═════════ 設定 ═════════

function openSettings() {
  const meM = DB.byId.get(store.get('me_男子', '')), meW = DB.byId.get(store.get('me_女子', ''));
  openSheet('<h2>設定</h2><div class="card">' +
    '<p>この端末で覚えている名前：' + esc([meM && meM.name + '（男子）', meW && meW.name + '（女子）'].filter(Boolean).join('、') || 'なし') + '</p>' +
    '<button class="btn wide" data-act="forgetMe">覚えている名前を消す</button>' +
    '<button class="btn wide" data-act="reload">最新の情報を読み込む</button>' +
    '<button class="btn wide" data-act="logout">合言葉を入れ直す</button>' +
    '<p class="muted">送信待ち：' + pending().length + ' 件　／　版：' + APP_VERSION + '</p>' +
    '<p class="muted">スマホのホーム画面に追加すると、アプリのように開けます（iPhone：共有ボタン →「ホーム画面に追加」、Android：︙ →「ホーム画面に追加」）。</p></div>');
}

function onSettingsAction(act) {
  switch (act) {
    case 'openSettings': openSettings(); return true;
    case 'forgetMe': store.del('me_男子'); store.del('me_女子'); F.me = ''; F.partner = ''; closeSheet(); renderTab(); toast('消しました'); return true;
    case 'reload': closeSheet(); toast('読み込んでいます…'); refresh(); return true;
    case 'logout': store.del('key'); closeSheet(); showLogin(); return true;
    case 'closeSheet': closeSheet(); return true;
    case 'flush': flushPending(); return true;
    case 'print': window.print(); return true;
    default: return false;
  }
}

// ═════════ はじまり ═════════

async function login() {
  const k = $('#login-key').value.trim();
  if (!k) return;
  store.set('key', k);
  $('#login-msg').textContent = '確かめています…';
  try {
    await callApi('check');
    $('#login-key').value = '';
    showTab('entry');
    toast('ようこそ');
    refresh();
  } catch (e) {
    if (e.server) store.del('key');
    showLogin(e.message);
  }
}

function init() {
  if (typeof APP_TITLE !== 'undefined') { $('#app-title').textContent = APP_TITLE; document.title = APP_TITLE; }
  const cache = store.get('cache');
  if (cache) setData(cache);
  F.date = today();
  loadMe();

  document.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { if (store.get('key')) showTab(tab.dataset.tab); return; }
    if (e.target.id === 'sheet') { closeSheet(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, v = b.dataset.v;
    if (act === 'login') { login(); return; }
    if (onSettingsAction(act)) return;
    if (['openPlayer', 'openPair', 'sMode', 'sGender', 'sSchool', 'sPeriod', 'sSort'].includes(act)) { onStatsAction(act, v); return; }
    if (act === 'dDate') { dailyDate = v; renderDaily(); return; }
    if (act.startsWith('pl') || ['addPlayer', 'adminLogin', 'adminLogout', 'importR8', 'importText', 'promote', 'editPlayer', 'savePlayer', 'deletePlayer'].includes(act)) { onPlayersAction(act, v); return; }
    if (act.startsWith('pdf')) { onPdfAction(act, v, b); return; }
    onEntryAction(act, v, b);
  });

  $('#login-key').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('#e-date').addEventListener('change', e => { F.date = e.target.value; renderSummary(); });
  $('#e-tournament').addEventListener('input', e => { F.tournament = e.target.value; saveDay(); });
  $('#e-tournament').addEventListener('change', () => { $('#e-tournaments').innerHTML = recentTournaments().slice(0, 6).map(t => chip('tournament', t, t, { on: t === F.tournament })).join(''); });
  document.addEventListener('input', e => {
    if (e.target.id === 'e-school-q') { F.schoolQ = e.target.value; renderSchoolResults(); }
    if (e.target.id === 'f-my') { F.fMy = e.target.value; renderSummary(); }
    if (e.target.id === 'f-op') { F.fOp = e.target.value; renderSummary(); }
    if (e.target.id === 's-q') { S.q = e.target.value; renderStats(); }
  });
  $('#s-from').addEventListener('change', e => { S.from = e.target.value; renderStats(); });
  $('#s-to').addEventListener('change', e => { S.to = e.target.value; renderStats(); });
  $('#s-tournament').addEventListener('change', e => { S.tournament = e.target.value; renderStats(); });
  $('#s-abort').addEventListener('change', e => { S.abort = e.target.checked; renderStats(); });
  $('#d-date').addEventListener('change', e => { dailyDate = e.target.value; renderDaily(); });
  $('#pl-filter-school').addEventListener('change', e => { P.filterSchool = e.target.value; renderPlayers(); });
  $('#pl-show-retired').addEventListener('change', e => { P.retired = e.target.checked; renderPlayers(); });
  $('#pdf-file').addEventListener('change', e => { if (e.target.files[0]) readPdf(e.target.files[0]); });
  window.addEventListener('online', flushPending);
  window.addEventListener('popstate', () => closeSheet(true));
  // アプリに戻ってきたとき：送信待ちを送り、しばらくたっていれば最新の情報を読み込む
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !store.get('key')) return;
    if (Date.now() - lastLoad > 120000) refresh(); else flushPending();
  });

  renderSync();
  if (!store.get('key')) { showLogin(); return; }
  showTab('entry');
  refresh();
}

init();
