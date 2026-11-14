'use strict';
/* =====================================================================
 * 設定(外部APIのURLはここ1か所にまとめる。自前サーバーに差し替える場合はここだけ変更)
 * ===================================================================== */
const CONFIG = {
  TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  OVERPASS_URL: 'https://overpass-api.de/api/interpreter',
  VALHALLA_ROUTE_URL: 'https://valhalla1.openstreetmap.de/route',
  POLL_MS: 8000,                 // 共有データの同期間隔
  FETCH_TIMEOUT_MS: 30000,
  CHECK_RADIUS_M: 600,           // 目標地点まわりの検索半径
  ROUTE_BUFFER_M: 30,            // 経路沿いの検索幅
  ROUTE_MAX_POINTS: 150,         // Overpassへ渡す経路座標の最大数
  DEFAULT_CENTER: [35.681, 139.767],
  DEFAULT_ZOOM: 15,
  // 車両寸法に足す余裕(m, t)。バックミラー等を考慮して「要確認(オレンジ)」にする幅
  MARGIN: { width: 0.3, height: 0.2, length: 0, weight: 0, roadWidth: 1.0 },
  // barrier の分類。RED=通れない可能性が高い / ORANGE=要確認(解錠・開放で通れる場合あり)
  BARRIER_RED: ['bollard', 'block', 'jersey_barrier'],
  BARRIER_ORANGE: ['gate', 'lift_gate', 'swing_gate', 'chain', 'height_restrictor', 'bump_gate', 'sliding_gate'],
  // マイマップ(普段の記録: 消火栓・水利・狭い道・危険個所・進入経路)。事案とは別に、いつでも表示される
  MYMAP_INCIDENT: 'マイマップ',  // 保存先の事案名(予約名。事案名には使えない)
  AVOID: {
    hazardRadius: 20,          // 危険個所の既定の半径(m)
    narrowHalfWidth: 10,       // 狭い道を経路検索で避けるとき、道の両側に取る幅(m)
    maxPolygons: 25,           // 経路検索に渡す回避エリアの最大数(GETのURLが長くなりすぎないように)
    corridorM: 1500,           // 出発・目標を結ぶ線からこの距離以内の記録だけを考慮する(m)
    noticeLineM: 25,           // 経路がこの距離以内を通る狭い道を「注意」として表示する(m)
  },
  WATER_NEAR_M: 500,           // 目標地点のまわりで、消火栓・水利を一覧に出す距離(m)
  LS: { conn: 'dm_conn', local: 'dm_local_items', cache: 'dm_cache_v1', outbox: 'dm_outbox_v1', author: 'dm_author', incident: 'dm_incident', vehicles: 'dm_vehicles_v1', lastpos: 'dm_lastpos', voice: 'dm_voice', toolset: 'dm_toolset' },
};

/* =====================================================================
 * 車両プリセット
 * 寸法(幅・高さ・重量・長さ)はあえて未設定(null)にしてある。
 * 実車の諸元を、画面の「車両」ボタンから入力して使うこと(入力値は localStorage に保存される)。
 * 未入力の寸法は通行判定に使わず、画面に「未入力」と表示する。
 * 単位: 幅・高さ・長さ = m、重量 = t(総重量)
 * ===================================================================== */
const VEHICLE_PRESETS = [
  { id: 'ambulance', name: '救急車' },   // 標準
  { id: 'fire',      name: '消防車' },
  { id: 'large',     name: '大型車' },
];
const DIM_KEYS = [
  { k: 'width',  label: '幅',   unit: 'm' },
  { k: 'height', label: '高さ', unit: 'm' },
  { k: 'weight', label: '重量', unit: 't' },
  { k: 'length', label: '長さ', unit: 'm' },
];

const MY = CONFIG.MYMAP_INCIDENT;
const MY_TYPES = ['hydrant', 'water', 'narrow', 'hazard', 'approach'];

/* ===== 小さなユーティリティ ===== */
const $ = (s, r = document) => r.querySelector(s);
// ユーザー入力を innerHTML に入れる前に必ず通す
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
const newId = () => 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const r6 = n => Math.round(n * 1e6) / 1e6;
const fmtTime = iso => { const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleTimeString('ja-JP', { hour12: false }); };
const fmtDist = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';

function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function bearing(a, b) {            // a→b の方位角(0=北, 時計回り)
  const r = Math.PI / 180, dl = (b[1] - a[1]) * r;
  const y = Math.sin(dl) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const DIRS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
const dirName = b => DIRS[Math.round(b / 45) % 8];

/* ===== エラー表示(アプリ全体は止めない) ===== */
const errors = new Map();
function renderErrors() {
  const box = $('#errors');
  box.replaceChildren(...[...errors].map(([src, msg]) =>
    h('div', { class: 'err' }, `【${src}】${msg}`, h('button', { onclick: () => clearError(src), 'aria-label': '閉じる' }, '×'))));
  box.hidden = errors.size === 0;
}
const setError = (src, msg) => { errors.set(src, String(msg)); renderErrors(); };
const clearError = src => { if (errors.delete(src)) renderErrors(); };
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
window.addEventListener('error', e => setError('予期しないエラー', e.message));
window.addEventListener('unhandledrejection', e => setError('予期しないエラー', (e.reason && e.reason.message) || e.reason));

async function fetchJSON(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CONFIG.FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* 非JSON */ }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(json && (json.error || json.message)) || text.slice(0, 160)}`);
    if (!json) throw new Error('応答がJSONではありません: ' + text.slice(0, 120));
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`タイムアウト(${CONFIG.FETCH_TIMEOUT_MS / 1000}秒)`);
    throw e;
  } finally { clearTimeout(t); }
}

/* =====================================================================
 * 保存と同期(筋トレメニューと同じ方式)
 * - 接続コード(API の URL + 秘密キー)で Apps Script につなぎ、スプレッドシートに保存する
 * - 書き込みはまず画面とこの端末に反映し、送信キュー(outbox)に積んでから送る → 圏外でも書ける
 * - 接続しない「ローカル」モードは localStorage だけに保存する(この端末のみ)
 * 行の形: {id, incident, type, data(object), author, updatedAt, deleted}
 * ===================================================================== */
const jget = (k, fb) => { try { const v = lsGet(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
const jset = (k, v) => lsSet(k, JSON.stringify(v));
let conn = jget(CONFIG.LS.conn, null);          // {u, k} | {local:true} | null(未接続)
const isLocal = () => !!(conn && conn.local);
let outbox = jget(CONFIG.LS.outbox, []);        // 送信待ちの行(同じidは最新だけ)
let sync = 'idle', lastSync = '', flushing = false;

const netError = msg => Object.assign(new Error(msg), { network: true });
function api(action, payload) {
  // 本文は text/plain の単純リクエストなのでCORSのプリフライトが起きない
  return fetch(conn.u, { method: 'POST', body: JSON.stringify({ key: conn.k, action, payload: payload || {} }), redirect: 'follow' })
    .then(r => { if (!r.ok) throw netError('HTTP ' + r.status); return r.json().catch(() => { throw netError('応答を読めませんでした(ウェブアプリのアクセス権が「全員」か確認してください)'); }); },
      () => { throw netError(navigator.onLine === false ? 'オフラインです' : 'サーバーに接続できません(URLが違う、またはウェブアプリのアクセス権が「全員」になっていない可能性があります)'); })
    .then(j => { if (!j.ok) { const e = new Error(j.error || 'エラー'); e.auth = !!j.auth; throw e; } return j.data; });
}
function persistRow(row) {
  if (isLocal()) {
    const all = jget(CONFIG.LS.local, []), i = all.findIndex(r => r.id === row.id);
    if (i < 0) all.push(row); else all[i] = row;
    if (!jset(CONFIG.LS.local, all)) throw new Error('localStorage に保存できません(容量不足/プライベートモード)');
  } else {
    outbox = outbox.filter(r => r.id !== row.id).concat([row]);
    if (!jset(CONFIG.LS.outbox, outbox)) throw new Error('localStorage に保存できません(容量不足/プライベートモード)');
  }
}
const cachedRows = () => { const c = jget(CONFIG.LS.cache, {}); return (c[state.incident] || []).concat(c[MY] || []); };
function persistCache() {                        // 圏外で起動しても直前の内容が見えるように
  if (isLocal()) return;
  const c = jget(CONFIG.LS.cache, {}), all = [...items.values()];
  c[state.incident] = all.filter(r => r.incident !== MY); c[MY] = all.filter(r => r.incident === MY); jset(CONFIG.LS.cache, c);
}
/** 送信キューを順に送る。圏外なら止めて次回に再送。入力エラーの1件は捨てて続ける。 */
async function flush() {
  if (isLocal() || flushing || !outbox.length) return;
  flushing = true; setSync('busy');
  try {
    while (outbox.length) {
      const row = outbox[0];
      try {
        await api('saveItem', { item: row });
        outbox = outbox.filter(r => r !== row); jset(CONFIG.LS.outbox, outbox);
      } catch (e) {
        if (e.network || e.auth) throw e;
        toast(e.message, true);                  // 入力内容のエラー: この1件だけ捨てる
        outbox = outbox.filter(r => r !== row); jset(CONFIG.LS.outbox, outbox);
      }
    }
    setSync('idle'); clearError('同期');
  } catch (e) {
    setSync('off');
    setError('同期', e.auth ? '接続コードが無効です。設定から入れ直してください' : `${e.message}(未送信 ${outbox.length}件。つながったら自動で再送します)`);
  } finally { flushing = false; }
}
function setSync(s) { sync = s; updateInfo(); }

/* ===== 状態 ===== */
const state = {
  incident: lsGet(CONFIG.LS.incident) || '共通',
  author: lsGet(CONFIG.LS.author) || '自分',
};
let vehicles = loadVehicles();
const items = new Map();     // id → row
const shown = new Map();     // id → {sig, layer}
let writeEpoch = 0, polling = false, mode = null, pending = [], previewLayer = null;
let nav = null;                 // ナビ(経路案内)の状態。案内中でなければ null
let route = null, routeLayer = null, findings = [], findLayer = null, checkInfo = null, sheetTab = null;

function loadVehicles() {
  let saved = {};
  try { saved = JSON.parse(lsGet(CONFIG.LS.vehicles) || '{}'); } catch (e) { /* 破損時は初期化 */ }
  const v = { selected: saved.selected || 'ambulance', dims: {} };
  if (!VEHICLE_PRESETS.some(p => p.id === v.selected)) v.selected = 'ambulance';
  for (const p of VEHICLE_PRESETS) {
    v.dims[p.id] = {};
    for (const d of DIM_KEYS) {
      const x = saved.dims && saved.dims[p.id] && saved.dims[p.id][d.k];
      v.dims[p.id][d.k] = typeof x === 'number' && x > 0 ? x : null;
    }
  }
  return v;
}
function getVehicle() {
  const p = VEHICLE_PRESETS.find(x => x.id === vehicles.selected);
  return { id: p.id, name: p.name, ...vehicles.dims[p.id] };
}
const missingDims = veh => DIM_KEYS.filter(d => veh[d.k] == null).map(d => d.label);

/* =====================================================================
 * 地図
 * ===================================================================== */
if (typeof L === 'undefined') {
  document.body.append(h('div', { class: 'fatal' }, '地図ライブラリ(Leaflet)を読み込めませんでした。通信状況を確認して再読み込みしてください。'));
  throw new Error('Leaflet not loaded');
}
const lastPos = (() => { try { const p = JSON.parse(lsGet(CONFIG.LS.lastpos) || 'null'); return p && isFinite(p[0]) && isFinite(p[1]) ? p : null; } catch (e) { return null; } })();
const map = L.map('map', { zoomControl: false, center: lastPos || CONFIG.DEFAULT_CENTER, zoom: CONFIG.DEFAULT_ZOOM, tap: false });
L.control.zoom({ position: 'topright' }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
const tiles = L.tileLayer(CONFIG.TILE_URL, { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
let tileErrs = 0;
tiles.on('tileerror', () => { if (++tileErrs === 3) setError('地図タイル', '地図タイルを取得できません(通信状況を確認)'); });
tiles.on('tileload', () => { tileErrs = 0; clearError('地図タイル'); });
map.on('click', e => { if (mode) handleTap([r6(e.latlng.lat), r6(e.latlng.lng)]); });
let meLayer = null;

/* ===== 図形の描画 ===== */
const TYPE_NAME = { arrow: '進入方向', area: '通行不可エリア', line: '線', memo: 'メモ', start: '出発地点', goal: '目標地点',
  hydrant: '消火栓', water: '水利', narrow: '狭い道', hazard: '危険個所', approach: '進入経路' };
const narrowLabel = d => `狭い道${d.width != null ? ` 幅${d.width}m` : ''}${d.avoid ? ' ⛔避ける' : ''}${d.label ? ' / ' + d.label : ''}`;
const arrowText = d => `${dirName(bearing(d.from, d.to))}向き進入` + (d.label ? ` / ${d.label}` : '');

function buildLayer(row) {
  const d = row.data, t = row.type;
  const open = e => { if (!mode) openItemPopup(row, e.latlng); };
  let g;
  if (t === 'arrow') {
    const b = bearing(d.from, d.to);
    const mid = [(d.from[0] + d.to[0]) / 2, (d.from[1] + d.to[1]) / 2];
    g = L.featureGroup([
      L.polyline([d.from, d.to], { weight: 30, opacity: 0.01 }),
      L.polyline([d.from, d.to], { color: '#0a58ca', weight: 6 }),
      L.marker(d.to, { icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="ah" style="transform:rotate(${b.toFixed(0)}deg)">▲</div>` }) }),
      L.marker(mid, { icon: L.divIcon({ className: '', iconSize: null, html: `<div class="albl">${esc(arrowText(d))}</div>` }) }),
    ]);
  } else if (t === 'area') {
    g = L.polygon(d.points, { color: '#d62828', weight: 3, fillColor: '#d62828', fillOpacity: 0.35 });
    g.bindTooltip(esc(d.reason || '通行不可'), { permanent: true, direction: 'center', className: 'lbl' });
  } else if (t === 'line') {
    g = L.featureGroup([L.polyline(d.points, { weight: 30, opacity: 0.01 }), L.polyline(d.points, { color: '#6a1b9a', weight: 5, dashArray: '10 6' })]);
    if (d.label) g.bindTooltip(esc(d.label), { permanent: true, direction: 'center', className: 'lbl' });
  } else if (t === 'memo') {
    g = L.marker(d.pos, { icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 28], html: '<div class="pin">📌</div>' }) });
    g.bindTooltip(esc(d.text), { permanent: true, direction: 'right', offset: [12, -14], className: 'lbl' });
  } else if (t === 'start' || t === 'goal') {
    g = L.marker(d.pos, { zIndexOffset: 500, icon: L.divIcon({ className: '', iconSize: [40, 40], iconAnchor: [20, 20], html: `<div class="sg ${t === 'start' ? 's' : 'g'}">${t === 'start' ? '出' : '目'}</div>` }) });
  } else if (t === 'hydrant' || t === 'water') {
    g = L.marker(d.pos, { icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="my ${t === 'hydrant' ? 'hy' : 'wa'}">${t === 'hydrant' ? '消' : '水'}</div>` }) });
  } else if (t === 'narrow') {
    g = L.featureGroup([L.polyline(d.points, { weight: 30, opacity: 0.01 }), L.polyline(d.points, { color: '#f77f00', weight: 8, opacity: 0.9 }), L.polyline(d.points, { color: '#111', weight: 2, dashArray: '2 8', interactive: false })]);
    g.bindTooltip(esc(narrowLabel(d)), { permanent: true, direction: 'center', className: 'lbl' });
  } else if (t === 'hazard') {
    g = L.featureGroup([L.circle(d.pos, { radius: d.radius || CONFIG.AVOID.hazardRadius, color: '#f2c200', weight: 2, fillColor: '#f2c200', fillOpacity: 0.25, interactive: false }),
      L.marker(d.pos, { icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: '<div class="my hz">⚠</div>' }) })]);
  } else if (t === 'approach') {
    const last = d.points[d.points.length - 1], b = bearing(d.points[d.points.length - 2], last);
    g = L.featureGroup([L.polyline(d.points, { weight: 30, opacity: 0.01 }), L.polyline(d.points, { color: '#00897b', weight: 6 }),
      L.marker(last, { icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="ah" style="color:#00897b;transform:rotate(${b.toFixed(0)}deg)">▲</div>` }) })]);
    g.bindTooltip(esc(d.label || '進入経路'), { permanent: true, direction: 'center', className: 'lbl' });
  } else return null;
  g.on('click', open);
  return g;
}

function openItemPopup(row, ll) {
  const d = row.data;
  let detail = '';
  if (row.type === 'arrow') detail = `${arrowText(d)}(方位 ${Math.round(bearing(d.from, d.to))}°)`;
  else if (row.type === 'area') detail = d.reason || '(理由なし)';
  else if (row.type === 'line') detail = d.label || '';
  else if (row.type === 'memo') detail = d.text;
  else if (row.type === 'hydrant' || row.type === 'water' || row.type === 'approach') detail = d.label || '';
  else if (row.type === 'narrow') detail = narrowLabel(d).replace(/^狭い道 ?/, '') || '(幅・メモなし)';
  else if (row.type === 'hazard') detail = `${d.label || '(名称なし)'} / 半径${d.radius || CONFIG.AVOID.hazardRadius}m / ${d.avoid !== false ? '経路検索で避ける' : '注意表示のみ'}`;
  const el = h('div', { class: 'pp' },
    h('b', {}, TYPE_NAME[row.type]), h('div', {}, detail),
    h('div', { class: 'meta' }, `${row.author || '-'} / ${fmtTime(row.updatedAt)}`),
    MY_TYPES.includes(row.type) ? h('button', { class: 'edit', onclick: () => { map.closePopup(); editItem(row); } }, '✎ 編集') : null,
    h('button', { onclick: () => { map.closePopup(); deleteItem(row); } }, '🗑 削除'));
  L.popup({ minWidth: 200 }).setLatLng(ll).setContent(el).openOn(map);
}

function applyRows(rows) {
  const ids = new Set(rows.map(r => r.id));
  for (const [id, s] of shown) if (!ids.has(id)) { map.removeLayer(s.layer); shown.delete(id); items.delete(id); }
  for (const r of rows) {
    const sig = r.updatedAt + '|' + JSON.stringify(r.data);
    items.set(r.id, r);
    const cur = shown.get(r.id);
    if (cur && cur.sig === sig) continue;
    if (cur) map.removeLayer(cur.layer);
    const layer = buildLayer(r);
    if (layer) { layer.addTo(map); shown.set(r.id, { sig, layer }); }
  }
  updateInfo();
}

/* ===== 書き込み ===== */
function write(row) {
  writeEpoch++;
  try {
    persistRow(row);
    if (row.deleted) items.delete(row.id); else items.set(row.id, row);
    applyRows([...items.values()]);
    persistCache();
    clearError('保存');
    flush();
    return row;
  } catch (e) { setError('保存', '保存に失敗しました: ' + e.message); return null; }
  finally { writeEpoch++; }
}
const commit = (type, data, id) =>
  write({ id: id || newId(), incident: state.incident, type, data, author: state.author, updatedAt: new Date().toISOString(), deleted: false });
const commitMy = (type, data, id) =>
  write({ id: id || newId(), incident: MY, type, data, author: state.author, updatedAt: new Date().toISOString(), deleted: false });
const deleteItem = row => write({ ...row, deleted: true, author: state.author, updatedAt: new Date().toISOString() });
const getItem = type => items.get(type + ':' + state.incident);

/* ===== 描画モード ===== */
const HINTS = {
  arrow: '進入の【始点】→【終点】の順に2回タップ',
  area: '通行不可エリアの頂点を3点以上タップし、【確定】',
  line: '線の点を2点以上タップし、【確定】',
  memo: 'メモを置く場所をタップ',
  start: '出発地点をタップ(または「現在地」ボタン)',
  goal: '目標地点をタップ',
  hydrant: '消火栓の位置をタップ(続けて記録できます。終わったら「中止」)',
  water: '取水できる場所(川・ため池など)をタップ(続けて記録できます)',
  narrow: '狭い道を点でなぞり、2点以上タップして【確定】',
  hazard: '危険個所をタップ',
  approach: '進入経路を点でなぞり、2点以上タップして【確定】',
};
const LINE_MODES = ['area', 'line', 'narrow', 'approach'];
function setMode(m) {
  if (mode === m) m = null;
  clearPreview(); pending = []; mode = m;
  $('#map').parentElement.classList.toggle('drawing', !!m);
  document.querySelectorAll('.tb[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  map.closePopup();
  renderPending();
}
function renderPending() {
  const box = $('#pending');
  box.classList.toggle('on', !!mode);
  box.replaceChildren(h('div', { class: 'hint', id: 'hint' }, mode ? `${HINTS[mode]}${pending.length ? `(${pending.length}点)` : ''}` : ''));
  if (!mode) return;
  if (LINE_MODES.includes(mode)) box.append(h('button', { class: 'ok', id: 'btnOk', onclick: finishShape }, '確定'));
  if (LINE_MODES.includes(mode) || mode === 'arrow') box.append(h('button', { id: 'btnUndo', onclick: () => { pending.pop(); drawPreview(); renderPending(); } }, '戻す'));
  box.append(h('button', { id: 'btnCancel', onclick: () => setMode(null) }, '中止'));
}
function clearPreview() { if (previewLayer) { map.removeLayer(previewLayer); previewLayer = null; } }
function drawPreview() {
  clearPreview();
  if (!pending.length) return;
  const parts = pending.map(p => L.circleMarker(p, { radius: 7, color: '#fff', weight: 2, fillColor: '#ff6d00', fillOpacity: 1, interactive: false }));
  if (pending.length > 1) parts.push(mode === 'area' && pending.length > 2
    ? L.polygon(pending, { color: '#d62828', dashArray: '6 6', interactive: false })
    : L.polyline(pending, { color: '#ff6d00', dashArray: '6 6', interactive: false }));
  previewLayer = L.layerGroup(parts).addTo(map);
}
async function handleTap(ll) {
  if (mode === 'start' || mode === 'goal') {
    const t = mode; setMode(null);
    const ok = await commit(t, { pos: ll }, t + ':' + state.incident);
    if (ok && t === 'goal') { if (!await runRoute()) runCheck('around'); }
    return;
  }
  if (mode === 'memo') {
    setMode(null);
    const text = await askText({ title: 'メモ', chips: ['要注意', '狭隘', '水利', '段差', '駐車車両'], required: true });
    if (text) commit('memo', { pos: ll, text });
    return;
  }
  if (mode === 'hydrant' || mode === 'water' || mode === 'hazard') {
    const m = mode; if (m === 'hazard') setMode(null);          // 消火栓・水利は続けて記録できる
    const r = await askForm(myForm(m, {}));
    if (r) commitMy(m, m === 'hazard' ? { pos: ll, ...r, radius: r.radius || CONFIG.AVOID.hazardRadius } : { pos: ll, ...r });
    return;
  }
  pending.push(ll); drawPreview(); renderPending();
  if (mode === 'arrow' && pending.length === 2) {
    const [from, to] = pending; setMode(null);
    if (haversine(from, to) < 1) { toast('始点と終点が近すぎます'); return; }
    const b = bearing(from, to);
    const label = await askText({ title: `${dirName(b)}向き進入(ラベル 任意)`, chips: ['北側から進入', '南側から進入', '東側から進入', '西側から進入'] });
    if (label !== null) commit('arrow', { from, to, label });
  }
}
async function finishShape() {
  const need = mode === 'area' ? 3 : 2;
  if (pending.length < need) { toast(`あと${need - pending.length}点必要です`); return; }
  const pts = pending.slice(), m = mode; setMode(null);
  if (m === 'area') {
    const reason = await askText({ title: '通行不可の理由', chips: ['冠水', '工事', '倒木', '通行止め', '崩落'] });
    if (reason !== null) commit('area', { points: pts, reason });
  } else if (m === 'narrow' || m === 'approach') {
    const r = await askForm(myForm(m, {}));
    if (r) commitMy(m, { points: pts, ...r });
  } else {
    const label = await askText({ title: '線のラベル(任意)' });
    if (label !== null) commit('line', { points: pts, label });
  }
}

/* ===== モーダル ===== */
function modal(title, body, buttons) {
  return new Promise(resolve => {
    const ov = $('#ov');
    const done = v => { ov.classList.remove('on'); ov.replaceChildren(); resolve(v); };
    ov.replaceChildren(h('div', { class: 'md', role: 'dialog' }, h('h3', {}, title), typeof body === 'function' ? body(done) : body,
      h('div', { class: 'btns' }, buttons.map(b => h('button', { class: b.pri ? 'pri' : '', onclick: () => b.onclick ? b.onclick(done) : done(b.value) }, b.label)))));
    ov.classList.add('on');
  });
}
/** 入力フォーム。fields: [{key, label, type:'text'|'number'|'check', value, chips}]。決定で {key: 値}、キャンセルで null */
function askForm({ title, note, fields }) {
  const els = {};
  const body = h('div', {}, note ? h('div', { class: 'note' }, note) : null, fields.map(f => {
    if (f.type === 'check') {
      els[f.key] = h('input', { type: 'checkbox' }); els[f.key].checked = !!f.value;
      return h('label', { class: 'chk' }, els[f.key], f.label);
    }
    els[f.key] = f.type === 'number' ? h('input', { type: 'number', inputmode: 'decimal', step: '0.1', min: '0' }) : h('input', { type: 'text', maxlength: 80, autocomplete: 'off' });
    els[f.key].value = f.value ?? '';
    return h('div', {}, h('label', {}, f.label), els[f.key],
      f.chips ? h('div', { class: 'chips' }, f.chips.map(c => h('button', { onclick: () => { els[f.key].value = c; } }, c))) : null);
  }));
  return modal(title, body, [
    { label: 'キャンセル', value: null },
    { label: '決定', pri: true, onclick: done => {
      const out = {};
      for (const f of fields) {
        const el = els[f.key];
        if (f.type === 'check') out[f.key] = el.checked;
        else if (f.type === 'number') { const v = el.value === '' ? null : Number(el.value); if (v !== null && !(v > 0)) { toast(`${f.label}は0より大きい数字で入力してください`, true); return; } out[f.key] = v; }
        else out[f.key] = el.value.trim();
      }
      done(out);
    } },
  ]);
}
/** マイマップの種類ごとの入力項目 */
function myForm(type, d) {
  const f = {
    hydrant: { title: '消火栓', fields: [{ key: 'label', label: '名称・種類(任意)', value: d.label || '', chips: ['地上式', '地下式', '防火水槽', '私設消火栓'] }] },
    water: { title: '水利(取水できる場所)', fields: [{ key: 'label', label: '場所・種類(任意)', value: d.label || '', chips: ['河川', '用水路', 'ため池', 'プール', '海'] }] },
    narrow: { title: '狭い道', note: '道幅が分かれば入れてください。車両の幅より狭いときは、経路検索で自動的に避けます。',
      fields: [{ key: 'width', label: '道幅(m)', type: 'number', value: d.width ?? '' },
        { key: 'label', label: 'メモ(任意)', value: d.label || '', chips: ['一方通行', '電柱あり', '路上駐車が多い', 'すれ違い不可'] },
        { key: 'avoid', type: 'check', label: '必ず避ける(経路検索で通らない)', value: !!d.avoid }] },
    hazard: { title: '危険個所', fields: [{ key: 'label', label: 'どんな危険か', value: d.label || '', chips: ['落石', '冠水しやすい', '低い架線', '踏切', '急カーブ', '段差', '工事中', '行き止まり'] },
      { key: 'radius', label: '範囲の半径(m)', type: 'number', value: d.radius ?? CONFIG.AVOID.hazardRadius },
      { key: 'avoid', type: 'check', label: '経路検索で避ける', value: d.avoid !== false }] },
    approach: { title: '進入経路', fields: [{ key: 'label', label: '名前(例: 自宅)', value: d.label || '', chips: ['自宅', '進入経路'] }] },
  };
  return f[type];
}
async function editItem(row) {
  const r = await askForm(myForm(row.type, row.data));
  if (r) write({ ...row, data: { ...row.data, ...r }, author: state.author, updatedAt: new Date().toISOString() });
}
function askText({ title, value = '', chips = [], required = false }) {
  const inp = h('input', { type: 'text', value, maxlength: 80, autocomplete: 'off' });
  const body = h('div', {}, inp, chips.length ? h('div', { class: 'chips' }, chips.map(c => h('button', { onclick: () => { inp.value = c; } }, c))) : null);
  setTimeout(() => inp.focus(), 50);
  return modal(title, body, [
    { label: 'キャンセル', value: null },
    { label: '決定', pri: true, onclick: done => { const v = inp.value.trim(); if (required && !v) { inp.focus(); return; } done(v); } },
  ]);
}

/* ===== 事案・隊名・接続 ===== */
async function recentIncidents() {
  try {
    if (isLocal()) {
      const m = {}; jget(CONFIG.LS.local, []).forEach(r => { if (!r.deleted && r.type && r.incident !== MY) m[r.incident] = Math.max(m[r.incident] || 0, +new Date(r.updatedAt)); });
      return Object.keys(m).sort((a, b) => m[b] - m[a]).slice(0, 8);
    }
    return (await api('getIncidents')).incidents.map(i => i.name).slice(0, 8);
  } catch (e) { return []; }
}
async function openSettings(first) {
  const inc = h('input', { type: 'text', value: state.incident, maxlength: 40 });
  const au = h('input', { type: 'text', value: state.author, maxlength: 40, placeholder: '例: 救急1隊' });
  const chips = h('div', { class: 'chips' });
  recentIncidents().then(list => chips.replaceChildren(...list.filter(n => n !== inc.value).map(n => h('button', { onclick: () => { inc.value = n; } }, n))));
  const act = (label, fn) => h('button', { onclick: fn }, label);
  const result = await modal('事案・隊名', done => h('div', {},
    h('label', {}, '事案名(同じ名前の端末とデータを共有)'), inc, chips, h('label', {}, '隊名'), au,
    h('div', { class: 'note' }, `保存先: ${isLocal() ? 'この端末のlocalStorage(ローカル。他の端末とは共有されません)' : 'スプレッドシート(接続済み)'}`),
    h('div', { class: 'chips' },
      act('この事案のデータを削除', async () => {
        if (!await modal('削除の確認', h('div', {}, `事案「${inc.value.trim()}」の書き込みをすべて削除します。元に戻せません。`), [{ label: 'やめる', value: false }, { label: '削除する', pri: true, value: true }])) { done(false); openSettings(false); return; }
        await deleteIncidentData(inc.value.trim()); done(false);
      }),
      act(isLocal() ? '接続コードで接続する' : '接続コードを入れ直す', () => { done(false); showSetup(); }))),
    (first ? [] : [{ label: '閉じる', value: null }]).concat([{ label: '保存', pri: true, onclick: d => validate(d) }]));
  function validate(d) {
    if (!inc.value.trim() || !au.value.trim()) { toast('事案名と隊名を入力してください'); return; }
    if (inc.value.trim() === MY) { toast(`「${MY}」は普段の記録用の名前なので、事案名には使えません`, true); return; }
    d(true);
  }
  if (!result) return;
  const changed = inc.value.trim() !== state.incident;
  state.incident = inc.value.trim(); state.author = au.value.trim();
  lsSet(CONFIG.LS.incident, state.incident); lsSet(CONFIG.LS.author, state.author);
  if (changed) switchIncident();
  updateInfo();
}
async function deleteIncidentData(name) {
  if (!name) return;
  if (name === MY) { toast('マイマップは一括削除できません(記録を1件ずつ削除してください)', true); return; }
  try {
    if (isLocal()) {
      const now = new Date().toISOString();
      jset(CONFIG.LS.local, jget(CONFIG.LS.local, []).map(r => r.incident === name ? { ...r, deleted: true, updatedAt: now } : r));
    } else {
      outbox = outbox.filter(r => r.incident !== name); jset(CONFIG.LS.outbox, outbox);
      await api('deleteIncident', { incident: name });
    }
    if (name === state.incident) switchIncident(); 
    toast(`事案「${name}」を削除しました`); clearError('削除');
  } catch (e) { setError('削除', '削除できませんでした: ' + e.message); }
}
function switchIncident() {
  for (const s of shown.values()) map.removeLayer(s.layer);
  shown.clear(); items.clear(); clearRoute(); clearFindings(); setMode(null); writeEpoch++;
  if (!isLocal()) applyRows(cachedRows());
  poll();
}

/* ===== 車両 ===== */
async function openVehicle() {
  const work = JSON.parse(JSON.stringify(vehicles));
  const inputs = {}; let sel = work.selected;
  const seg = h('div', { class: 'seg' }), grid = h('div', { class: 'grid2' });
  const readInputs = () => { for (const d of DIM_KEYS) { const v = parseFloat(inputs[d.k].value); work.dims[sel][d.k] = v > 0 ? v : null; } };
  const fill = () => { for (const d of DIM_KEYS) inputs[d.k].value = work.dims[sel][d.k] ?? ''; };
  const drawSeg = () => seg.replaceChildren(...VEHICLE_PRESETS.map(p => h('button', { class: p.id === sel ? 'on' : '', onclick: () => { readInputs(); sel = p.id; drawSeg(); fill(); } }, p.name)));
  for (const d of DIM_KEYS) {
    inputs[d.k] = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', placeholder: '未入力' });
    grid.append(h('div', {}, h('label', {}, `${d.label} (${d.unit})`), inputs[d.k]));
  }
  drawSeg(); fill();
  const body = h('div', {}, seg, grid, h('div', { class: 'note bad' }, '寸法は未設定の状態で配布しています。実車の諸元(車検証・カタログ値)を入力してください。未入力の項目は通行判定に使われません。'));
  const ok = await modal('車両の選択・寸法', body, [{ label: 'キャンセル', value: false }, { label: '保存', pri: true, value: true }]);
  if (!ok) return;
  readInputs(); work.selected = sel; vehicles = work;
  lsSet(CONFIG.LS.vehicles, JSON.stringify(vehicles));
  updateInfo();
  if (checkInfo || getItem('goal')) toast('車両を変更しました。「注意」で再判定してください');
}

function updateInfo() {
  const v = getVehicle(), miss = missingDims(v);
  $('#btnInc').textContent = `⚙ ${state.incident}`;
  $('#btnVeh').textContent = `🚒 ${v.name}${miss.length ? ' ⚠' : ''}`;
  const n = outbox.length;
  const label = isLocal() ? 'ローカル' : sync === 'busy' ? '同期中' : sync === 'off' ? (n ? `未送信 ${n}件` : 'オフライン') : '同期済み';
  const b = $('#sync');
  b.textContent = `${label}\n${items.size}件${lastSync ? ' ' + lastSync : ''}`;
  b.className = sync === 'off' && !isLocal() ? 'off' : sync === 'busy' ? 'busy' : '';
}

/* ===== 同期(ポーリング) ===== */
async function poll() {
  if (polling || !conn) return;
  polling = true;
  const ep = writeEpoch, inc = state.incident;
  try {
    let rows;
    if (isLocal()) rows = jget(CONFIG.LS.local, []).filter(r => (r.incident === inc || r.incident === MY) && !r.deleted);
    else {
      await flush();
      if (outbox.length) return;                 // 未送信があるうちはサーバーの内容で上書きしない
      rows = (await api('getItems', { incident: inc, incidents: [inc, MY] })).items;      // 事案 + マイマップ
    }
    if (ep === writeEpoch && inc === state.incident && !outbox.length) {
      applyRows(rows); persistCache();
      lastSync = new Date().toLocaleTimeString('ja-JP', { hour12: false });
      if (!isLocal()) setSync('idle');
    }
    clearError('同期');
  } catch (e) {
    if (!isLocal()) setSync('off');
    setError('同期', e.auth ? '接続コードが無効です。設定から入れ直してください' : `共有データを取得できません(次回再試行): ${e.message}`);
  } finally { polling = false; updateInfo(); }
}

/* =====================================================================
 * マイマップ(普段の記録)を、経路検索と注意表示に使う
 *  - 「避ける」設定の危険個所、車両の幅では通れない(または「必ず避ける」の)狭い道 → 経路検索で回避エリアにして経路を選び直す
 *  - 避ける経路がなければ、避けずに案内し、その旨を表示する
 *  - 経路沿い(または目標周辺)にある記録を、注意箇所として一覧・地図・案内中の音声で知らせる
 *  - 目標付近の消火栓・水利を一覧に出す
 * ===================================================================== */
const myItems = () => [...items.values()].filter(r => r.incident === MY);
function localXY(ref) {
  const k = Math.cos(ref[0] * Math.PI / 180), M = 111320;
  return { to: p => [(p[1] - ref[1]) * k * M, (p[0] - ref[0]) * M], from: (x, y) => [ref[0] + y / M, ref[1] + x / (k * M)] };
}
/** 点 p と線分 a-b の距離(m)と、線分上の最寄り点 */
function segDist(p, a, b) {
  const L = localXY(p), [ax, ay] = L.to(a), [bx, by] = L.to(b), dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0, cx = ax + t * dx, cy = ay + t * dy;
  return { d: Math.hypot(cx, cy), ll: L.from(cx, cy) };
}
function distToLine(p, pts) {
  let best = { d: Infinity, ll: pts[0] };
  for (let i = 0; i + 1 < pts.length; i++) { const q = segDist(p, pts[i], pts[i + 1]); if (q.d < best.d) best = q; }
  return best;
}
/** Valhalla の exclude_polygons 用([lon,lat] の閉じた環) */
function hazardPoly(pos, r) {
  const L = localXY(pos), ring = [];
  for (let i = 0; i < 8; i++) { const t = i * Math.PI / 4, q = L.from(r * Math.cos(t), r * Math.sin(t)); ring.push([+q[1].toFixed(5), +q[0].toFixed(5)]); }
  ring.push(ring[0]); return ring;
}
function lineBufferPoly(points, half) {
  let pts = points;
  if (pts.length > 12) pts = Array.from({ length: 12 }, (_, i) => points[Math.round(i * (points.length - 1) / 11)]);
  const L = localXY(pts[0]), xy = pts.map(L.to), unit = (u, v) => { const n = Math.hypot(u, v) || 1; return [u / n, v / n]; };
  const left = [], right = [];
  xy.forEach((q, i) => {
    const d1 = i > 0 ? unit(q[0] - xy[i - 1][0], q[1] - xy[i - 1][1]) : null, d2 = i + 1 < xy.length ? unit(xy[i + 1][0] - q[0], xy[i + 1][1] - q[1]) : null;
    const d = d1 && d2 ? unit(d1[0] + d2[0], d1[1] + d2[1]) : (d1 || d2), n = [-d[1], d[0]];
    left.push([q[0] + n[0] * half, q[1] + n[1] * half]); right.push([q[0] - n[0] * half, q[1] - n[1] * half]);
  });
  const ring = left.concat(right.reverse()).map(q => { const w = L.from(q[0], q[1]); return [+w[1].toFixed(5), +w[0].toFixed(5)]; });
  ring.push(ring[0]); return ring;
}
/** 狭い道を「避ける」か: 「必ず避ける」設定、または車両の幅(+余裕)が道幅以上 */
const narrowAvoid = (d, veh) => d.avoid === true || (d.width != null && veh.width != null && veh.width + CONFIG.MARGIN.width >= d.width);
const myBrief = r => r.type === 'hazard' ? `危険個所(${r.data.label || '名称なし'})` : `狭い道${r.data.width != null ? `(幅${r.data.width}m)` : ''}${r.data.label ? ' ' + r.data.label : ''}`;
/** 経路検索に渡す回避エリア。出発〜目標を結ぶ線に近い順に、最大数まで。 */
function buildAvoid(startPos, goalPos, veh) {
  const A = CONFIG.AVOID, lim = Math.max(A.corridorM, haversine(startPos, goalPos) * 0.5), cand = [];
  for (const r of myItems()) {
    const d = r.data; let poly, off;
    if (r.type === 'hazard' && d.avoid !== false) { poly = hazardPoly(d.pos, Math.max(d.radius || A.hazardRadius, 10)); off = segDist(d.pos, startPos, goalPos).d; }
    else if (r.type === 'narrow' && narrowAvoid(d, veh)) { poly = lineBufferPoly(d.points, A.narrowHalfWidth); off = Math.min(...d.points.map(q => segDist(q, startPos, goalPos).d)); }
    else continue;
    if (off <= lim) cand.push({ row: r, poly, off });
  }
  cand.sort((x, y) => x.off - y.off);
  const use = cand.slice(0, A.maxPolygons);
  return { polys: use.map(c => c.poly), items: use.map(c => c.row), capped: cand.length > A.maxPolygons };
}
/** 経路を一定間隔(既定10m)の点に分ける。頂点の間隔が長い直線道路でも、途中にある記録を見逃さないため。 */
function densify(shape, step = 10, maxPts = 3000) {
  let total = 0; for (let i = 1; i < shape.length; i++) total += haversine(shape[i - 1], shape[i]);
  const st = Math.max(step, total / maxPts), out = [shape[0]];
  for (let i = 1; i < shape.length; i++) {
    const p = shape[i - 1], q = shape[i], d = haversine(p, q), n = Math.floor(d / st);
    for (let k = 1; k <= n; k++) { const t = k * st / d; out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    out.push(q);
  }
  return out;
}
/** 経路沿い(kind='route')または目標周辺(kind='around')にあるマイマップの危険個所・狭い道 → 注意箇所 */
function mymapNotices(kind, veh, origin) {
  const out = [], T = CONFIG.AVOID, sv = kind === 'route' && route ? (route.dense || (route.dense = densify(route.shape))) : null;
  for (const r of myItems()) {
    const d = r.data; let hit = null, sev = 'orange', why = '';
    if (r.type === 'hazard') {
      if (sv) { let b = { d: Infinity }; for (const v of sv) { const dd = haversine(v, d.pos); if (dd < b.d) b = { d: dd, ll: v }; } if (b.d <= (d.radius || T.hazardRadius) + 20) hit = b.ll; }
      else if (!sv && kind === 'around' && haversine(origin, d.pos) <= CONFIG.CHECK_RADIUS_M) hit = d.pos;
      if (hit) { sev = sv && d.avoid !== false ? 'red' : 'orange'; why = `【マイマップ】危険個所: ${d.label || '(名称なし)'}${d.avoid !== false ? '(避ける設定)' : ''}`; }
    } else if (r.type === 'narrow') {
      if (sv) { let b = { d: Infinity }; for (const v of sv) { const q = distToLine(v, d.points); if (q.d < b.d) b = { d: q.d, ll: v }; } if (b.d <= T.noticeLineM) hit = b.ll; }
      else if (kind === 'around') { const q = distToLine(origin, d.points); if (q.d <= CONFIG.CHECK_RADIUS_M) hit = q.ll; }
      if (hit) { sev = narrowAvoid(d, veh) ? 'red' : 'orange'; why = `【マイマップ】狭い道${d.width != null ? ` 幅${d.width}m` : '(幅の記録なし)'}${d.label ? ' ' + d.label : ''}${d.width != null && veh.width != null ? `(車両幅${veh.width}m)` : ''}`; }
    }
    if (hit) out.push({ id: `my:${r.id}`, ll: hit, name: '', sev, reasons: [why], dist: haversine(origin, hit) });
  }
  return out;
}
/** 目標付近の消火栓・水利(近い順) */
function waterNear() {
  const g = getItem('goal'); if (!g) return [];
  return myItems().filter(r => r.type === 'hydrant' || r.type === 'water')
    .map(r => ({ r, dist: haversine(g.data.pos, r.data.pos) })).filter(x => x.dist <= CONFIG.WATER_NEAR_M).sort((x, y) => x.dist - y.dist).slice(0, 8);
}

/* ===== 現在地 ===== */
/**
 * 現在地を取得して青い点で表示する。成功すると座標、失敗すると null を返す。
 * silent: 起動時など。失敗しても出発地点モードにはしない。 center: false なら地図は動かさない。
 */
function locate({ silent = false, center = true } = {}) {
  return new Promise(resolve => {
    const fail = why => {
      if (silent) toast(`現在地を取得できません(${why})`);
      else { setError('現在地', `現在地を取得できません(${why})。地図をタップして出発地点を指定してください。`); setMode('start'); }
      resolve(null);
    };
    if (!navigator.geolocation) return fail('この端末では未対応');
    if (!silent) toast('現在地を取得中…');
    navigator.geolocation.getCurrentPosition(pos => {
      clearError('現在地');
      const ll = [r6(pos.coords.latitude), r6(pos.coords.longitude)];
      jset(CONFIG.LS.lastpos, ll);
      if (meLayer) map.removeLayer(meLayer);
      meLayer = L.layerGroup([L.circle(ll, { radius: pos.coords.accuracy, weight: 1, interactive: false }),
        L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#2b7de9', fillOpacity: 1, interactive: false })]).addTo(map);
      if (center) map.setView(ll, Math.max(map.getZoom(), 16));
      resolve(ll);
    }, err => fail(err.code === 1 ? '位置情報の利用が許可されていません' : err.code === 3 ? 'タイムアウト' : '位置を特定できません'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 });
  });
}

/* =====================================================================
 * 通行注意箇所(Overpass)
 * ===================================================================== */
function parseLen(s) {       // → m (OSMは既定m。ft/in表記にも対応)
  s = String(s || '').trim().toLowerCase();
  let m = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*(?:"|'')?)?$/);
  if (m) return (parseFloat(m[1]) * 12 + parseFloat(m[2] || 0)) * 0.0254;
  m = s.match(/^(\d+(?:[.,]\d+)?)\s*(m|ft)?$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return m[2] === 'ft' ? v * 0.3048 : v;
}
function parseWeight(s) {    // → t (OSMは既定t)
  const m = String(s || '').trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(t|kg|lbs|st)?$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return m[2] === 'kg' ? v / 1000 : m[2] === 'lbs' ? v * 0.000453592 : m[2] === 'st' ? v * 0.00635 : v;
}
const SEV_RANK = { red: 2, orange: 1 };
// タグと車両寸法を比較する(純粋関数)。戻り値: {sev:'red'|'orange', reasons:[]} か null
function evalTags(tags, veh) {
  const M = CONFIG.MARGIN, reasons = []; let sev = null;
  const up = (s, why) => { reasons.push(why); if (!sev || SEV_RANK[s] > SEV_RANK[sev]) sev = s; };
  const limit = (key, label, parse, unit, margin) => {
    if (tags[key] == null) return;
    const lim = parse(tags[key]);
    if (lim == null) return;                    // "none" "default" 等は無視
    const vv = veh[key.replace('max', '')];
    const txt = `${label}制限 ${tags[key]}`;
    if (vv == null) up('orange', `${txt}(車両の${label}が未入力のため判定不可)`);
    else if (vv >= lim) up('red', `${txt} < 車両${vv}${unit}`);
    else if (vv + margin >= lim) up('orange', `${txt} ≒ 車両${vv}${unit}(余裕${(lim - vv).toFixed(2)}${unit})`);
  };
  limit('maxwidth', '幅', parseLen, 'm', M.width);
  limit('maxheight', '高さ', parseLen, 'm', M.height);
  limit('maxlength', '長さ', parseLen, 'm', M.length);
  limit('maxweight', '重量', parseWeight, 't', M.weight);
  if (tags.highway && tags.width != null) {
    const w = parseLen(tags.width);
    if (w != null) {
      if (veh.width == null) { if (w < 3) up('orange', `道幅 ${tags.width}(車両幅が未入力のため判定不可)`); }
      else if (w < veh.width) up('red', `道幅 ${tags.width} < 車両幅${veh.width}m`);
      else if (w < veh.width + M.roadWidth) up('orange', `道幅 ${tags.width} は車両幅${veh.width}mに近い`);
    }
  }
  if (tags.barrier) {
    const b = tags.barrier;
    if (CONFIG.BARRIER_RED.includes(b)) up('red', `障害物 barrier=${b}`);
    else if (CONFIG.BARRIER_ORANGE.includes(b)) up('orange', `障害物 barrier=${b}(開放・解錠で通れる場合あり)`);
  }
  if (tags.highway) {
    const emerg = tags.emergency === 'yes' || tags.emergency === 'designated';
    const acc = (k) => {
      const v = tags[k];
      if (v === 'no') up(emerg ? 'orange' : 'red', `${k}=no${emerg ? '(emergency=yes)' : '(緊急車両は通行可の場合あり)'}`);
      else if (v === 'private' && k === 'access') up('orange', 'access=private(私道)');
    };
    acc('access'); if (tags.motor_vehicle === 'no') acc('motor_vehicle');
  }
  return sev ? { sev, reasons } : null;
}
const OVERPASS_FILTERS = [
  '["maxwidth"]', '["maxheight"]', '["maxweight"]', '["maxlength"]', '["highway"]["width"]',
  '["barrier"~"^(bollard|gate|lift_gate|swing_gate|chain|block|jersey_barrier|height_restrictor|bump_gate|sliding_gate)$"]',
  '["highway"]["access"~"^(no|private)$"]', '["highway"]["motor_vehicle"="no"]',
];
const buildQuery = area => `[out:json][timeout:25];(${OVERPASS_FILTERS.map(f => `nwr${area}${f};`).join('')});out center tags 500;`;
function analyze(elements, veh, origin) {
  const out = [];
  for (const el of elements || []) {
    const ll = el.type === 'node' ? [el.lat, el.lon] : el.center ? [el.center.lat, el.center.lon] : null;
    const r = ll && el.tags ? evalTags(el.tags, veh) : null;
    if (r) out.push({ id: `${el.type}/${el.id}`, ll, name: el.tags.name || el.tags.ref || '', ...r, dist: origin ? haversine(origin, ll) : 0 });
  }
  return out.sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev] || a.dist - b.dist);
}
function sampleCoords(shape, n = CONFIG.ROUTE_MAX_POINTS) {
  if (shape.length <= n) return shape;
  const out = []; for (let i = 0; i < n; i++) out.push(shape[Math.round(i * (shape.length - 1) / (n - 1))]);
  return out;
}
async function overpass(query) {
  const j = await fetchJSON(CONFIG.OVERPASS_URL, {      // 本文はform形式 = CORSプリフライトなし
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'data=' + encodeURIComponent(query) });
  if (j.remark) setError('Overpass(警告)', `結果が不完全な可能性: ${j.remark}`);
  else clearError('Overpass(警告)');
  return j;
}
function clearFindings() { if (findLayer) map.removeLayer(findLayer); findLayer = null; findings = []; checkInfo = null; }
async function runCheck(kind, keepTab) {
  const veh = getVehicle();
  let area, origin;
  if (kind === 'route') {
    if (!route) { toast('先に経路検索してください'); return; }
    area = `(around:${CONFIG.ROUTE_BUFFER_M},${sampleCoords(route.shape).map(p => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(',')})`;
    origin = route.shape[0];
  } else {
    const g = getItem('goal');
    if (!g) { toast('先に目標地点を設定してください'); return; }
    origin = g.data.pos; area = `(around:${CONFIG.CHECK_RADIUS_M},${origin[0]},${origin[1]})`;
  }
  toast(kind === 'route' ? '経路沿いの注意箇所を検索中…' : '目標周辺の注意箇所を検索中…', 20000);
  const mine = mymapNotices(kind, veh, origin);          // マイマップ(通信なしで判定できる)
  let osm = [], osmErr = null;
  try { osm = analyze((await overpass(buildQuery(area))).elements, veh, origin); clearError('Overpass'); }
  catch (e) { osmErr = e; setError('Overpass', `注意箇所を取得できません: ${e.message}(マイマップの記録だけを表示しています)`); }
  findings = osm.concat(mine).sort((x, y) => SEV_RANK[y.sev] - SEV_RANK[x.sev] || x.dist - y.dist);
  checkInfo = { kind, veh, missing: missingDims(veh), at: new Date() };
  drawFindings();
  if (nav || keepTab === 'quiet') { /* 案内中・自動の再検索では画面を覆わない */ } else if (keepTab && sheetTab) renderSheet(); else showSheet('check');
  if (!nav) toast(osmErr && !mine.length ? '注意箇所の取得に失敗しました' : `注意箇所 ${findings.length}件(赤${findings.filter(f => f.sev === 'red').length}/橙${findings.filter(f => f.sev === 'orange').length})`);
}
function drawFindings() {
  if (findLayer) map.removeLayer(findLayer);
  findLayer = L.layerGroup(findings.map(f => {
    const m = L.marker(f.ll, { zIndexOffset: f.sev === 'red' ? 800 : 700,
      icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="fd ${f.sev}">${f.sev === 'red' ? '×' : '!'}</div>` }) });
    f.marker = m;
    m.bindPopup(() => h('div', { class: 'pp' }, h('b', {}, f.sev === 'red' ? '通れない可能性が高い' : '要確認'),
      f.name ? h('div', {}, f.name) : null, ...f.reasons.map(r => h('div', {}, '・' + r)), h('div', { class: 'meta' }, 'OSM ' + f.id)));
    return m;
  })).addTo(map);
}

/* =====================================================================
 * 経路検索(Valhalla, GET ?json= でCORSプリフライト回避)
 * ===================================================================== */
function decodePolyline6(str) {
  let i = 0, lat = 0, lon = 0; const out = [];
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (res & 1) ? ~(res >> 1) : (res >> 1);
      if (axis === 0) lat += d; else lon += d;
    }
    out.push([lat / 1e6, lon / 1e6]);
  }
  return out;
}
function buildRouteRequest(startPos, extraPolys = []) {
  const g = getItem('goal'), veh = getVehicle();
  const truck = {}; for (const d of DIM_KEYS) if (veh[d.k] != null) truck[d.k] = veh[d.k];   // m / t
  const req = {
    locations: [{ lat: startPos[0], lon: startPos[1] }, { lat: g.data.pos[0], lon: g.data.pos[1] }],
    costing: 'truck', costing_options: { truck }, directions_options: { language: 'ja-JP', units: 'kilometers' },
  };
  const polys = [...items.values()].filter(r => r.type === 'area' && r.data.points.length >= 3)
    .map(r => { const ring = r.data.points.map(p => [+p[1].toFixed(5), +p[0].toFixed(5)]); ring.push(ring[0]); return ring; });   // [lon,lat]
  const all = polys.concat(extraPolys);                      // 描いた通行不可エリア + マイマップの回避エリア
  if (all.length) req.exclude_polygons = all;
  return req;
}
/**
 * 経路検索。出発は、設定した出発地点があればそこから、なければ現在地から。成功したら true。
 * opts.startPos: 出発位置を指定(ナビ中のルート再検索)。opts.auto: 画面を動かさず静かに実行する。
 */
async function runRoute(opts = {}) {
  if (!getItem('goal')) { toast('目標地点を地図でタップしてください'); setMode('goal'); return false; }
  const st = getItem('start');
  let startPos = opts.startPos || (st ? st.data.pos : null);
  if (!startPos) {
    toast('現在地を取得中…', 12000);
    startPos = await locate({ silent: true, center: false });
    if (!startPos) { toast('現在地を取得できません。出発地点を地図タップで指定してください'); setMode('start'); return false; }
  }
  const veh = getVehicle(), goalPos = getItem('goal').data.pos, av = buildAvoid(startPos, goalPos, veh);
  let polys = av.polys.slice(), avItems = av.items.slice(), avoidFailed = false, avoidCapped = av.capped;
  const urlFor = extra => { const r = buildRouteRequest(startPos, extra); return { req: r, url: `${CONFIG.VALHALLA_ROUTE_URL}?json=${encodeURIComponent(JSON.stringify(r))}` }; };
  if (!opts.auto) toast('経路検索中…', 30000);
  try {
    let q = urlFor(polys);
    while (q.url.length > 7000 && polys.length) { polys.pop(); avItems.pop(); avoidCapped = true; q = urlFor(polys); }     // URLが長すぎるときは回避エリアを減らす
    if (q.url.length > 7000) throw new Error('リクエストURLが長すぎます(通行不可エリアが多すぎる可能性)。エリアを減らしてください');
    let j;
    try { j = await fetchJSON(q.url); }
    catch (e) {                                           // 避ける経路がないときは、避けずに探し直す
      if (!polys.length || !/442|no path/i.test(e.message)) throw e;
      polys = []; avItems = []; avoidFailed = true; q = urlFor([]); j = await fetchJSON(q.url);
    }
    const req = q.req;
    const trip = j.trip, leg = trip && trip.legs && trip.legs[0];
    if (!leg) throw new Error('経路が見つかりませんでした');
    clearRoute(true);
    const shape = decodePolyline6(leg.shape), cum = [0];
    for (let k = 1; k < shape.length; k++) cum.push(cum[k - 1] + haversine(shape[k - 1], shape[k]));
    let acc = 0;
    const steps = leg.maneuvers.map(m => {
      const idx = typeof m.begin_shape_index === 'number' ? Math.min(m.begin_shape_index, shape.length - 1) : null;
      const s = { text: m.instruction, say: m.verbal_pre_transition_instruction || m.instruction, type: m.type, km: m.length, sec: m.time, beginCum: idx != null ? cum[idx] : acc };
      acc += (m.length || 0) * 1000; return s;
    });
    route = { shape, cum, total: cum[cum.length - 1], distKm: trip.summary.length, sec: trip.summary.time, steps,
      excluded: (req.exclude_polygons || []).length - polys.length, avoided: avItems, avoidFailed, avoidCapped, veh: getVehicle(), fromCurrent: !st && !opts.startPos };
    routeLayer = L.polyline(route.shape, { color: '#1b5e20', weight: 7, opacity: 0.85, interactive: false }).addTo(map);
    clearError('Valhalla');
    if (!opts.auto) { map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] }); showSheet('route'); }
    runCheck('route', opts.auto ? 'quiet' : true);    // 経路沿いの注意箇所を更新(ナビ中の再検索では画面を開かない)
    updateNavStartBtn();
    return true;
  } catch (e) { setError('Valhalla', `経路検索に失敗しました: ${e.message}`); toast('経路検索に失敗しました'); return false; }
}
function clearRoute(keepNav) { if (nav && !keepNav) stopNav(); if (routeLayer) map.removeLayer(routeLayer); routeLayer = null; route = null; updateNavStartBtn(); }

/* ===== 下部シート(注意箇所一覧 / 経路案内) ===== */
function showSheet(tab) { sheetTab = tab; renderSheet(); }
function renderSheet() {
  const sh = $('#sheet');
  if (!sheetTab) { sh.hidden = true; updateNavStartBtn(); return; }
  sh.hidden = false;
  const body = h('div', { class: 'body' });
  if (sheetTab === 'check') {
    if (!checkInfo) body.append(h('div', { class: 'note' }, '目標地点を設定するか、下の「注意」ボタンで検索します。'));
    else {
      const ci = checkInfo;
      body.append(h('div', { class: 'note' }, `${ci.kind === 'route' ? `経路沿い${CONFIG.ROUTE_BUFFER_M}m` : `目標周辺${CONFIG.CHECK_RADIUS_M}m`} / 車両: ${ci.veh.name} / ${ci.at.toLocaleTimeString('ja-JP', { hour12: false })}`));
      if (ci.missing.length) body.append(h('div', { class: 'note bad' }, `⚠ 車両の${ci.missing.join('・')}が未入力のため、その項目は判定できません(「車両」で入力)`));
      if (!findings.length) body.append(h('div', { class: 'note' }, 'OSMに登録された該当規制は見つかりませんでした。※未登録の規制・障害物はあり得ます。現場の状況を優先してください。'));
      for (const f of findings) body.append(h('button', { class: 'find', onclick: () => { map.flyTo(f.ll, 18); setTimeout(() => f.marker && f.marker.openPopup(), 700); } },
        h('span', { class: `badge ${f.sev}` }, f.sev === 'red' ? '通行困難' : '要確認'),
        h('span', {}, h('b', {}, f.name || (f.id.startsWith('my:') ? 'マイマップ' : `OSM ${f.id}`)), ...f.reasons.map(r => h('div', {}, r)), h('div', { class: 'note' }, `${fmtDist(f.dist)}`))));
    }
    const near = waterNear();
    if (near.length) {
      body.append(h('div', { class: 'note' }, `目標付近の水利(マイマップ・${CONFIG.WATER_NEAR_M}m以内)`));
      for (const { r, dist } of near) body.append(h('button', { class: 'find', onclick: () => map.flyTo(r.data.pos, 18) },
        h('span', { class: `badge ${r.type === 'hydrant' ? 'hy' : 'wt'}` }, TYPE_NAME[r.type]), h('span', {}, h('b', {}, r.data.label || TYPE_NAME[r.type]), h('div', { class: 'note' }, fmtDist(dist)))));
    }
  } else if (!route) body.append(h('div', { class: 'note' }, '出発・目標地点を設定して「経路」を押してください。'));
  else {
    body.append(h('div', { class: 'sum' }, `${route.distKm.toFixed(1)} km / 約${Math.max(1, Math.round(route.sec / 60))}分`),
      h('div', { class: 'note' }, `出発: ${route.fromCurrent ? '現在地' : '設定した出発地点'} / 車両: ${route.veh.name}${missingDims(route.veh).length ? `(${missingDims(route.veh).join('・')}未入力: 経路計算に未反映)` : ''} / 回避した通行不可エリア: ${route.excluded}件`),
      route.avoided.length ? h('div', { class: 'note' }, `🛡 マイマップの記録をもとに ${route.avoided.length}か所を避けて経路を選びました: ${route.avoided.slice(0, 3).map(myBrief).join('、')}${route.avoided.length > 3 ? ` ほか${route.avoided.length - 3}か所` : ''}`) : null,
      route.avoidFailed ? h('div', { class: 'note bad' }, '⚠ 記録した「避ける」箇所を避ける経路が見つかりませんでした。避けずに案内しています。「注意箇所」を確認してください。') : null,
      route.avoidCapped ? h('div', { class: 'note' }, '(避ける記録が多いため、出発〜目標に近いものから一部だけ考慮しました)') : null,
      h('ol', { class: 'steps' }, route.steps.map(s => h('li', {}, `${s.text}`, s.km ? ` (${fmtDist(s.km * 1000)})` : ''))),
      h('button', { class: 'find', onclick: () => { clearRoute(); renderSheet(); } }, '経路を消す'));
  }
  if (route) body.prepend(h('button', { class: 'find navgo', onclick: startNav }, '▶ 案内を開始'));
  updateNavStartBtn();
  sh.replaceChildren(h('div', { class: 'tabs' },
    h('button', { class: sheetTab === 'check' ? 'on' : '', onclick: () => showSheet('check') }, `注意箇所${findings.length ? `(${findings.length})` : ''}`),
    h('button', { class: sheetTab === 'route' ? 'on' : '', onclick: () => showSheet('route') }, '経路案内'),
    h('button', { class: 'x', onclick: () => { sheetTab = null; renderSheet(); }, 'aria-label': '閉じる' }, '✕')), body);
}

/* ===== 画面下部ツールバー ===== */
const TOOLSETS = {
  event: [['arrow', '➤', '進入'], ['area', '⛔', '通行不可'], ['line', '〰', '線'], ['memo', '📌', 'メモ'], ['start', '🟢', '出発'], ['goal', '🎯', '目標']],
  mymap: [['hydrant', '🧯', '消火栓'], ['water', '💧', '水利'], ['narrow', '↔', '狭い道'], ['hazard', '⚠', '危険個所'], ['approach', '🏠', '進入経路']],
};
let toolset = lsGet(CONFIG.LS.toolset) === 'mymap' ? 'mymap' : 'event';
function renderTools() {
  const row = $('#rowDraw');
  row.replaceChildren(...TOOLSETS[toolset].map(([m, ic, tx]) => h('button', { class: 'tb', 'data-mode': m, onclick: () => setMode(m) }, h('span', { class: 'ic' }, ic), tx)));
  row.style.gridTemplateColumns = `repeat(${TOOLSETS[toolset].length}, 1fr)`;
  $('#toolset').replaceChildren(...[['event', '事案の書き込み'], ['mymap', 'マイマップ(普段の記録)']].map(([k, t]) =>
    h('button', { class: toolset === k ? 'on' : '', 'data-set': k, onclick: () => { toolset = k; lsSet(CONFIG.LS.toolset, k); setMode(null); renderTools(); } }, t)));
}
const ACT_BTNS = [['locate', '📍', '現在地', () => locate()], ['route', '🛣', '経路', runRoute], ['check', '⚠', '注意', () => runCheck(route ? 'route' : 'around')],
  ['veh', '🚒', '車両', openVehicle], ['list', '📋', '一覧', () => showSheet(sheetTab || (route ? 'route' : 'check'))], ['set', '⚙', '設定', () => openSettings(false)]];
renderTools();
$('#rowAct').append(...ACT_BTNS.map(([id, ic, tx, fn]) => h('button', { class: 'tb', id: 'act-' + id, onclick: fn }, h('span', { class: 'ic' }, ic), tx)));
$('#btnInc').onclick = () => openSettings(false);
$('#btnVeh').onclick = openVehicle;

/* =====================================================================
 * 経路案内(ナビ): 現在地に追従し、次の曲がり角・距離・残り時間を表示、音声で案内する。
 * 経路から外れたら自動で再検索。前方の通行注意箇所(赤・橙)も事前に知らせる。
 * 位置は watchPosition で受け取る(画面を開いている間だけ動く。iPhone はロック中は止まる)。
 * ===================================================================== */
let voiceOn = jget(CONFIG.LS.voice, true) !== false;
function speak(text) {
  if (!voiceOn || !text || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; u.rate = 1.0; speechSynthesis.speak(u); } catch (e) { /* 音声が使えなくても画面表示は続ける */ }
}
const distShort = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.max(0, Math.round(m / (m < 100 ? 5 : 10)) * (m < 100 ? 5 : 10)) + ' m';
const distSay = m => m >= 1000 ? `約${(m / 1000).toFixed(1)}キロメートル先` : `約${Math.max(10, Math.round(m / (m < 100 ? 10 : 50)) * (m < 100 ? 10 : 50))}メートル先`;
function glyph(type) {      // Valhalla の曲がり方の種類 → 矢印
  if ([4, 5, 6].includes(type)) return '🏁';
  if ([12, 13].includes(type)) return '↶';
  if ([2, 9, 10, 11, 18, 20, 23].includes(type)) return '↱';
  if ([3, 14, 15, 16, 19, 21, 24].includes(type)) return '↰';
  if ([26, 27].includes(type)) return '⟳';
  return '⬆';
}
/** 経路上で現在位置に最も近い点。{d: 経路までの距離(m), s: 経路に沿った走行距離(m), i: 区間番号} */
function projectOnRoute(pos, fromIdx) {
  const sh = route.shape, cum = route.cum, k = Math.cos(pos[0] * Math.PI / 180), M = 111320;
  let best = { d: Infinity, s: 0, i: 0 };
  const scan = (a, b) => {
    for (let i = a; i <= b; i++) {
      const x1 = (sh[i][1] - pos[1]) * k * M, y1 = (sh[i][0] - pos[0]) * M, x2 = (sh[i + 1][1] - pos[1]) * k * M, y2 = (sh[i + 1][0] - pos[0]) * M;
      const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2)) : 0;
      const d = Math.hypot(x1 + t * dx, y1 + t * dy);
      if (d < best.d) best = { d, s: cum[i] + t * (cum[i + 1] - cum[i]), i };
    }
  };
  if (sh.length < 2) return best;
  scan(Math.max(0, (fromIdx || 0) - 3), Math.min(sh.length - 2, (fromIdx || 0) + 300));    // まず直近の区間
  if (best.d > 60) scan(0, sh.length - 2);                                                    // 外れていたら全体から探す
  return best;
}
function updateNavStartBtn() { $('#navStart').hidden = !route || !!nav || !$('#sheet').hidden; }   // 一覧シートが開いているときは、シートの中のボタンを使う
function startNav() {
  if (!route || nav) return;
  if (!navigator.geolocation) { toast('この端末では位置情報が使えないため案内できません', true); return; }
  nav = { watchId: null, idx: 0, spoken: new Set(), off: 0, lastReroute: 0, rerouting: false, follow: true, cur: null, heading: null, stepNo: -1, alerted: new Set(), marker: null, wake: null };
  document.body.classList.add('navigating');
  setMode(null); sheetTab = null; renderSheet(); map.closePopup(); updateNavStartBtn();
  $('#navTop').hidden = false; $('#navBottom').hidden = false;
  drawNav({ glyph: glyph(route.steps[0] && route.steps[0].type), big: '現在地を取得中…', text: route.steps[0] ? route.steps[0].text : '' });
  drawNavBottom(route.total);
  speak('案内を開始します。' + (route.steps[0] ? route.steps[0].say : ''));      // クリック中に呼ぶ(iPhoneは操作の中でないと音が出ない)
  nav.watchId = navigator.geolocation.watchPosition(onNavFix, onNavErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  acquireWake();
}
function stopNav(msg) {
  if (!nav) return;
  const n = nav; nav = null;
  navigator.geolocation.clearWatch(n.watchId);
  if (n.marker) map.removeLayer(n.marker);
  if (n.wake) { n.wake.release().catch(() => {}); }
  try { speechSynthesis.cancel(); } catch (e) { /* 無視 */ }
  document.body.classList.remove('navigating');
  $('#navTop').hidden = true; $('#navBottom').hidden = true; updateNavStartBtn();
  if (msg) toast(msg);
}
async function acquireWake() {            // 案内中は画面を消さない
  try { if (nav && 'wakeLock' in navigator) nav.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* 非対応・拒否は無視 */ }
}
document.addEventListener('visibilitychange', () => { if (nav && !document.hidden) acquireWake(); });
map.on('dragstart', () => { if (nav) { nav.follow = false; drawNavBottom(); } });
function onNavErr(err) {
  if (!nav) return;
  if (err.code === 1) { stopNav(); setError('現在地', '位置情報が許可されていないため案内を終了しました'); }
  else toast('現在地を更新できません(電波の弱い場所かもしれません)');
}
function drawNav(o) {
  $('#navTop').replaceChildren(
    h('div', { class: 'ng' }, o.glyph || '⬆'),
    h('div', { class: 'nt' }, h('div', { class: 'nd' }, o.big || ''), h('div', { class: 'nx' }, o.text || '')),
    ...(o.warn ? [h('div', { class: 'nw' }, '⚠ ' + o.warn)] : []));
}
function drawNavBottom(remain) {
  if (remain != null && nav) nav.remain = remain;
  const rem = nav && nav.remain != null ? nav.remain : route.total;
  const sec = route.sec * (route.total ? rem / route.total : 0), eta = new Date(Date.now() + sec * 1000);
  $('#navBottom').replaceChildren(
    h('div', { class: 'nsum' }, h('b', {}, distShort(rem)), ` ・ 約${Math.max(1, Math.round(sec / 60))}分 ・ ${eta.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false })}着`),
    h('div', { class: 'nbtns' },
      nav && !nav.follow ? h('button', { onclick: () => { nav.follow = true; if (nav.cur) map.setView(nav.cur, Math.max(map.getZoom(), 17)); drawNavBottom(); } }, '◎ 現在地') : null,
      h('button', { id: 'navVoice', onclick: () => { voiceOn = !voiceOn; jset(CONFIG.LS.voice, voiceOn); if (!voiceOn) try { speechSynthesis.cancel(); } catch (e) { /* 無視 */ } else speak('音声案内をオンにしました'); drawNavBottom(); } }, voiceOn ? '🔊 音声' : '🔇 音声'),
      h('button', { class: 'end', id: 'navEnd', onclick: () => stopNav('案内を終了しました') }, '終了')));
}
async function reroute(cur) {
  nav.rerouting = true; nav.lastReroute = Date.now();
  speak('ルートを外れました。再検索します');
  drawNav({ glyph: '⟳', big: 'ルートを再検索中…', text: '' });
  const ok = await runRoute({ startPos: cur, auto: true });
  if (!nav) return;
  nav.rerouting = false; nav.lastReroute = Date.now();
  const latest = nav.pending; nav.pending = null;           // 再検索中に届いた最新の位置があればそれで判断する
  if (ok) { nav.idx = 0; nav.spoken = new Set(); nav.alerted = new Set(); nav.stepNo = -1; nav.off = 0; onNavFix(latest || { coords: { latitude: cur[0], longitude: cur[1], accuracy: 5, heading: nav.heading } }); }
  else { toast('再検索できませんでした。元の経路で案内を続けます', true); if (latest) onNavFix(latest); }
}
function onNavFix(pos) {
  if (!nav || !route) return;
  const cur = [r6(pos.coords.latitude), r6(pos.coords.longitude)], acc = pos.coords.accuracy || 0;
  let hd = pos.coords.heading;
  if (!(hd >= 0) && nav.cur && haversine(nav.cur, cur) > 5) hd = bearing(nav.cur, cur);
  if (hd >= 0) nav.heading = hd;
  nav.cur = cur;
  jset(CONFIG.LS.lastpos, cur);
  const icon = L.divIcon({ className: '', iconSize: [44, 44], iconAnchor: [22, 22], html: `<div class="navme" style="transform:rotate(${Math.round(nav.heading || 0)}deg)">▲</div>` });
  if (nav.marker) { nav.marker.setLatLng(cur); nav.marker.setIcon(icon); } else nav.marker = L.marker(cur, { icon, zIndexOffset: 2000, interactive: false }).addTo(map);
  if (meLayer) { map.removeLayer(meLayer); meLayer = null; }
  if (nav.follow) map.setView(cur, Math.max(map.getZoom(), 17), { animate: true });
  if (nav.rerouting) { nav.pending = pos; return; }
  if (acc > 150) return;                              // 精度が悪いときは判断しない

  const pr = projectOnRoute(cur, nav.idx); nav.idx = pr.i;
  if (pr.d > 100 || (pr.d > Math.max(40, acc) && ++nav.off >= 3)) {
    if (Date.now() - nav.lastReroute > 15000) { reroute(cur); return; }
  } else if (pr.d <= Math.max(40, acc)) nav.off = 0;
  const rest = route.total - pr.s;
  if (rest < 25 || haversine(cur, route.shape[route.shape.length - 1]) < 25) { stopNav(); speak('目的地に到着しました'); toast('目的地に到着しました'); return; }

  // いま走っている区間 k → 次に行う操作は steps[k+1]
  let k = 0; while (k + 1 < route.steps.length && route.steps[k + 1].beginCum <= pr.s + 0.5) k++;
  const next = route.steps[k + 1] || route.steps[k];
  const toNext = Math.max(0, next.beginCum - pr.s);
  if (nav.stepNo !== k) { nav.stepNo = k; nav.spoken = new Set(); }
  for (const T of [500, 200, 50]) {                   // 手前の距離に入ったら、まだ言っていなければ案内する
    if (toNext <= T && !nav.spoken.has(T)) { for (const U of [500, 200, 50]) if (U >= T) nav.spoken.add(U); speak(`${distSay(toNext)}、${next.say}`); break; }
  }
  // 前方の通行注意箇所を事前に知らせる
  let warn = '';
  for (const f of findings) {
    if (f._r !== route) { const q = projectOnRoute(f.ll, 0); f._r = route; f.s = q.d < 60 ? q.s : null; }
    if (f.s == null) continue;
    const ahead = f.s - pr.s;
    if (ahead > 0 && ahead <= 250) {
      const say = `${f.sev === 'red' ? '通行困難の可能性' : '要確認'}の箇所があります。${f.reasons[0]}`;
      if (!warn) warn = `${distShort(ahead)}先 ${f.reasons[0]}`;
      if (!nav.alerted.has(f.id)) { nav.alerted.add(f.id); setTimeout(() => speak(`前方${distSay(ahead).replace('先', '')}に${say}`), 2500); }
    }
  }
  drawNav({ glyph: glyph(next.type), big: distShort(toNext), text: next.text, warn });
  drawNavBottom(rest);
}

/* ===== 初回(接続)画面 ===== */
function decodeConn(code) {
  code = String(code || '').trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (code.length % 4) code += '=';
  const o = JSON.parse(atob(code));
  if (!o.u || !o.k || !/^https:\/\/script\.google\.com\//.test(o.u)) throw new Error('bad');
  return { u: o.u, k: o.k };
}
function showSetup() {
  const box = $('#setup'), ta = h('textarea', { rows: 3, id: 'connCode', placeholder: 'eyJ1Ijoi…', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const go = h('button', { class: 'big', id: 'btnConnect', onclick: () => connect(go, ta.value) }, '接続');
  const msg = h('div', { id: 'setupMsg', class: 'setup-msg', role: 'alert', hidden: true });
  box.replaceChildren(h('div', { class: 'inner' },
    h('img', { class: 'logo', src: 'icons/icon-192.png', alt: '' }), h('h1', {}, '出動支援マップ'),
    h('div', { class: 'muted' }, '進入方向・通行不可エリア・車両別の通行注意箇所を地図に書き込み、自分の端末間で共有します。'),
    h('div', { class: 'card' }, h('b', {}, 'はじめての接続'),
      h('ol', {}, h('li', {}, 'Apps Script の Web アプリ URL(/exec)をブラウザで開く'), h('li', {}, '案内に出るスプレッドシートを開き、「設定」シートの B2(接続コード)をコピー'), h('li', {}, '下に貼り付けて「接続」')),
      h('label', { class: 'muted' }, '接続コード'), ta, go, msg),
    h('button', { class: 'ghost', id: 'btnLocal', onclick: () => { conn = { local: true }; jset(CONFIG.LS.conn, conn); start(); } }, '接続せずローカルで試す(この端末のみ)'),
    isLocal() || conn ? h('button', { class: 'ghost', onclick: () => { box.hidden = true; } }, '閉じる') : null,
    h('p', { class: 'muted' }, 'ホーム画面に追加してから接続すると、アプリとして全画面で使えます。')));
  box.hidden = false;
}
function setupMsg(text, bad) {
  const m = $('#setupMsg'); if (!m) return;
  m.textContent = text || ''; m.hidden = !text; m.className = 'setup-msg' + (bad ? ' bad' : '');
}
async function connect(btn, code) {
  let c; try { c = decodeConn(code); } catch (e) { const m = '接続コードの形式が正しくありません。「設定」シートの B2 をそのままコピーして貼り付けてください(前後の文字を含めない)。'; setupMsg(m, true); toast(m, true); return; }
  btn.disabled = true; btn.textContent = '接続中…'; setupMsg('接続しています…');
  const prev = conn; conn = c;
  try {
    await api('getItems', { incident: state.incident });          // つながるか・キーが合っているか確認
    jset(CONFIG.LS.conn, c); outbox = []; jset(CONFIG.LS.outbox, []);
    switchIncidentClean(); setupMsg(''); toast('接続しました'); start();
  } catch (e) {
    conn = prev; btn.disabled = false; btn.textContent = '接続';
    const m = e.auth ? '接続コードが違います。API_KEY を作り直した場合は新しいコードを貼ってください。' : `接続できませんでした: ${e.message}`;
    setupMsg(m, true); toast(m, true);
  }
}
function switchIncidentClean() {
  for (const s of shown.values()) map.removeLayer(s.layer);
  shown.clear(); items.clear(); clearRoute(); clearFindings(); setMode(null);
}

/* ===== 起動 ===== */
let timerStarted = false;
async function start() {
  $('#setup').hidden = true;
  if (!isLocal()) applyRows(cachedRows());
  updateInfo();
  if (!timerStarted) {
    timerStarted = true;
    setInterval(poll, CONFIG.POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    window.addEventListener('online', poll);
  }
  poll();
  // 起動時は現在地を表示する(取得できなければ前回の位置、なければ既定の位置のまま)
  const here = await locate({ silent: true });
  if (!here && !lastPos) {
    const pts = [getItem('goal'), getItem('start')].filter(Boolean).map(x => x.data.pos);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.5), { maxZoom: 17 });
  }
}
$('#navStart').onclick = startNav;
$('#sync').onclick = () => { toast('同期します…'); poll(); };
if (location.protocol.startsWith('http') && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
updateInfo();
if (conn) start(); else showSetup();
