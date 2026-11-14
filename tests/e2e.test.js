// ローカルモード(localStorage)と接続モード(実際の code.js を gas-mock で動かして接続)の動作確認: node tests/e2e.test.js
// 外部通信は使えない環境でも動くよう、Leaflet(npm版)・地図タイル・Overpass・Valhalla をモックする。
const { chromium } = require('playwright'), assert = require('assert'), path = require('path'), fs = require('fs');
const LEAFLET = process.env.LEAFLET_DIR || path.join(__dirname, 'node_modules/leaflet/dist');
const SHOT = process.env.SHOT_DIR || __dirname;
const INDEX = 'file://' + path.join(__dirname, '..', 'index.html');
const GAS_DIR = process.env.GAS_DIR || path.join(__dirname, '..', '..', 'gas-projects', 'projects', 'dispatch-map');
const { createGas } = require(path.join(GAS_DIR, 'test', 'gas-mock.js'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function enc6(pts) { let la = 0, lo = 0, s = ''; const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let o = ''; while (v >= 0x20) { o += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return o + String.fromCharCode(v + 63); };
  for (const [a, b] of pts) { const x = Math.round(a * 1e6), y = Math.round(b * 1e6); s += e(x - la) + e(y - lo); la = x; lo = y; } return s; }

const log = []; const ok = m => { log.push('PASS ' + m); console.log('PASS', m); };
const mocks = { overpass: [], valhalla: [], overpassFail: false };
async function setup(ctx) {
  await ctx.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.css', r => r.fulfill({ path: LEAFLET + '/leaflet.css', contentType: 'text/css' }));
  await ctx.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', r => r.fulfill({ path: LEAFLET + '/leaflet.js', contentType: 'application/javascript' }));
  await ctx.route('**/tile.openstreetmap.org/**', r => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await ctx.route('**/overpass-api.de/**', async r => {
    const req = r.request(); mocks.overpass.push({ method: req.method(), ct: req.headers()['content-type'], body: req.postData() });
    if (mocks.overpassFail) return r.fulfill({ status: 504, body: 'Gateway Timeout' });
    const base = [35.681, 139.767];
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [
      { type: 'way', id: 1, center: { lat: base[0] + 0.001, lon: base[1] }, tags: { highway: 'residential', maxwidth: '2.0', name: '狭路A' } },      // 幅 2.0 < 車両2.3 → 赤
      { type: 'way', id: 2, center: { lat: base[0] + 0.002, lon: base[1] - 0.0006 }, tags: { highway: 'residential', maxheight: '3.2' } },                       // 高さ3.2, 車両3.0 → 橙(余裕0.2)
      { type: 'node', id: 3, lat: base[0], lon: base[1] + 0.001, tags: { barrier: 'bollard' } },                                                         // 赤
      { type: 'node', id: 4, lat: base[0], lon: base[1] + 0.002, tags: { barrier: 'gate' } },                                                            // 橙
      { type: 'way', id: 5, center: { lat: base[0] - 0.001, lon: base[1] }, tags: { highway: 'service', access: 'private' } },                           // 橙
      { type: 'way', id: 6, center: { lat: base[0] - 0.002, lon: base[1] }, tags: { highway: 'residential', maxheight: '4.5', maxweight: '10' } },       // 問題なし(null)
      { type: 'way', id: 7, center: { lat: base[0] - 0.003, lon: base[1] }, tags: { highway: 'residential', motor_vehicle: 'no' } },                     // 赤
    ] }) });
  });
  await ctx.route('**/valhalla1.openstreetmap.de/**', r => {
    mocks.valhalla.push(r.request().url());
    const rq0 = JSON.parse(new URL(r.request().url()).searchParams.get('json') || '{}');
    if (mocks.v442 && (rq0.exclude_polygons || []).length) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error_code: 442, error: 'No path could be found for input' }) });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ trip: { summary: { length: 1.23, time: 300 }, legs: [{
      shape: enc6([[35.680, 139.766], [35.683, 139.766], [35.683, 139.769], [35.686, 139.769]]),
      maneuvers: [{ instruction: '北東に進む', type: 1, begin_shape_index: 0, length: 0.33, time: 60 }, { instruction: '右折です', type: 10, begin_shape_index: 1, length: 0.27, time: 60 }, { instruction: '左折です', type: 15, begin_shape_index: 2, length: 0.33, time: 60 }, { instruction: '目的地に到着です', type: 4, begin_shape_index: 3, length: 0, time: 0 }] }] } }) });
  });
}
const tap = (page, fx, fy) => page.evaluate(([fx, fy]) => { const r = document.getElementById('map').getBoundingClientRect(); return [r.left + r.width * fx, Math.min(r.bottom - 10, r.top + 118 + fy * 350)]; }, [fx, fy]).then(([x, y]) => page.mouse.click(x, y));
// 画面下のタブに合わせて切り替えてから押す(機能項目の行はタブごとに変わる)
const TAB_OF = { arrow: 'event', area: 'event', line: 'event', memo: 'event', goal: 'route', start: 'route', 'act-route': 'route', 'act-check': 'route', 'act-list': 'route', hydrant: 'mymap', water: 'mymap', narrow: 'mymap', hazard: 'mymap', approach: 'mymap', closure: 'mymap' };
const tool = async (pg, sel) => {
  const key = (sel.match(/data-mode=(\w+)/) || sel.match(/#(act-\w+)/))[1], need = TAB_OF[key];
  if ((await pg.getAttribute('body', 'data-tab')) !== need) await pg.click(`#tabs button[data-tab=${need}]`);
  await pg.click(sel);
};
const ls = (page, k) => page.evaluate(k => localStorage.getItem(k), k);
const items = async page => JSON.parse(await ls(page, 'dm_local_items') || '[]');
async function answer(page, text) { if (text != null) await page.fill('#ov input', text); await page.click('#ov .btns .pri'); await page.waitForSelector('#ov.on', { state: 'detached' }).catch(() => {}); await page.waitForFunction(() => !document.querySelector('#ov.on')); }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: false, permissions: ['geolocation'], geolocation: { latitude: 35.6812, longitude: 139.7671 } });
  await setup(ctx);
  const page = await ctx.newPage();
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(INDEX);
  await page.waitForSelector('#setup:not([hidden])'); assert.match(await page.textContent('#setup'), /接続コード/); ok('未接続なら接続画面が出る');
  await page.click('#btnLocal'); await page.waitForFunction(() => document.getElementById('setup').hidden);
  assert.ok(!(await page.$('#ov.on')), '初回に設定モーダルは出ない'); ok('初回に事案名・隊名の入力を求めない(既定: 共通 / 自分)');
  await page.waitForFunction(() => Math.abs(map.getCenter().lat - 35.6812) < 0.001 && Math.abs(map.getCenter().lng - 139.7671) < 0.001 && map.getZoom() >= 16);
  ok('起動時に現在地を中心に表示(ズーム16以上)'); assert.ok(await page.$('.leaflet-interactive, path[stroke="#fff"]') !== undefined);
  await page.click('#btnInc'); await page.waitForSelector('#ov.on');

  // 初回: 隊名未設定なら設定モーダルが出る
  await page.fill('#ov input >> nth=0', '事案A'); await page.fill('#ov input >> nth=1', '救急1隊'); await page.click('#ov .btns .pri');
  await page.waitForFunction(() => !document.querySelector('#ov.on'));
  assert.match(await page.textContent('#btnInc'), /事案A/); ok('設定から事案名・隊名を変更できる');
  assert.match(await page.textContent('#warn'), /現場の状況を優先/); ok('「現場の状況を優先すること」表示');
  assert.match(await page.textContent('#btnVeh'), /救急車/); ok('標準車両は救急車');

  // 車両: 3種類のみ・寸法は初期未設定・編集がlocalStorageに保存される
  await page.click('#btnVeh');
  assert.deepEqual(await page.$$eval('#ov .seg button', b => b.map(x => x.textContent)), ['救急車', '消防車', '大型車']); ok('車両プリセットは3種類');
  assert.deepEqual(await page.$$eval('#ov input[type=number]', i => i.map(x => x.value)), ['', '', '', '']); ok('寸法は初期未設定(空欄)');
  const nums = await page.$$('#ov input[type=number]');
  for (const [i, v] of ['2.3', '3.0', '5', '6'].entries()) await nums[i].fill(v);
  await page.click('#ov .seg button:nth-child(3)'); const nums2 = await page.$$('#ov input[type=number]'); await nums2[0].fill('2.5'); await nums2[1].fill('3.5');
  await page.click('#ov .seg button:nth-child(1)');
  assert.equal(await (await page.$$('#ov input[type=number]'))[0].inputValue(), '2.3'); ok('車両切替で入力値が保持される');
  await page.click('#ov .btns .pri');
  const sv = JSON.parse(await ls(page, 'dm_vehicles_v1'));
  assert.deepEqual(sv.dims.ambulance, { width: 2.3, height: 3, weight: 5, length: 6 }); assert.equal(sv.dims.large.width, 2.5); assert.equal(sv.dims.fire.width, null); ok('車両寸法がlocalStorageに保存');

  // 進入方向: 西→東にドラッグでなく2タップ(東向き)
  await tool(page, '[data-mode=arrow]'); await tap(page, 0.3, 0.5); await tap(page, 0.7, 0.5);
  await page.waitForSelector('#ov.on'); assert.match(await page.textContent('#ov h3'), /東向き進入/);
  await answer(page, '西側から進入');
  await page.waitForSelector('.albl'); assert.match(await page.textContent('.albl'), /東向き進入 \/ 西側から進入/); ok('進入方向の矢印と方位・ラベル表示(東向き)');
  // 北東向き
  await tool(page, '[data-mode=arrow]'); await tap(page, 0.3, 0.8); await tap(page, 0.45, 0.65); await page.waitForSelector('#ov.on');
  const t = await page.textContent('#ov h3'); assert.match(t, /向き進入/); await answer(page, ''); ok('北東系の方位名: ' + t);

  // 通行不可エリア
  await tool(page, '[data-mode=area]');
  await tap(page, 0.2, 0.2); await tap(page, 0.4, 0.2);
  await page.click('#btnOk'); assert.match(await page.textContent('#toast'), /あと1点/); ok('頂点不足では確定できない');
  await tap(page, 0.4, 0.35); await page.click('#btnOk'); await page.waitForSelector('#ov.on'); await answer(page, '冠水');
  await page.waitForSelector('path[fill="#d62828"]'); assert.equal(await page.getAttribute('path[fill="#d62828"]', 'fill-opacity'), '0.35'); ok('通行不可ポリゴン(赤半透明)');

  // 線・メモ(XSS)
  await tool(page, '[data-mode=line]'); await tap(page, 0.6, 0.2); await tap(page, 0.8, 0.3); await page.click('#btnOk'); await page.waitForSelector('#ov.on'); await answer(page, '迂回路');
  const xss = '<img src=x onerror="window.__xss=1">&"\'';
  await tool(page, '[data-mode=memo]'); await tap(page, 0.8, 0.6); await page.waitForSelector('#ov.on'); await answer(page, xss);
  await page.waitForSelector('.leaflet-tooltip');
  assert.equal(await page.evaluate(() => window.__xss), undefined); assert.equal(await page.$('.leaflet-tooltip img'), null);
  assert.ok((await page.$$eval('.leaflet-tooltip', e => e.map(x => x.textContent))).some(x => x.includes('<img src=x'))); ok('メモの<img>等はエスケープされ実行されない');

  // 出発・目標(各1つ)
  await tool(page, '[data-mode=start]'); await tap(page, 0.2, 0.8);
  mocks.overpass.length = 0; mocks.valhalla.length = 0;
  await tool(page, '[data-mode=goal]'); await tap(page, 0.5, 0.5);
  await page.waitForFunction(() => document.querySelector('#sheet .sum')); await page.waitForSelector('.fd.red');
  assert.equal(mocks.valhalla.length, 1); ok('目標地点をタップすると自動で経路検索される(設定済みの出発地点から)');
  await tool(page, '[data-mode=start]'); await tap(page, 0.25, 0.85);
  let all = (await items(page)).filter(r => !r.deleted);
  assert.equal(all.filter(r => r.type === 'start').length, 1); assert.equal(all.filter(r => r.type === 'goal').length, 1); ok('出発・目標は事案につき1つ(再設定は置換)');

  // Overpass: 経路沿い(自動) → 経路を消して「注意」ボタンで周囲600m
  assert.ok(decodeURIComponent(mocks.overpass[0].body).includes('around:30,')); ok('経路検索後は経路沿い30mで自動検索');
  await page.click('#sheet .find:has-text("経路を消す")'); mocks.overpass.length = 0; await tool(page, '#act-check'); await page.waitForSelector('.fd.red');
  await page.click('#sheet .tabs button:has-text("注意箇所")');
  const q = decodeURIComponent(mocks.overpass[0].body.replace(/^data=/, ''));
  assert.equal(mocks.overpass[0].method, 'POST'); assert.match(mocks.overpass[0].ct, /x-www-form-urlencoded/);
  for (const w of ['around:600', 'maxwidth', 'maxheight', '"width"', 'barrier', 'access', 'motor_vehicle']) assert.ok(q.includes(w), w);
  ok('「注意」ボタンで周囲600mを検索(必要タグ・プリフライト不要のform POST)');
  const red = await page.$$('.fd.red'), org = await page.$$('.fd.orange');
  assert.equal(red.length, 3); assert.equal(org.length, 3); ok(`判定: 赤${red.length}/橙${org.length}(期待どおり。問題なしの1件は非表示)`);
  assert.ok((await page.textContent('#sheet')).includes('通行困難')); await page.screenshot({ path: SHOT + '/shot-findings.png' });
  await page.click('#sheet .find:has(.badge) >> nth=0'); await page.waitForTimeout(900); assert.ok(await page.$('.leaflet-popup')); ok('一覧タップで該当箇所へ移動しポップアップ');

  // 経路検索
  await tool(page, '#act-route'); await page.waitForTimeout(1500); await page.waitForFunction(() => document.querySelector('#sheet .sum'));
  const url = new URL(mocks.valhalla[0]); assert.ok(url.search.startsWith('?json=')); const req = JSON.parse(url.searchParams.get('json'));
  assert.equal(req.costing, 'truck'); assert.deepEqual(req.costing_options.truck, { width: 2.3, height: 3, weight: 5, length: 6 });
  assert.equal(req.exclude_polygons.length, 1); assert.deepEqual(req.exclude_polygons[0][0], req.exclude_polygons[0].at(-1)); assert.ok(req.exclude_polygons[0][0][0] > 100 && req.exclude_polygons[0][0][1] < 90);
  ok('Valhalla: GET ?json=, truck寸法, exclude_polygons([lon,lat], 閉じた環)');
  assert.match(await page.textContent('#sheet'), /1\.2 km \/ 約5分/); assert.match(await page.textContent('#sheet'), /北東に進む/); ok('距離・時間・案内文の表示');
  for (let i = 0; i < 40 && !mocks.overpass.some(m => decodeURIComponent(m.body).includes('around:30,')); i++) await page.waitForTimeout(100);
  assert.ok(mocks.overpass.some(m => decodeURIComponent(m.body).includes('around:30,'))); assert.ok(await page.$('#sheet .sum')); ok('経路後は経路沿い30mで再検索');
  await page.screenshot({ path: SHOT + '/shot-route.png' });

  // 共有同期: 同じコンテキストの別ページ(別端末の代用)
  const p2 = await ctx.newPage(); await p2.goto(INDEX); await p2.waitForSelector('.albl');
  assert.equal((await p2.$$('.albl')).length, 2); ok('別ページでも同じ事案のデータが表示される(localStorage)');
  await tool(page, '[data-mode=memo]'); await tap(page, 0.1, 0.3); await page.waitForSelector('#ov.on'); await answer(page, '同期テスト');
  await p2.waitForFunction(() => [...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '同期テスト'), null, { timeout: 12000 }); ok('約8秒ポーリングで他ページの追加が反映');

  // タップで削除 → 他ページへ反映
  await page.evaluate(() => map.closePopup());
  const before = (await items(page)).filter(r => !r.deleted).length;
  await page.click('.leaflet-tooltip:has-text("同期テスト")', { force: true }).catch(() => {});
  const memoPos = await page.evaluate(() => { const r = [...items.values()].find(x => x.data.text === '同期テスト'); const p = map.latLngToContainerPoint(r.data.pos); const b = document.getElementById('map').getBoundingClientRect(); return [b.left + p.x, b.top + p.y - 10]; });
  await page.mouse.click(...memoPos); await page.waitForSelector('.pp button'); await page.click('.pp button');
  assert.equal((await items(page)).filter(r => !r.deleted).length, before - 1); ok('タップ→削除ボタンで削除');
  await p2.waitForFunction(() => ![...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '同期テスト'), null, { timeout: 12000 }); ok('削除も他ページへ同期');
  await p2.close();

  // 事案の分離
  await page.click('#btnInc'); await page.fill('#ov input >> nth=0', '事案B'); await page.click('#ov .btns .pri'); await page.waitForTimeout(500);
  assert.equal(await page.$('.albl'), null); assert.equal((await page.$$('.leaflet-marker-icon.leaflet-interactive')).length, 0); ok('事案Bに切替えるとAのデータは表示されない');
  await page.click('#btnInc'); await page.fill('#ov input >> nth=0', '事案A'); await page.click('#ov .btns .pri'); await page.waitForSelector('.albl'); ok('事案Aに戻すとデータが復帰');
  assert.ok((await items(page)).every(r => r.author === '救急1隊')); ok('隊名(author)が記録される');

  // 通信失敗時: エラー表示してアプリは動き続ける
  mocks.overpassFail = true; await tool(page, '#act-check'); await page.waitForSelector('.err');
  assert.match(await page.textContent('#errors'), /Overpass.*HTTP 504/); ok('Overpass失敗時にエラー表示');
  await tool(page, '[data-mode=memo]'); await tap(page, 0.5, 0.3); await page.waitForSelector('#ov.on'); await answer(page, '失敗後も操作可'); 
  assert.ok((await items(page)).some(r => r.data.text === '失敗後も操作可')); ok('通信失敗後もアプリは動作継続');
  await ctx.route('**/valhalla1.openstreetmap.de/**', r => r.abort('failed'));
  await tool(page, '#act-route'); await page.waitForFunction(() => /Valhalla/.test(document.querySelector('#errors').textContent)); ok('Valhalla失敗時にエラー表示');

  // 未入力寸法の警告
  await page.click('#btnVeh'); await page.click('#ov .seg button:nth-child(2)'); await page.click('#ov .btns .pri');
  assert.match(await page.textContent('#btnVeh'), /⚠/); ok('寸法未入力の車両は⚠表示');
  mocks.overpassFail = false; await tool(page, '#act-check'); await page.waitForFunction(() => /未入力のため/.test(document.querySelector('#sheet').textContent)); ok('未入力寸法は判定不可と明示');


  // ================= 接続モード(Apps Script API) =================
  const gas = createGas(); gas.doGet();
  const code = gas.sheet('設定')._dump()[1][1];
  const gasReqs = [];
  const gasRoute = async c => {
    await c.route('https://script.google.com/**', async r => {
      const req = r.request(); gasReqs.push({ method: req.method(), ct: req.headers()['content-type'] });
      const cors = { 'access-control-allow-origin': '*' };
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*' } });
      if (gasDown) return r.abort('failed');
      r.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(gas.post(JSON.parse(req.postData()))) });
    });
  };
  let gasDown = false;
  async function device() { const c = await browser.newContext({ viewport: { width: 390, height: 844 } }); await setup(c); await gasRoute(c); const pg = await c.newPage(); await pg.goto(INDEX); return { c, pg }; }
  const dev1 = await device(), A = dev1.pg;
  await A.waitForSelector('#setup:not([hidden])');
  await A.fill('#connCode', 'でたらめ'); await A.click('#btnConnect'); await A.waitForFunction(() => /形式が正しくありません/.test(document.querySelector('#toast').textContent)); assert.ok(await A.isVisible('#setupMsg')); assert.match(await A.textContent('#setupMsg'), /形式が正しくありません/); ok('不正な接続コードは形式エラー(接続画面の中に表示される)');
  gasDown = true; await A.fill('#connCode', code); await A.click('#btnConnect'); await A.waitForFunction(() => /サーバーに接続できません/.test(document.querySelector('#setupMsg').textContent)); assert.ok(await A.isVisible('#setupMsg')); assert.equal(await A.textContent('#btnConnect'), '接続'); gasDown = false; ok('サーバーに届かないときは原因の候補つきで画面に表示され、再度押せる');
  const badKey = Buffer.from(JSON.stringify({ u: JSON.parse(Buffer.from(code.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).u, k: 'wrongkey' })).toString('base64');
  await A.fill('#connCode', badKey); await A.click('#btnConnect'); await A.waitForFunction(() => /接続コードが違います/.test(document.querySelector('#setupMsg').textContent)); ok('キー違いは「接続コードが違います」(接続画面に表示)');
  await A.fill('#connCode', code); await A.click('#btnConnect'); await A.waitForFunction(() => document.getElementById('setup').hidden); await A.click('#btnInc'); await A.waitForSelector('#ov.on');
  await A.fill('#ov input >> nth=0', '火災出動'); await A.fill('#ov input >> nth=1', '指揮隊'); await A.click('#ov .btns .pri'); await A.waitForFunction(() => !document.querySelector('#ov.on'));
  assert.match(await A.textContent('#sync'), /同期済み/); ok('接続コードで接続・同期済み表示');
  await tool(A, '[data-mode=memo]'); await tap(A, 0.4, 0.4); await A.waitForSelector('#ov.on'); await answer(A, '消火栓あり');
  await A.waitForFunction(() => /同期済み/.test(document.querySelector('#sync').textContent));
  let rows = gas.sheet('items')._dump().slice(1); assert.equal(rows.length, 1); assert.equal(rows[0][1], '火災出動'); assert.equal(rows[0][4], '指揮隊'); assert.equal(JSON.parse(rows[0][3]).text, '消火栓あり'); ok('書き込みがスプレッドシート(items)に保存される(隊名・事案名つき)');
  assert.ok(!gasReqs.some(r => r.method === 'OPTIONS')); assert.ok(gasReqs.every(r => /text\/plain/.test(r.ct || 'text/plain'))); ok('API通信はプリフライトなしの単純リクエスト');
  const dev2 = await device(), B = dev2.pg;
  await B.fill('#connCode', code); await B.click('#btnConnect'); await B.waitForFunction(() => document.getElementById('setup').hidden); await B.click('#btnInc'); await B.waitForSelector('#ov.on');
  await B.fill('#ov input >> nth=0', '火災出動'); await B.fill('#ov input >> nth=1', '救急2隊'); await B.click('#ov .btns .pri'); await B.waitForFunction(() => !document.querySelector('#ov.on'));
  await B.waitForFunction(() => [...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '消火栓あり')); ok('別端末(別コンテキスト)に共有データが表示される');
  // 別端末で追加 → A に約8秒で反映 / 別端末で削除 → A から消える
  await tool(B, '[data-mode=memo]'); await tap(B, 0.6, 0.3); await B.waitForSelector('#ov.on'); await answer(B, '2隊メモ');
  await A.waitForFunction(() => [...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '2隊メモ'), null, { timeout: 12000 }); ok('他端末の書き込みが約8秒で反映');
  const pos = await B.evaluate(() => { const r = [...items.values()].find(x => x.data.text === '2隊メモ'); const p = map.latLngToContainerPoint(r.data.pos); const b = document.getElementById('map').getBoundingClientRect(); return [b.left + p.x, b.top + p.y - 10]; });
  await B.mouse.click(...pos); await B.waitForSelector('.pp button'); await B.click('.pp button');
  await A.waitForFunction(() => ![...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '2隊メモ'), null, { timeout: 12000 }); ok('他端末での削除が反映');
  assert.equal(gas.sheet('items')._dump().slice(1).filter(r => r[6] !== true && r[6] !== 'TRUE').length, 1); ok('スプレッドシート側は論理削除(deleted=TRUE)');
  // 圏外: 書き込みは端末に残り、復帰したら自動で再送(重複しない)
  gasDown = true; await tool(A, '[data-mode=memo]'); await tap(A, 0.2, 0.2); await A.waitForSelector('#ov.on'); await answer(A, '圏外で書いた');
  await A.waitForFunction(() => /未送信 1件/.test(document.querySelector('#sync').textContent)); assert.match(await A.textContent('#errors'), /未送信 1件/);
  assert.ok((await A.$$eval('.leaflet-tooltip', e => e.map(x => x.textContent))).includes('圏外で書いた')); ok('圏外でも書ける(画面に即反映・未送信件数を表示)');
  await A.reload(); await A.waitForFunction(() => [...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '圏外で書いた')); ok('圏外のまま再起動しても内容(キャッシュ+未送信)が残る');
  gasDown = false; await A.click('#sync'); await A.waitForFunction(() => /同期済み/.test(document.querySelector('#sync').textContent), null, { timeout: 15000 });
  rows = gas.sheet('items')._dump().slice(1).filter(r => r[6] !== true && r[6] !== 'TRUE'); assert.equal(rows.filter(r => JSON.parse(r[3]).text === '圏外で書いた').length, 1); ok('復帰後に自動再送され、重複しない');
  // 事案の削除
  await A.click('#btnInc'); await A.click('#ov .chips button:has-text("この事案のデータを削除")'); await A.click('#ov .btns .pri'); await A.waitForFunction(() => /を削除しました/.test(document.querySelector('#toast').textContent));
  assert.equal(gas.sheet('items')._dump().slice(1).filter(r => r[6] !== true && r[6] !== 'TRUE').length, 0); ok('設定から事案のデータを削除できる');
  // ---- マイマップは接続モードでスプレッドシートに保存される ----
  await A.evaluate(() => commitMy('hydrant', { pos: [35.68, 139.76], label: 'テスト栓' }));
  await A.waitForFunction(() => /同期済み/.test(document.querySelector('#sync').textContent));
  const myRows = gas.sheet('items')._dump().slice(1).filter(r => r[2] === 'hydrant'); assert.equal(myRows.length, 1); assert.equal(myRows[0][1], 'マイマップ'); ok('マイマップの記録はスプレッドシートに「マイマップ」として保存される');
  await dev1.c.close(); await dev2.c.close();


  // ================= マイマップ(普段の記録) =================
  const gm = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['geolocation'], geolocation: { latitude: 35.6801, longitude: 139.7660 } }); await setup(gm);
  const M = await gm.newPage(); await M.goto(INDEX); await M.click('#btnLocal'); await M.waitForFunction(() => Math.abs(map.getCenter().lat - 35.6801) < 0.001);
  assert.equal((await M.$$('#rowDraw .tb')).length, 6); await M.click('#tabs button[data-tab=mymap]');
  assert.equal((await M.$$('#rowDraw .tb')).length, 6);
  const labels = (await M.$$eval('#rowDraw .tb', b => b.map(x => x.textContent))).join('|'); for (const w of ['進入場所', '通行止め', '狭い道', '消火栓', '水利', '危険個所']) assert.ok(labels.includes(w), w);
  ok('「マイマップ」タブに、進入場所・通行止め・狭い道・消火栓・水利・危険個所の6つの機能項目が並ぶ');
  const form = async (fn) => { await M.waitForSelector('#ov.on'); await fn(); await M.click('#ov .btns .pri'); await M.waitForFunction(() => !document.querySelector('#ov.on')); };
  await tool(M, '[data-mode=hydrant]'); await tap(M, 0.3, 0.3); await form(() => M.click('#ov .chips button:has-text("地上式")'));
  await tap(M, 0.35, 0.3); await form(() => M.click('#ov .chips button:has-text("地下式")')); assert.ok(await M.isVisible('#pending.on')); ok('消火栓は続けて何か所でも記録できる');
  await M.click('#btnCancel'); await tool(M, '[data-mode=water]'); await tap(M, 0.6, 0.3); await form(() => M.click('#ov .chips button:has-text("河川")')); await M.click('#btnCancel');
  await tool(M, '[data-mode=narrow]'); await tap(M, 0.2, 0.5); await tap(M, 0.3, 0.5); await tap(M, 0.4, 0.55); await M.click('#btnOk');
  await form(async () => { await M.fill('#ov input[type=number]', '2.0'); await M.click('#ov .chips button:has-text("すれ違い不可")'); });
  await tool(M, '[data-mode=hazard]'); await tap(M, 0.7, 0.6); await M.waitForSelector('#ov.on'); assert.equal(await M.isChecked('#ov input[type=checkbox]'), true); ok('危険個所は「経路検索で避ける」が初期オン');
  await form(async () => { await M.click('#ov .chips button:has-text("落石")'); await M.fill('#ov input[type=number]', '30'); });
  await tool(M, '[data-mode=approach]'); await tap(M, 0.2, 0.8); await tap(M, 0.5, 0.75); await M.click('#btnOk'); await form(() => M.click('#ov .chips button:has-text("自宅")'));
  const mine = (await items(M)).filter(r => !r.deleted); assert.deepEqual(mine.map(r => r.type).sort(), ['approach', 'hazard', 'hydrant', 'hydrant', 'narrow', 'water']); assert.ok(mine.every(r => r.incident === 'マイマップ'));
  const nw = mine.find(r => r.type === 'narrow').data; assert.equal(nw.width, 2); assert.equal(nw.avoid, false); assert.equal(nw.points.length, 3); assert.equal(mine.find(r => r.type === 'hazard').data.radius, 30);
  const tips = await M.$$eval('.leaflet-tooltip', e => e.map(x => x.textContent)); assert.ok(tips.some(x => /狭い道 幅2m/.test(x)) && tips.includes('自宅')); ok('5種類の記録が、専用の保存先(マイマップ)に保存され、地図に表示される');
  await M.click('.my.hy >> nth=0'); await M.waitForSelector('.pp button.edit'); await M.click('.pp button.edit'); await form(async () => { await M.fill('#ov input[type=text]', '公設 40t 水槽'); });
  assert.ok((await items(M)).some(r => r.type === 'hydrant' && r.data.label === '公設 40t 水槽')); ok('記録をタップして編集できる');
  await M.click('#btnInc'); await M.waitForSelector('#ov.on'); await M.fill('#ov input >> nth=0', 'マイマップ'); await M.click('#ov .btns .pri'); assert.ok(await M.isVisible('#ov.on')); await M.waitForFunction(() => /事案名には使えません/.test(document.querySelector('#toast').textContent)); ok('事案名に「マイマップ」は使えない');
  await M.fill('#ov input >> nth=0', '別の出動'); await M.click('#ov .btns .pri'); await M.waitForFunction(() => !document.querySelector('#ov.on'));
  await M.waitForFunction(() => document.querySelectorAll('.my').length === 4); ok('事案を切り替えても、マイマップの記録は消えず表示される');
  await M.reload(); await M.waitForFunction(() => document.querySelectorAll('.my').length === 4); assert.ok(await M.isVisible('#tabs button.on[data-tab=mymap]')); ok('再起動しても記録とタブの選択が残る');
  await gm.close();

  // ---- マイマップをもとに経路を選び直す ----
  const gr = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['geolocation'], geolocation: { latitude: 35.6801, longitude: 139.7660 } });
  await gr.addInitScript(() => localStorage.setItem('dm_vehicles_v1', JSON.stringify({ selected: 'ambulance', dims: { ambulance: { width: 2.3, height: 3, weight: 5, length: 6 }, fire: {}, large: {} } })));
  await setup(gr);
  const R = await gr.newPage(); await R.goto(INDEX); await R.click('#btnLocal'); await R.waitForFunction(() => Math.abs(map.getCenter().lat - 35.6801) < 0.001);
  await R.evaluate(() => {
    commitMy('narrow', { points: [[35.683, 139.7662], [35.683, 139.7686]], width: 2.0, label: '一方通行', avoid: false });        // 車両幅2.3m > 道幅2.0m → 自動で避ける
    commitMy('narrow', { points: [[35.6840, 139.769], [35.6855, 139.769]], width: 5.0, label: 'ゆとりあり', avoid: false });     // 通れる → 注意のみ
    commitMy('hazard', { pos: [35.6815, 139.7660], label: '落石', radius: 20, avoid: true });                                      // 避ける
    commitMy('hazard', { pos: [35.70, 139.80], label: '遠い危険', radius: 20, avoid: true });                                      // 出発〜目標から遠い → 考慮しない
    commitMy('hazard', { pos: [35.6845, 139.7690], label: '注意だけ', radius: 15, avoid: false });
    commitMy('closure', { points: [[35.6848, 139.7692], [35.6850, 139.7692]], label: '工事' });                                   // 通行止め → 常に避ける                                 // 注意のみ
  });
  mocks.valhalla.length = 0;
  await tool(R, '[data-mode=goal]'); await tap(R, 0.6, 0.4); await R.waitForFunction(() => document.querySelector('#sheet .sum') && document.querySelector('.fd'));
  const rq = JSON.parse(new URL(mocks.valhalla[0]).searchParams.get('json'));
  assert.equal(rq.exclude_polygons.length, 3); for (const ring of rq.exclude_polygons) { assert.deepEqual(ring[0], ring.at(-1)); assert.ok(ring.every(p => p[0] > 100 && p[1] < 90)); }
  ok('経路検索の回避エリア: 通行止め・「避ける」危険個所・車両幅で通れない狭い道だけが渡される(通れる道・遠い記録・注意のみは渡さない)');
  const sheetTxt = await R.textContent('#sheet'); assert.match(sheetTxt, /3か所を避けて経路を選びました/); assert.match(sheetTxt, /通行止め\(工事\)/); assert.match(sheetTxt, /危険個所\(落石\)/); assert.match(sheetTxt, /狭い道\(幅2m\)/); ok('どこを避けたかを経路シートに表示');
  await R.click('#sheet .tabs button:has-text("注意箇所")');
  const mineF = await R.$$eval('#sheet .find', b => b.map(x => x.textContent).filter(x => x.includes('【マイマップ】')));
  assert.equal(mineF.length, 5, mineF.join(' / ')); assert.ok(mineF.some(x => /通行困難.*通行止め: 工事\(避けられない経路です\)/.test(x))); assert.ok(mineF.some(x => /通行困難.*危険個所: 落石\(避ける設定\)/.test(x))); assert.ok(mineF.some(x => /通行困難.*幅2m.*車両幅2.3m/.test(x))); assert.ok(mineF.some(x => /要確認.*幅5m/.test(x))); assert.ok(mineF.some(x => /要確認.*注意だけ/.test(x)));
  assert.ok(!mineF.some(x => x.includes('遠い危険'))); ok('経路沿いの記録が注意箇所に出る(避けきれない/通れない=赤、注意だけ=橙)');
  // 避ける経路がない → 避けずに案内し、理由を表示
  mocks.v442 = true; mocks.valhalla.length = 0; await R.click('#sheet .tabs button:has-text("経路案内")'); await tool(R, '#act-route');
  await R.waitForFunction(() => /避ける経路が見つかりませんでした/.test(document.querySelector('#sheet').textContent));
  assert.equal(mocks.valhalla.length, 2); assert.equal(JSON.parse(new URL(mocks.valhalla[1]).searchParams.get('json')).exclude_polygons, undefined); mocks.v442 = false; ok('避ける経路が見つからないときは、避けずに探し直し、その旨を警告表示');
  // 目標付近の水利
  await R.evaluate(() => { const g = getItem('goal').data.pos; commitMy('hydrant', { pos: [g[0] + 0.001, g[1]], label: '公設消火栓' }); commitMy('water', { pos: [g[0], g[1] + 0.002], label: '川' }); commitMy('hydrant', { pos: [g[0] + 0.05, g[1]], label: '遠い栓' }); });
  await tool(R, '#act-check'); await R.waitForFunction(() => /目標付近の水利/.test(document.querySelector('#sheet').textContent));
  const wt = await R.textContent('#sheet'); assert.ok(wt.includes('公設消火栓') && wt.includes('川') && !wt.includes('遠い栓')); ok('目標付近(500m以内)の消火栓・水利を近い順に一覧表示');
  await R.screenshot({ path: SHOT + '/shot-mymap.png' });
  await gr.close();


  // ================= 画面構成: 3つのタブ・機能項目(チップ/一覧)・Googleマップ風 =================
  const gu = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['geolocation'], geolocation: { latitude: 35.6801, longitude: 139.7660 } }); await setup(gu);
  const U = await gu.newPage(); await U.goto(INDEX); await U.click('#btnLocal'); await U.waitForFunction(() => Math.abs(map.getCenter().lat - 35.6801) < 0.001);
  const tabNames = await U.$$eval('#tabs button', b => b.map(x => x.textContent)); assert.ok(['マイマップ', '経路案内', '現場'].every((n, i) => tabNames[i].includes(n))); assert.equal(await U.getAttribute('body', 'data-tab'), 'mymap'); ok('下のタブは「マイマップ」「経路案内」「現場」。最初はマイマップ');
  const chipTxt = await U.$$eval('#chips .chip', c => c.map(x => x.textContent)); for (const n of ['進入場所', '通行止め', '狭い道', '消火栓', '水利', '危険個所']) assert.ok(chipTxt.some(x => x.includes(n)), n); ok('機能項目(進入場所・通行止め・狭い道・消火栓・水利・危険個所)が、チップとして地図の上に並ぶ');
  const css = await U.evaluate(() => { const g = s => getComputedStyle(document.querySelector(s)); return { body: g('body').backgroundColor, tab: g('#tabs button.on').color, warn: g('#warn').backgroundColor, route: g('#navStart').backgroundColor, info: g('#info').backgroundColor }; });
  assert.equal(css.body, 'rgb(255, 255, 255)'); assert.equal(css.tab, 'rgb(26, 115, 232)'); assert.equal(css.warn, 'rgb(254, 247, 224)'); assert.equal(css.route, 'rgb(26, 115, 232)'); assert.equal(css.info, 'rgb(255, 255, 255)'); ok('Googleマップ風の配色(白い面・青 #1a73e8・注意は琥珀色)');
  mocks.valhalla.length = 0; await tap(U, 0.5, 0.5); await U.waitForTimeout(400); assert.equal(mocks.valhalla.length, 0); assert.equal((await items(U)).length, 0); ok('マイマップのタブで地図をタップしても、目的地にはならない(誤操作防止)');
  await U.click('[data-mode=approach]'); await tap(U, 0.3, 0.4); await U.click('#btnOk'); await U.waitForSelector('#ov.on'); await U.click('#ov .chips button:has-text("正面入口")'); await U.click('#ov .btns .pri'); await U.waitForFunction(() => !document.querySelector('#ov.on'));
  assert.ok(await U.$('.my.ap')); assert.equal((await items(U)).find(r => r.type === 'approach').data.points.length, 1); ok('進入場所は1点タップで記録できる(進入経路は点でなぞって線にもできる)');
  await U.click('[data-mode=closure]'); await tap(U, 0.5, 0.45); await tap(U, 0.7, 0.45); await U.click('#btnOk'); await U.waitForSelector('#ov.on'); await U.click('#ov .chips button:has-text("工事")'); await U.click('#ov .btns .pri'); await U.waitForFunction(() => !document.querySelector('#ov.on'));
  assert.ok((await U.$$eval('.leaflet-tooltip', e => e.map(x => x.textContent))).some(x => x.includes('通行止め / 工事'))); ok('通行止めを線で記録できる(理由つき)');
  await U.evaluate(() => { commitMy('hydrant', { pos: [35.6805, 139.7662], label: '地上式' }); commitMy('narrow', { points: [[35.6810, 139.7655], [35.6810, 139.7665]], width: 2.5, label: '' }); });
  await U.waitForFunction(() => document.querySelectorAll('.chip .cn').length === 6);
  const cnt = await U.$$eval('#chips .chip', c => Object.fromEntries(c.map(x => [x.dataset.cat, x.querySelector('.cn').textContent]))); assert.deepEqual(cnt, { approach: '1', closure: '1', narrow: '1', hydrant: '1', water: '0', hazard: '0' }); ok('チップに種類ごとの件数が出る');
  await U.click('#chips .chip[data-cat=closure]'); await U.waitForFunction(() => !document.querySelector('.leaflet-tooltip') || ![...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent.includes('通行止め')));
  assert.equal(await U.$eval('#chips .chip[data-cat=closure]', c => c.classList.contains('on')), false); ok('チップをタップすると、その種類の表示/非表示を切り替えられる');
  await U.reload(); await U.waitForSelector('#chips .chip'); assert.equal(await U.$eval('#chips .chip[data-cat=closure]', c => c.classList.contains('on')), false);
  await U.waitForFunction(() => document.querySelectorAll('.leaflet-tooltip').length >= 1); const tp = await U.$$eval('.leaflet-tooltip', e => e.map(x => x.textContent)); assert.ok(!tp.some(x => x.includes('通行止め')), JSON.stringify(tp)); ok('表示の切り替えは再起動しても残る');
  await U.click('#chips .chip[data-cat=closure]');
  await U.click('#fabList'); await U.waitForSelector('#sheet .catHead'); const listTxt = await U.textContent('#sheet');
  for (const n of ['進入場所 (1)', '通行止め (1)', '狭い道 (1)', '消火栓 (1)', '水利 (0)', '危険個所 (0)']) assert.ok(listTxt.includes(n), n); ok('「記録一覧」に、機能項目ごとにまとめた記録の一覧が出る');
  await U.click('#sheet .find:has-text("正面入口")'); await U.waitForSelector('.leaflet-popup'); assert.match(await U.textContent('.leaflet-popup'), /進入場所/); assert.equal(await U.isVisible('#sheet'), false); ok('一覧の記録をタップすると、その場所へ移動して詳細を開く');
  await U.click('#tabs button[data-tab=route]'); await U.waitForFunction(() => document.querySelector('#pending.on') && /目的地を地図でタップ/.test(document.querySelector('#pending').textContent)); ok('経路案内タブでは、目的地の指定を案内する');
  await tap(U, 0.85, 0.75); await U.waitForFunction(() => document.querySelector('#sheet .sum')); assert.equal(mocks.valhalla.length, 1); assert.equal(await U.isVisible('#pending'), false); ok('経路案内タブで地図をタップするだけで、目的地になり現在地から経路が出る');
  assert.equal(await U.$$eval('#rowDraw .tb', b => b.length), 5); await U.click('#tabs button[data-tab=event]'); assert.equal(await U.$$eval('#rowDraw .tb', b => b.length), 4); ok('機能項目の行はタブごとに切り替わる(経路案内=5、現場=4、マイマップ=6)');
  await U.screenshot({ path: SHOT + '/shot-event.png' });
  await U.click('#tabs button[data-tab=mymap]'); await U.click('#fabList'); await U.waitForSelector('#sheet .catHead'); await U.screenshot({ path: SHOT + '/shot-mymap-list.png' });
  await gu.close();

  // ================= Googleマップのように使う =================
  const g1 = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['geolocation'], geolocation: { latitude: 34.7024, longitude: 135.4959 } }); await setup(g1);
  const P = await g1.newPage(); await P.goto(INDEX); await P.click('#btnLocal'); await P.waitForFunction(() => Math.abs(map.getCenter().lat - 34.7024) < 0.001);
  mocks.valhalla.length = 0;
  await P.click('#tabs button[data-tab=route]'); await tap(P, 0.6, 0.4); await P.waitForFunction(() => document.querySelector('#sheet .sum'));
  const r1 = JSON.parse(new URL(mocks.valhalla[0]).searchParams.get('json'));
  assert.ok(Math.abs(r1.locations[0].lat - 34.7024) < 1e-4 && Math.abs(r1.locations[0].lon - 135.4959) < 1e-4); assert.match(await P.textContent('#sheet'), /出発: 現在地/);
  assert.equal((await items(P)).filter(r => r.type === 'start').length, 0); ok('出発地点を置かなくても、目標をタップするだけで現在地から経路が出る(出発地点は保存されない)');
  await g1.close();
  const g2 = await browser.newContext({ viewport: { width: 390, height: 844 } }); await setup(g2);
  const Q = await g2.newPage(); await Q.goto(INDEX); await Q.click('#btnLocal'); await Q.waitForFunction(() => document.getElementById('setup').hidden);
  await Q.waitForFunction(() => /現在地を取得できません/.test(document.querySelector('#toast').textContent)); assert.ok(await Q.isVisible('#toast'));
  await tool(Q, '[data-mode=memo]'); await tap(Q, 0.5, 0.5); await Q.waitForSelector('#ov.on'); await answer(Q, '位置情報なしでも使える'); assert.equal((await items(Q)).length, 1); ok('位置情報が許可されなくても、メッセージを出して通常どおり使える');
  await g2.close();

  // ================= 経路案内(ナビ) =================
  const g3 = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['geolocation'], geolocation: { latitude: 35.6801, longitude: 139.7660 } });
  await g3.addInitScript(() => { window.__spoken = []; Object.defineProperty(window, 'speechSynthesis', { value: { speak: u => window.__spoken.push(u.text), cancel() {} } }); window.SpeechSynthesisUtterance = function (t) { this.text = t; }; });
  await setup(g3);
  const N = await g3.newPage(); await N.goto(INDEX); await N.click('#btnLocal'); await N.waitForFunction(() => Math.abs(map.getCenter().lat - 35.6801) < 0.001);
  mocks.valhalla.length = 0;
  await tool(N, '[data-mode=goal]'); await tap(N, 0.6, 0.4); await N.waitForFunction(() => document.querySelector('#sheet .sum') && document.querySelector('.fd'));
  assert.ok(await N.isVisible('#sheet .navgo')); ok('経路が出ると、シートに「案内を開始」ボタンが出る');
  const say = () => N.evaluate(() => window.__spoken.slice());
  for (const id of ['#navTop', '#navBottom']) assert.equal(await N.isVisible(id), false); ok('案内を始める前は、案内用のバナー・バーは見えない');
  await N.click('#sheet .navgo');
  assert.ok(await N.evaluate(() => document.body.classList.contains('navigating'))); assert.ok((await say())[0].includes('案内を開始します')); ok('案内開始(開始の音声は押した操作の中で出る)');
  await N.waitForFunction(() => /右折です/.test(document.getElementById('navTop').textContent)); const top1 = await N.textContent('#navTop');
  assert.ok(!/null|undefined/.test(top1), 'バナーに null が出ない'); assert.match(top1, /3[0-4]0 m/); assert.match(await N.textContent('#navTop .ng'), /↱/); assert.match(await N.textContent('#navBottom'), /残り|km|分/); ok('次の曲がり角(右折・約320m・矢印)と残り距離・時間・到着時刻を表示: ' + top1.replace(/\s+/g, ' ').slice(0, 40));
  assert.ok((await say()).some(s => /メートル先、右折です/.test(s))); ok('500m以内に入ると音声で案内(距離+操作)');
  assert.ok(await N.isVisible('#navTop')); assert.equal(await N.isVisible('#rowDraw'), false); ok('案内中は書き込みボタンを隠す');
  const spokenBefore = (await say()).length;
  await g3.setGeolocation({ latitude: 35.6820, longitude: 139.7660 });
  await N.waitForFunction(() => /1[01]\d m|9\d m/.test(document.querySelector('#navTop .nd').textContent));
  await N.waitForFunction(() => window.__spoken.some(s => /前方.*要確認の箇所があります/.test(s)), null, { timeout: 8000 }); assert.match(await N.textContent('#navTop .nw'), /⚠/);
  assert.ok((await say()).length > spokenBefore); ok('200m手前の案内と、前方の通行注意箇所の事前警告(音声+画面)');
  await g3.setGeolocation({ latitude: 35.68295, longitude: 139.7660 }); await N.waitForFunction(() => window.__spoken.filter(s => /右折です/.test(s)).length >= 3); ok('50m手前でもう一度案内(500m/200m/50mの3段階)');
  await g3.setGeolocation({ latitude: 35.6831, longitude: 139.7664 });
  await N.waitForFunction(() => /左折です/.test(document.getElementById('navTop').textContent)); assert.match(await N.textContent('#navTop .ng'), /↰/); ok('曲がり角を過ぎると次の案内(左折)に自動で切り替わる');
  assert.equal(mocks.valhalla.length, 1);
  await g3.setGeolocation({ latitude: 35.6840, longitude: 139.7720 });
  await N.waitForFunction(() => window.__spoken.some(s => /再検索/.test(s))); for (let i = 0; i < 40 && mocks.valhalla.length < 2; i++) await N.waitForTimeout(100);
  assert.equal(mocks.valhalla.length, 2); const rr = JSON.parse(new URL(mocks.valhalla[1]).searchParams.get('json')); assert.ok(Math.abs(rr.locations[0].lat - 35.684) < 1e-4 && Math.abs(rr.locations[0].lon - 139.772) < 1e-4); ok('経路から外れると自動でルート再検索(現在地から・同じ車両条件)');
  await g3.setGeolocation({ latitude: 35.6860, longitude: 139.7690 });
  await N.waitForFunction(() => !document.body.classList.contains('navigating'), null, { timeout: 8000 }); assert.ok((await say()).some(s => /到着/.test(s))); ok('目的地付近で「到着しました」と案内して終了');
  assert.ok(await N.isVisible('#navStart')); ok('案内を終えると、地図上に「案内開始」ボタンが戻る'); await g3.setGeolocation({ latitude: 35.6812, longitude: 139.7660 }); await N.waitForTimeout(1300); await N.click('#navStart'); await N.waitForFunction(() => /右折です/.test(document.getElementById('navTop').textContent)); await N.click('#navEnd');
  assert.equal(await N.evaluate(() => document.body.classList.contains('navigating')), false); for (const id of ['#navTop', '#navBottom']) assert.equal(await N.isVisible(id), false); ok('「終了」ボタンで案内を止められる(バナーも消える)');
  await N.screenshot({ path: SHOT + '/shot-route.png' });
  await g3.setGeolocation({ latitude: 35.6812, longitude: 139.7660 });
  await N.click('#navStart'); await N.waitForFunction(() => /右折です/.test(document.getElementById('navTop').textContent)); await N.waitForTimeout(600); await N.screenshot({ path: SHOT + '/shot-nav.png' });
  await g3.close();

  await page.screenshot({ path: SHOT + '/shot-main.png' });
  assert.deepEqual(pageErrors, []); ok('JSの未捕捉エラーなし');
  await browser.close();
  fs.writeFileSync(SHOT + '/e2e-result.txt', log.join('\n') + '\n');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
