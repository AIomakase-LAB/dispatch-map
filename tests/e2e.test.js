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
      { type: 'way', id: 2, center: { lat: base[0] + 0.002, lon: base[1] }, tags: { highway: 'residential', maxheight: '3.2' } },                       // 高さ3.2, 車両3.0 → 橙(余裕0.2)
      { type: 'node', id: 3, lat: base[0], lon: base[1] + 0.001, tags: { barrier: 'bollard' } },                                                         // 赤
      { type: 'node', id: 4, lat: base[0], lon: base[1] + 0.002, tags: { barrier: 'gate' } },                                                            // 橙
      { type: 'way', id: 5, center: { lat: base[0] - 0.001, lon: base[1] }, tags: { highway: 'service', access: 'private' } },                           // 橙
      { type: 'way', id: 6, center: { lat: base[0] - 0.002, lon: base[1] }, tags: { highway: 'residential', maxheight: '4.5', maxweight: '10' } },       // 問題なし(null)
      { type: 'way', id: 7, center: { lat: base[0] - 0.003, lon: base[1] }, tags: { highway: 'residential', motor_vehicle: 'no' } },                     // 赤
    ] }) });
  });
  await ctx.route('**/valhalla1.openstreetmap.de/**', r => {
    mocks.valhalla.push(r.request().url());
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ trip: { summary: { length: 1.23, time: 300 }, legs: [{
      shape: enc6([[35.680, 139.766], [35.681, 139.767], [35.682, 139.768]]),
      maneuvers: [{ instruction: '北東に進む', length: 0.5, time: 100 }, { instruction: '目的地に到着です', length: 0.7, time: 200 }] }] } }) });
  });
}
const tap = (page, fx, fy) => page.evaluate(([fx, fy]) => { const r = document.getElementById('map').getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; }, [fx, fy]).then(([x, y]) => page.mouse.click(x, y));
const ls = (page, k) => page.evaluate(k => localStorage.getItem(k), k);
const items = async page => JSON.parse(await ls(page, 'dm_local_items') || '[]');
async function answer(page, text) { if (text != null) await page.fill('#ov input', text); await page.click('#ov .btns .pri'); await page.waitForSelector('#ov.on', { state: 'detached' }).catch(() => {}); await page.waitForFunction(() => !document.querySelector('#ov.on')); }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: false, permissions: [] });
  await setup(ctx);
  const page = await ctx.newPage();
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(INDEX);
  await page.waitForSelector('#setup:not([hidden])'); assert.match(await page.textContent('#setup'), /接続コード/); ok('未接続なら接続画面が出る');
  await page.click('#btnLocal'); await page.waitForSelector('#ov.on');

  // 初回: 隊名未設定なら設定モーダルが出る
  await page.fill('#ov input >> nth=0', '事案A'); await page.fill('#ov input >> nth=1', '救急1隊'); await page.click('#ov .btns .pri');
  await page.waitForFunction(() => !document.querySelector('#ov.on'));
  assert.match(await page.textContent('#btnInc'), /事案A \/ 救急1隊/); ok('初回の事案名・隊名設定');
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
  await page.click('[data-mode=arrow]'); await tap(page, 0.3, 0.5); await tap(page, 0.7, 0.5);
  await page.waitForSelector('#ov.on'); assert.match(await page.textContent('#ov h3'), /東向き進入/);
  await answer(page, '西側から進入');
  await page.waitForSelector('.albl'); assert.match(await page.textContent('.albl'), /東向き進入 \/ 西側から進入/); ok('進入方向の矢印と方位・ラベル表示(東向き)');
  // 北東向き
  await page.click('[data-mode=arrow]'); await tap(page, 0.3, 0.8); await tap(page, 0.45, 0.65); await page.waitForSelector('#ov.on');
  const t = await page.textContent('#ov h3'); assert.match(t, /向き進入/); await answer(page, ''); ok('北東系の方位名: ' + t);

  // 通行不可エリア
  await page.click('[data-mode=area]');
  await tap(page, 0.2, 0.2); await tap(page, 0.4, 0.2);
  await page.click('#btnOk'); assert.match(await page.textContent('#toast'), /あと1点/); ok('頂点不足では確定できない');
  await tap(page, 0.4, 0.35); await page.click('#btnOk'); await page.waitForSelector('#ov.on'); await answer(page, '冠水');
  await page.waitForSelector('path[fill="#d62828"]'); assert.equal(await page.getAttribute('path[fill="#d62828"]', 'fill-opacity'), '0.35'); ok('通行不可ポリゴン(赤半透明)');

  // 線・メモ(XSS)
  await page.click('[data-mode=line]'); await tap(page, 0.6, 0.2); await tap(page, 0.8, 0.3); await page.click('#btnOk'); await page.waitForSelector('#ov.on'); await answer(page, '迂回路');
  const xss = '<img src=x onerror="window.__xss=1">&"\'';
  await page.click('[data-mode=memo]'); await tap(page, 0.8, 0.6); await page.waitForSelector('#ov.on'); await answer(page, xss);
  await page.waitForSelector('.leaflet-tooltip');
  assert.equal(await page.evaluate(() => window.__xss), undefined); assert.equal(await page.$('.leaflet-tooltip img'), null);
  assert.ok((await page.$$eval('.leaflet-tooltip', e => e.map(x => x.textContent))).some(x => x.includes('<img src=x'))); ok('メモの<img>等はエスケープされ実行されない');

  // 出発・目標(各1つ)
  await page.click('[data-mode=start]'); await tap(page, 0.2, 0.8);
  mocks.overpass.length = 0;
  await page.click('[data-mode=goal]'); await tap(page, 0.5, 0.5);
  await page.waitForSelector('.fd.red'); 
  await page.click('[data-mode=start]'); await tap(page, 0.25, 0.85);
  let all = (await items(page)).filter(r => !r.deleted);
  assert.equal(all.filter(r => r.type === 'start').length, 1); assert.equal(all.filter(r => r.type === 'goal').length, 1); ok('出発・目標は事案につき1つ(再設定は置換)');

  // Overpass 自動検索
  const q = decodeURIComponent(mocks.overpass[0].body.replace(/^data=/, ''));
  assert.equal(mocks.overpass[0].method, 'POST'); assert.match(mocks.overpass[0].ct, /x-www-form-urlencoded/);
  for (const w of ['around:600', 'maxwidth', 'maxheight', '"width"', 'barrier', 'access', 'motor_vehicle']) assert.ok(q.includes(w), w);
  ok('目標設定でOverpass(半径600m, 必要タグ, プリフライト不要のform POST)');
  const red = await page.$$('.fd.red'), org = await page.$$('.fd.orange');
  assert.equal(red.length, 3); assert.equal(org.length, 3); ok(`判定: 赤${red.length}/橙${org.length}(期待どおり。問題なしの1件は非表示)`);
  assert.ok((await page.textContent('#sheet')).includes('通行困難')); await page.screenshot({ path: SHOT + '/shot-findings.png' });
  await page.click('#sheet .find >> nth=0'); await page.waitForTimeout(900); assert.ok(await page.$('.leaflet-popup')); ok('一覧タップで該当箇所へ移動しポップアップ');

  // 経路検索
  await page.click('#act-route'); await page.waitForTimeout(1500); await page.waitForFunction(() => document.querySelector('#sheet .sum'));
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
  await page.click('[data-mode=memo]'); await tap(page, 0.1, 0.55); await page.waitForSelector('#ov.on'); await answer(page, '同期テスト');
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
  mocks.overpassFail = true; await page.click('#act-check'); await page.waitForSelector('.err');
  assert.match(await page.textContent('#errors'), /Overpass.*HTTP 504/); ok('Overpass失敗時にエラー表示');
  await page.click('[data-mode=memo]'); await tap(page, 0.5, 0.3); await page.waitForSelector('#ov.on'); await answer(page, '失敗後も操作可'); 
  assert.ok((await items(page)).some(r => r.data.text === '失敗後も操作可')); ok('通信失敗後もアプリは動作継続');
  await ctx.route('**/valhalla1.openstreetmap.de/**', r => r.abort('failed'));
  await page.click('#act-route'); await page.waitForFunction(() => /Valhalla/.test(document.querySelector('#errors').textContent)); ok('Valhalla失敗時にエラー表示');

  // 未入力寸法の警告
  await page.click('#btnVeh'); await page.click('#ov .seg button:nth-child(2)'); await page.click('#ov .btns .pri');
  assert.match(await page.textContent('#btnVeh'), /⚠/); ok('寸法未入力の車両は⚠表示');
  mocks.overpassFail = false; await page.click('#act-check'); await page.waitForFunction(() => /未入力のため/.test(document.querySelector('#sheet').textContent)); ok('未入力寸法は判定不可と明示');


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
  await A.fill('#connCode', code); await A.click('#btnConnect'); await A.waitForSelector('#ov.on');
  await A.fill('#ov input >> nth=0', '火災出動'); await A.fill('#ov input >> nth=1', '指揮隊'); await A.click('#ov .btns .pri'); await A.waitForFunction(() => !document.querySelector('#ov.on'));
  assert.match(await A.textContent('#sync'), /同期済み/); ok('接続コードで接続・同期済み表示');
  await A.click('[data-mode=memo]'); await tap(A, 0.4, 0.4); await A.waitForSelector('#ov.on'); await answer(A, '消火栓あり');
  await A.waitForFunction(() => /同期済み/.test(document.querySelector('#sync').textContent));
  let rows = gas.sheet('items')._dump().slice(1); assert.equal(rows.length, 1); assert.equal(rows[0][1], '火災出動'); assert.equal(rows[0][4], '指揮隊'); assert.equal(JSON.parse(rows[0][3]).text, '消火栓あり'); ok('書き込みがスプレッドシート(items)に保存される(隊名・事案名つき)');
  assert.ok(!gasReqs.some(r => r.method === 'OPTIONS')); assert.ok(gasReqs.every(r => /text\/plain/.test(r.ct || 'text/plain'))); ok('API通信はプリフライトなしの単純リクエスト');
  const dev2 = await device(), B = dev2.pg;
  await B.fill('#connCode', code); await B.click('#btnConnect'); await B.waitForSelector('#ov.on');
  await B.fill('#ov input >> nth=0', '火災出動'); await B.fill('#ov input >> nth=1', '救急2隊'); await B.click('#ov .btns .pri'); await B.waitForFunction(() => !document.querySelector('#ov.on'));
  await B.waitForFunction(() => [...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '消火栓あり')); ok('別端末(別コンテキスト)に共有データが表示される');
  // 別端末で追加 → A に約8秒で反映 / 別端末で削除 → A から消える
  await B.click('[data-mode=memo]'); await tap(B, 0.6, 0.3); await B.waitForSelector('#ov.on'); await answer(B, '2隊メモ');
  await A.waitForFunction(() => [...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '2隊メモ'), null, { timeout: 12000 }); ok('他端末の書き込みが約8秒で反映');
  const pos = await B.evaluate(() => { const r = [...items.values()].find(x => x.data.text === '2隊メモ'); const p = map.latLngToContainerPoint(r.data.pos); const b = document.getElementById('map').getBoundingClientRect(); return [b.left + p.x, b.top + p.y - 10]; });
  await B.mouse.click(...pos); await B.waitForSelector('.pp button'); await B.click('.pp button');
  await A.waitForFunction(() => ![...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '2隊メモ'), null, { timeout: 12000 }); ok('他端末での削除が反映');
  assert.equal(gas.sheet('items')._dump().slice(1).filter(r => r[6] !== true && r[6] !== 'TRUE').length, 1); ok('スプレッドシート側は論理削除(deleted=TRUE)');
  // 圏外: 書き込みは端末に残り、復帰したら自動で再送(重複しない)
  gasDown = true; await A.click('[data-mode=memo]'); await tap(A, 0.2, 0.2); await A.waitForSelector('#ov.on'); await answer(A, '圏外で書いた');
  await A.waitForFunction(() => /未送信 1件/.test(document.querySelector('#sync').textContent)); assert.match(await A.textContent('#errors'), /未送信 1件/);
  assert.ok((await A.$$eval('.leaflet-tooltip', e => e.map(x => x.textContent))).includes('圏外で書いた')); ok('圏外でも書ける(画面に即反映・未送信件数を表示)');
  await A.reload(); await A.waitForFunction(() => [...document.querySelectorAll('.leaflet-tooltip')].some(e => e.textContent === '圏外で書いた')); ok('圏外のまま再起動しても内容(キャッシュ+未送信)が残る');
  gasDown = false; await A.click('#sync'); await A.waitForFunction(() => /同期済み/.test(document.querySelector('#sync').textContent), null, { timeout: 15000 });
  rows = gas.sheet('items')._dump().slice(1).filter(r => r[6] !== true && r[6] !== 'TRUE'); assert.equal(rows.filter(r => JSON.parse(r[3]).text === '圏外で書いた').length, 1); ok('復帰後に自動再送され、重複しない');
  // 事案の削除
  await A.click('#btnInc'); await A.click('#ov .chips button:has-text("この事案のデータを削除")'); await A.click('#ov .btns .pri'); await A.waitForFunction(() => /を削除しました/.test(document.querySelector('#toast').textContent));
  assert.equal(gas.sheet('items')._dump().slice(1).filter(r => r[6] !== true && r[6] !== 'TRUE').length, 0); ok('設定から事案のデータを削除できる');
  await dev1.c.close(); await dev2.c.close();

  await page.screenshot({ path: SHOT + '/shot-main.png' });
  assert.deepEqual(pageErrors, []); ok('JSの未捕捉エラーなし');
  await browser.close();
  fs.writeFileSync(SHOT + '/e2e-result.txt', log.join('\n') + '\n');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
