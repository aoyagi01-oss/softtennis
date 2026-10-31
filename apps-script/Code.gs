// ソフトテニス部 戦績管理：スプレッドシートとアプリ（index.html）をつなぐプログラム
// 使い方は README.md の「最初に1回だけ：スプレッドシートとつなぐ」を見てください。

// ▼ 部員がアプリに入るときの合言葉。必ず自分たちだけの言葉に変えてください。
const PASSWORD = 'ここを部の合言葉に変える';
// ▼ 先生用の合言葉（名簿の一括取込・選手の修正や削除・学年の繰り上げに使います）。部の合言葉とは別にしてください。
const ADMIN_PASSWORD = 'ここを先生用の合言葉に変える';
// ▼ 自校の名前（名簿の「学校」列と同じ書き方にします）
const HOME_SCHOOL = '金沢錦丘';

const PLAYER_SHEET = {
  name: '選手',
  headers: ['ID', '氏名', '性別', '学年', '学校', '状態', '登録日時'],
  keys: ['id', 'name', 'gender', 'grade', 'school', 'status', 'createdAt']
};
const MATCH_SHEET = {
  name: '試合',
  headers: ['ID', '試合日', '大会名', '種目', '性別', '形式（ゲーム）', '自分1', '自分2', '相手校', '相手1', '相手2',
    '自分ゲーム', '相手ゲーム', 'ファイナル自分', 'ファイナル相手', '終わり方', '勝敗',
    '自分1ID', '自分2ID', '相手1ID', '相手2ID', '入力者', '端末', '登録日時'],
  keys: ['id', 'date', 'tournament', 'event', 'gender', 'format', 'my1', 'my2', 'oppSchool', 'opp1', 'opp2',
    'myGames', 'oppGames', 'finalMy', 'finalOpp', 'end', 'result',
    'my1Id', 'my2Id', 'opp1Id', 'opp2Id', 'enteredBy', 'device', 'createdAt']
};

function doGet(e) {
  const p = e.parameter || {};
  let out;
  try {
    const isAdmin = p.admin ? checkAdmin_(p.admin) : false;
    if (p.action !== 'checkAdmin') checkPassword_(p.key);
    const data = p.data ? JSON.parse(decode_(p.data)) : null;
    switch (p.action) {
      case 'check': out = { homeSchool: HOME_SCHOOL }; break;
      case 'checkAdmin': checkAdmin_(p.admin, true); out = {}; break;
      case 'data': out = { homeSchool: HOME_SCHOOL, players: readAll_(PLAYER_SHEET), matches: readAll_(MATCH_SHEET), today: today_() }; break;
      case 'addMatch': out = { match: withLock_(function () { return addMatch_(data); }) }; break;
      case 'deleteMatch': out = withLock_(function () { return deleteMatch_(p.id, p.device, isAdmin); }); break;
      case 'addPlayer': out = { player: withLock_(function () { return addPlayer_(data); }) }; break;
      case 'updatePlayer': needAdmin_(isAdmin); out = { player: withLock_(function () { return updatePlayer_(data); }) }; break;
      case 'deletePlayer': needAdmin_(isAdmin); out = withLock_(function () { return deletePlayer_(p.id); }); break;
      case 'importPlayers': needAdmin_(isAdmin); out = withLock_(function () { return importPlayers_(data); }); break;
      case 'promote': needAdmin_(isAdmin); out = withLock_(promote_); break;
      default: throw new Error('不明な操作です');
    }
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  const json = JSON.stringify(out);
  // ページからは <script> タグ（JSONP）で呼び出す（学校アカウントにログインしたままでも動くように）
  if (p.callback && /^[\w$.]+$/.test(p.callback)) {
    return ContentService.createTextOutput(p.callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// 最初に1回、Apps Script の画面でこの関数を実行すると、シートと見出しを作ります（実行しなくても、最初の利用時に作られます）
function setup() {
  sheet_(PLAYER_SHEET);
  sheet_(MATCH_SHEET);
}

function norm_(v) {
  return String(v == null ? '' : v).normalize('NFKC').trim();
}

function checkPassword_(key) {
  if (PASSWORD === 'ここを部の合言葉に変える') throw new Error('Apps Script の PASSWORD（部の合言葉）がまだ設定されていません');
  if (norm_(key) !== norm_(PASSWORD)) throw new Error('合言葉がちがいます');
}

function checkAdmin_(key, strict) {
  const ok = ADMIN_PASSWORD !== 'ここを先生用の合言葉に変える' && norm_(key) === norm_(ADMIN_PASSWORD);
  if (strict && !ok) throw new Error('先生用の合言葉がちがいます');
  return ok;
}

function needAdmin_(isAdmin) {
  if (!isAdmin) throw new Error('先生用の合言葉が必要です');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function decode_(data) {
  let s = String(data || '');
  while (s.length % 4) s += '=';
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8');
}

function sheet_(def) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(def.name);
  if (!sh) sh = ss.insertSheet(def.name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(def.headers);
    sh.setFrozenRows(1);
    // 日付・学年などが勝手に数値や日付に変わらないよう、文字列として扱う
    sh.getRange(1, 1, sh.getMaxRows(), def.headers.length).setNumberFormat('@');
  }
  return sh;
}

function tz_() {
  return 'Asia/Tokyo';
}

function today_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function now_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v);
}

// "2026/10/1" や日付セルを "2026-10-01" にそろえる
function normDate_(v) {
  if (isDate_(v)) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const m = String(v || '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

// 見出しの名前で列を探すので、先生がスプレッドシートの列を並べ替えても動く
function columns_(sh, def) {
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(norm_);
  const cols = {};
  def.keys.forEach(function (k, i) {
    const c = head.indexOf(def.headers[i]);
    if (c >= 0) cols[k] = c;
  });
  return cols;
}

function readAll_(def) {
  const sh = sheet_(def);
  const cols = columns_(sh, def);
  const values = sh.getDataRange().getValues();
  values.shift();
  return values.map(function (r) {
    const o = {};
    def.keys.forEach(function (k) {
      const v = cols[k] === undefined ? '' : r[cols[k]];
      o[k] = k === 'date' ? normDate_(v) : isDate_(v) ? Utilities.formatDate(v, tz_(), 'yyyy-MM-dd HH:mm:ss') : norm_(v);
    });
    return o;
  }).filter(function (o) { return o.id; });
}

// スプレッドシートの式として読まれないように
function cell_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function append_(def, rows) {
  if (!rows.length) return;
  const sh = sheet_(def);
  const cols = columns_(sh, def);
  const width = sh.getLastColumn();
  const out = rows.map(function (o) {
    const r = new Array(width).fill('');
    Object.keys(cols).forEach(function (k) { r[cols[k]] = cell_(o[k]); });
    return r;
  });
  const start = sh.getLastRow() + 1;
  const range = sh.getRange(start, 1, out.length, width);
  range.setNumberFormat('@');
  range.setValues(out);
}

function findRow_(def, id) {
  const sh = sheet_(def);
  const cols = columns_(sh, def);
  const ids = sh.getRange(1, cols.id + 1, sh.getLastRow(), 1).getValues();
  for (let i = 1; i < ids.length; i++) {
    if (norm_(ids[i][0]) === id) return { sh: sh, cols: cols, row: i + 1 };
  }
  return null;
}

function newId_(prefix) {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

function clean_(s, max) {
  return norm_(s).replace(/\s+/g, ' ').slice(0, max || 60);
}

function cleanGender_(g) {
  g = norm_(g);
  if (/^(男|男子|M)$/i.test(g)) return '男子';
  if (/^(女|女子|F|W)$/i.test(g)) return '女子';
  throw new Error('性別は「男子」か「女子」にしてください');
}

function cleanGrade_(g) {
  const m = norm_(g).match(/[1-6]/);
  return m ? m[0] : '';
}

function playerKey_(p) {
  return [clean_(p.school), clean_(p.name).replace(/\s/g, ''), p.gender].join('|');
}

// ── 試合 ──

function addMatch_(m) {
  if (!m) throw new Error('試合の内容がありません');
  const id = clean_(m.id, 40) || newId_('M');
  // 電波が悪いときの再送で、同じ試合が2回入らないようにする
  const existing = readAll_(MATCH_SHEET).filter(function (x) { return x.id === id; })[0];
  if (existing) return existing;
  const date = normDate_(m.date);
  if (!date) throw new Error('試合日を選んでください');
  const event = m.event === 'シングルス' ? 'シングルス' : 'ダブルス';
  if (!clean_(m.my1)) throw new Error('自分の名前を選んでください');
  if (event === 'ダブルス' && !clean_(m.my2)) throw new Error('ペアの名前を選んでください');
  if (!clean_(m.oppSchool)) throw new Error('相手の学校を選んでください');
  const format = Math.max(1, Math.min(15, parseInt(m.format, 10) || 7));
  const myGames = parseInt(m.myGames, 10), oppGames = parseInt(m.oppGames, 10);
  if (isNaN(myGames) || isNaN(oppGames)) throw new Error('スコアを選んでください');
  const result = ['勝', '負', '-'].indexOf(m.result) >= 0 ? m.result : (myGames > oppGames ? '勝' : myGames < oppGames ? '負' : '-');
  const row = {
    id: id, date: date, tournament: clean_(m.tournament, 80), event: event, gender: cleanGender_(m.gender), format: String(format),
    my1: clean_(m.my1), my2: event === 'ダブルス' ? clean_(m.my2) : '',
    oppSchool: clean_(m.oppSchool), opp1: clean_(m.opp1), opp2: event === 'ダブルス' ? clean_(m.opp2) : '',
    myGames: String(myGames), oppGames: String(oppGames),
    finalMy: m.finalMy === '' || m.finalMy == null ? '' : String(parseInt(m.finalMy, 10) || 0),
    finalOpp: m.finalOpp === '' || m.finalOpp == null ? '' : String(parseInt(m.finalOpp, 10) || 0),
    end: m.end === '打ち切り' ? '打ち切り' : '', result: result,
    my1Id: clean_(m.my1Id, 40), my2Id: clean_(m.my2Id, 40), opp1Id: clean_(m.opp1Id, 40), opp2Id: clean_(m.opp2Id, 40),
    enteredBy: clean_(m.enteredBy), device: clean_(m.device, 40), createdAt: now_()
  };
  append_(MATCH_SHEET, [row]);
  return row;
}

function deleteMatch_(id, device, isAdmin) {
  const f = findRow_(MATCH_SHEET, norm_(id));
  if (!f) return { deleted: false };
  const rowDevice = norm_(f.sh.getRange(f.row, f.cols.device + 1).getValue());
  if (!isAdmin && (!device || rowDevice !== norm_(device))) throw new Error('この試合は入力した端末か先生しか消せません');
  f.sh.deleteRow(f.row);
  return { deleted: true };
}

// ── 選手 ──

function addPlayer_(p) {
  if (!p || !clean_(p.name)) throw new Error('氏名を入れてください');
  if (!clean_(p.school)) throw new Error('学校を選んでください');
  const row = { id: newId_('P'), name: clean_(p.name), gender: cleanGender_(p.gender), grade: cleanGrade_(p.grade), school: clean_(p.school), status: '', createdAt: now_() };
  const key = playerKey_(row);
  const same = readAll_(PLAYER_SHEET).filter(function (x) { return playerKey_(x) === key; })[0];
  if (same) return same;
  append_(PLAYER_SHEET, [row]);
  return row;
}

function updatePlayer_(p) {
  const f = findRow_(PLAYER_SHEET, norm_(p && p.id));
  if (!f) throw new Error('その選手が見つかりません');
  const set = function (k, v) { if (f.cols[k] !== undefined) f.sh.getRange(f.row, f.cols[k] + 1).setNumberFormat('@').setValue(cell_(v)); };
  if (p.name !== undefined) set('name', clean_(p.name));
  if (p.gender !== undefined) set('gender', cleanGender_(p.gender));
  if (p.grade !== undefined) set('grade', cleanGrade_(p.grade));
  if (p.school !== undefined) set('school', clean_(p.school));
  if (p.status !== undefined) set('status', p.status === '引退' ? '引退' : '');
  return readAll_(PLAYER_SHEET).filter(function (x) { return x.id === p.id; })[0];
}

function deletePlayer_(id) {
  id = norm_(id);
  const used = readAll_(MATCH_SHEET).some(function (m) { return [m.my1Id, m.my2Id, m.opp1Id, m.opp2Id].indexOf(id) >= 0; });
  if (used) throw new Error('試合の記録がある選手は消せません（「引退」にすると一覧に出なくなります）');
  const f = findRow_(PLAYER_SHEET, id);
  if (f) f.sh.deleteRow(f.row);
  return { deleted: !!f };
}

// rows: [{name, gender, grade, school}, …]。同じ学校・氏名・性別の選手がいれば、学年だけ新しくする
function importPlayers_(rows) {
  if (!Array.isArray(rows)) throw new Error('名簿の形がちがいます');
  const all = readAll_(PLAYER_SHEET);
  const byKey = {};
  all.forEach(function (x) { byKey[playerKey_(x)] = x; });
  const add = [], errors = [];
  let updated = 0;
  rows.forEach(function (r, i) {
    try {
      const row = { id: newId_('P') + i, name: clean_(r.name), gender: cleanGender_(r.gender), grade: cleanGrade_(r.grade), school: clean_(r.school), status: '', createdAt: now_() };
      if (!row.name || !row.school) throw new Error('氏名か学校が空です');
      const key = playerKey_(row);
      const same = byKey[key];
      if (same) {
        if (row.grade && row.grade !== same.grade) { updatePlayer_({ id: same.id, grade: row.grade }); updated++; }
        return;
      }
      byKey[key] = row;
      add.push(row);
    } catch (err) {
      errors.push((r.name || '?') + '：' + err.message);
    }
  });
  append_(PLAYER_SHEET, add);
  return { added: add.length, updated: updated, errors: errors };
}

// 新年度に1回：自校の在籍選手の学年を1つ上げる（3年生は「引退」にする）
function promote_() {
  const sh = sheet_(PLAYER_SHEET);
  const cols = columns_(sh, PLAYER_SHEET);
  const values = sh.getDataRange().getValues();
  let up = 0, retired = 0;
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (norm_(r[cols.school]) !== HOME_SCHOOL || norm_(r[cols.status]) === '引退') continue;
    const g = parseInt(norm_(r[cols.grade]), 10);
    if (!g) continue;
    if (g >= 3) { sh.getRange(i + 1, cols.status + 1).setValue('引退'); retired++; }
    else { sh.getRange(i + 1, cols.grade + 1).setNumberFormat('@').setValue(String(g + 1)); up++; }
  }
  return { up: up, retired: retired };
}
