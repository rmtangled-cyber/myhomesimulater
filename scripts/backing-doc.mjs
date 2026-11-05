// ワンダーハウスに渡す「壁の下地」の資料を書き出す: node scripts/backing-doc.mjs
// 出力: notes/下地資料.html（印刷用）と dist-docs/backing.html（Artifact 用）。あとで造作建具の資料もここにまとめる予定
// 下地の物（BACKING）はここに手で書く。id のある物は、位置・高さを間取りの家具から計算する（物の大きさ ±100）。
// 家具から決まらない所（部屋の幅いっぱいの貼り分けなど）は at に直接書く
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BACKING = [
  // 1 階
  { id: 'art-1', what: '玄関のアート（450×600）', who: '施主' },
  { id: 'bracket-1', what: 'アートの上のブラケット（beaubelle bbw-009）', who: 'WH（施主支給）' },
  { id: 'powder-mirror', what: 'ミニ洗面台の丸ミラー（直径 500）', who: '施主' },
  { id: 'powder-towel-hook', side: '東', what: 'タオルフック', who: '施主' },
  { id: 'shoe-shelf-back', what: '樹脂棚板 D450 の棚柱（南の棚・幅 1700 を 2 分割）', who: 'WH' },
  { id: 'shoe-shelf-east', what: '樹脂棚板 D450 の棚柱（玄関側の棚）', who: 'WH' },
  { id: 'shoe-shelf-side', what: '樹脂棚板 D300 の棚柱（靴の棚・土間から天井近くまで 12 段）', who: 'WH' },
  { at: { fi: 0, room: 'シューズクローク', side: '西', wallAt: 60, a0: 4380, a1: 5290, h0: 1650, h1: 1900 }, what: '枕棚の受け（北西・FL+1800）', who: 'WH' },
  { at: { fi: 0, room: 'シューズクローク', side: '北', wallAt: 4382.5, a0: 250, a1: 470, h0: 1600, h1: 1800 }, what: 'コート掛けのハンガーパイプの受け（中心 FL+1700・西の壁から 300）', who: 'WH' },
  // 2 階
  { id: 'pantry-shelf-n', what: 'パントリーの可動棚の棚柱（北の壁）', who: '要相談' },
  { id: 'pantry-shelf-e1', what: 'パントリーの可動棚の棚柱（東の壁）', who: '要相談' },
  { id: 'pantry-shelf-e2', what: 'パントリーの可動棚の棚柱（東の壁）', who: '要相談' },
  { id: 'toilet2-paper', side: '西', what: 'トイレットペーパーホルダー', who: 'WH' },
  // 3 階
  { at: { fi: 2, room: '書斎（北東）', side: '南', wallAt: 4480, a0: 5520, a1: 8130, h0: 485, h1: 1810 }, what: '南の壁の貼り分けの所 全部（ふかし壁 FL+555〜1740・上下の木の板。ベース・ギターのハンガーもここに付ける）', who: '施主（ハンガー）' },
  { id: 'study-s-bag-hook', side: '南', what: 'リュックのフック', who: '施主' },
  { id: 'toilet3-paper', what: 'トイレットペーパーホルダー（HOLDIN air-to-14・ダブル）', who: '施主' },
];

/** 造作（棚・枕棚・パイプ・ベンチなど）: スクショ（notes/backing-images/）と、部材ごとの寸法・仕様 */
const BUILTINS = [
  {
    floor: '1 階', title: 'シューズクローク', img: 'bk-sic.jpg',
    rows: [
      ['南の棚', '樹脂棚板 D450（南海プライウッド アームハング棚柱SS・ダークグレー・エンドキャップ付き）。幅 1,700 を 2 分割（850 ずつ）・3 段（棚板の上面 FL+1250・1545・1840）'],
      ['棚下のハンガーパイプ', '南の棚の西半分、一番下の棚板の下に吊る（中心 FL+1140）。傘・フロアモップを掛ける。ランバーシリーズの上吊ハンガーパイプのような形（品番は未定）'],
      ['玄関側の棚', '樹脂棚板 D450・東の壁・幅 615・3 段（棚板の上面 FL+1250・1545・1840）。一番下の段の下にゴルフバッグ 2 つ'],
      ['靴の棚', '樹脂棚板 D300・西の壁・幅 930 の 1 枚の板。土間から天井近くまで 185 ごとに 12 段（一番下の棚板は土間から 185 上げて掃除しやすく）'],
      ['コート掛け', 'ハンガーパイプ（北西・南北に長さ 900・西の壁から 300・中心 FL+1700）'],
      ['枕棚', '西の壁・奥行 300・長さ 900・下面 FL+1800（パイプの中心から 100 上）'],
      ['吊り壁', '枕棚とパイプの南の端に天井から下げる（幅 400・厚さ 80・下端 FL+1600・枕棚と同じ色）'],
    ],
    note: '商品名（南海プライウッドなど）と吊り壁は仮。この形にできれば、作り方・商品は問わない。樹脂棚板の製品の奥行は 240・290 なので、D450 は実物と合わせて確認したい。',
  },
  {
    floor: '1 階', title: 'WIC', img: 'bk-wic1.jpg',
    rows: [
      ['仕切り板', '入口側（x 4950）・奥行 480・高さ 2,350（クローゼットの造作壁）'],
      ['可動棚 D270', '仕切り板にレール・幅 480・6 段（棚板の上面 FL+250・500・900・1500・1900、6 段目は上に棚板なし）'],
      ['枕棚', '北の壁: 奥行 350・仕切り板から東の壁まで（長さ 約 2,940）・FL+2050。東の壁: 奥行 350・長さ 895・FL+2050'],
      ['ハンガーパイプ', '上: 仕切り板から東の壁まで・中心 FL+1980。下: 東の壁まで・中心 FL+900。東: 北の壁から南の壁まで・中心 FL+1930（上のパイプと交わるので 50 下げる）'],
    ],
    note: '棚・枕棚・仕切り板の色はダークグレー。',
  },
  {
    floor: '1 階', title: '洗面脱衣室 洗濯機の横の造作棚', img: 'bk-washshelf.jpg', img2: 'bk-washshelf-open.jpg',
    rows: [
      ['大きさ', '幅 950・奥行 450・天井まで。浴室側（西）は縦の板なしで壁に付け、洗濯機側（東）だけ側板。棚・扉は黒'],
      ['東の側板', '床から天井まで。奥の下の角を幅 180・高さ 180 くらい切り欠き、洗濯機の排水ホース・S10 の給水ホース・電源コードを通す'],
      ['下の段（床〜FL+450）', '扉なし・底板なし（床がそのまま続く）。排水口と、その手前に S10 の水交換ステーション、浴室側の壁から離してゴミ収集ステーション'],
      ['洗濯かごの段（FL+470〜970）', '扉は 1 枚で上に跳ね上げて開く。90° で止まるステーを付け、開けたまま一時的に物を置けるようにしたい'],
      ['上の段', '洗濯かごの段の上の板（FL+970）・棚板（FL+1570・1970）。前は突っ張り式のロールスクリーンで隠す'],
    ],
    note: '下の段に置く SwitchBot S10 の水交換ステーション・ゴミ収集ステーションは施主が用意する。',
  },
  {
    floor: '1 階', title: '洗面脱衣室 洗面台の右の壁内収納', img: 'bk-wallstorage.jpg',
    rows: [
      ['大きさ', '東の壁に埋め込み・幅 500・奥行 160・高さ 2,050（北の壁から 150 離す、y 210〜710）。前面は壁の仕上げ面にそろえる'],
      ['下（ニッチ）', '薄型のゴミ箱を置くニッチ（奥と両側は TH34190）。カウンターの高さ（FL+850）に四角い投入口の棚'],
      ['上（収納）', '黒い扉の収納（両開き・ミラーと反対の側に吊る）。棚板 3 枚、一番下の段の真ん中に逆さのティッシュ（底板の穴から引き出す）'],
      ['扉', '鏡側（北）の扉は鏡に当たらないよう開き角度制限付きの丁番で 90°、反対側は 105°'],
      ['中のコンセント', '歯ブラシ除菌器を置く段の奥の壁（中心 FL+1420 くらい）'],
    ],
    note: '',
  },
  {
    floor: '1 階', title: '玄関のフロートベンチ', img: 'bk-bench.jpg',
    rows: [
      ['フロートベンチ', '東の壁沿い・長さ 約 1,150・奥行 450・厚さ 150（座面 FL+300）。ホールの床に立つ L 字の板の脚で、土間の上へ張り出す。ダークグレー'],
    ],
    note: '',
  },
  {
    floor: '2 階', title: 'パントリーの可動棚', img: 'bk-pantry.jpg',
    rows: [
      ['北の壁', '西の端からエアコンのコンセントの手前まで（幅 930）・奥行 450・棚柱 2 本・棚板 3 枚（上面 FL+700・1100・1500、2・3 枚目は仮）'],
      ['東の壁', '板を横に 2 枚（各 幅 約 740）・奥行 450・棚柱 4 本・棚板 4 枚（上面 FL+900・1250・1600・1950、2 枚目から上は仮）'],
    ],
    note: '棚板はすべて黒。誰が作るか（WH か施主か）は相談したい。',
  },
  {
    floor: '2 階', title: 'トイレ 便器の後ろのふかし壁の収納', img: 'bk-toilet2.jpg',
    rows: [
      ['大きさ', '便器の後ろ（北の壁）・幅 640・奥行 約 200・天井まで。前面はクロス TH34191'],
      ['中', '空洞で、東の 150 のすき間から出し入れ。棚板 3 枚（FL+600・1200・1800・奥行 180）'],
      ['照明・配線', '前の板の裏に縦の間接照明（東の端から 30 あける）。下に配線の穴'],
    ],
    note: '',
  },
  {
    floor: '2 階', title: '寝室の WIC', img: 'bk-wic2.jpg',
    rows: [
      ['北・南の壁', '枕棚（奥行 350・西の壁から東の壁まで 約 1,470・FL+1800）とハンガーパイプ（中心 FL+1700）'],
      ['奥（東）の壁', '枕棚（奥行 350・長さ 約 770・FL+1800）とハンガーパイプ（北の壁から南の壁まで・中心 FL+1650。北・南のパイプと交わるので 50 下げる）'],
    ],
    note: '',
  },
];

const SIDE = { 0: '北', 90: '東', 180: '南', 270: '西' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r10 = (v) => Math.round(v / 10) * 10;
const fl = (v) => (v < 0 ? `FL−${-r10(v)}` : `FL+${r10(v)}`);

function inPoly([x, y], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** 下地 1 か所の範囲: 壁の線・向き・壁に沿った範囲・高さ */
function backing(plan, b) {
  if (b.at) {
    const side = b.at.side;
    return { ...b, ...b.at, floor: plan.floors[b.at.fi].name, horiz: side === '北' || side === '南' };
  }
  for (const [fi, floor] of plan.floors.entries()) {
    const x = floor.furniture.find((f) => f.id === b.id);
    if (!x) continue;
    const rot = ((x.rotation ?? 0) % 360 + 360) % 360;
    const z = x.z ?? 0;
    const room = floor.rooms.find((r) => inPoly([x.x, x.y], r.polygon));
    // 背面の向き（壁のある側）: 0 → 北の壁、90 → 東、180 → 南、270 → 西。フック・箱は向きがないので side で書く
    const side = b.side ?? SIDE[rot] ?? '北';
    const horiz = side === '北' || side === '南';
    const back = { 北: [0, -1], 東: [1, 0], 南: [0, 1], 西: [-1, 0] }[side];
    const wallAt = horiz ? x.y + back[1] * (x.d / 2) : x.x + back[0] * (x.d / 2);
    const c = horiz ? x.x : x.y;
    let a0 = c - x.w / 2 - 100;
    let a1 = c + x.w / 2 + 100;
    // 床より下にはしない（土間は部屋の床の高さから）
    const h0 = Math.max(z - 100, room?.level ?? 0);
    const h1 = z + x.h + 100;
    // 部屋の中に収める（棚が部屋の角を越えないように）
    if (room) {
      const vs = room.polygon.map((p) => (horiz ? p[0] : p[1]));
      a0 = Math.max(a0, Math.min(...vs) + 60);
      a1 = Math.min(a1, Math.max(...vs) - 60);
    }
    return { ...b, fi, floor: floor.name, room: b.room ?? room?.name ?? '', side, horiz, wallAt, a0, a1, h0, h1 };
  }
  return null;
}

const rangeText = (e) => `${e.horiz ? 'x' : 'y'} ${r10(e.a0)}〜${r10(e.a1)}・${fl(e.h0)}〜${r10(e.h1)}`;

/** 階の平面図に下地の範囲を赤い線と番号で描く */
function planSvg(plan, fi, list) {
  const floor = plan.floors[fi];
  const pts = floor.rooms.flatMap((r) => r.polygon);
  const x0 = Math.min(...pts.map((p) => p[0])) - 500;
  const y0 = Math.min(...pts.map((p) => p[1])) - 500;
  const x1 = Math.max(...pts.map((p) => p[0])) + 500;
  const y1 = Math.max(...pts.map((p) => p[1])) + 500;
  const out = [`<svg class="plan" xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}">`];
  for (const r of floor.rooms) {
    if (r.void) continue;
    out.push(`<polygon points="${r.polygon.map((p) => p.join(',')).join(' ')}" fill="#fafafa" stroke="#888" stroke-width="20"/>`);
  }
  for (const r of floor.rooms) {
    if (r.void || r.noLabel || /天井/.test(r.name)) continue;
    const cx = r.polygon.reduce((s, p) => s + p[0], 0) / r.polygon.length;
    const cy = r.polygon.reduce((s, p) => s + p[1], 0) / r.polygon.length;
    out.push(`<text x="${cx}" y="${cy}" font-size="160" text-anchor="middle" dominant-baseline="central" fill="#888">${esc(r.name)}</text>`);
  }
  const placed = [];
  for (const e of list) {
    const [ax, ay, bx, by] = e.horiz ? [e.a0, e.wallAt, e.a1, e.wallAt] : [e.wallAt, e.a0, e.wallAt, e.a1];
    out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#d62728" stroke-width="90"/>`);
    // 番号は壁から部屋の内側へ。近くの番号と重なるときは壁に沿ってずらす
    const dir = { 北: [0, 1], 南: [0, -1], 東: [-1, 0], 西: [1, 0] }[e.side] ?? [0, 1];
    let tx = (ax + bx) / 2 + dir[0] * 330;
    let ty = (ay + by) / 2 + dir[1] * 330;
    while (placed.some(([px, py]) => Math.hypot(px - tx, py - ty) < 320)) {
      if (e.horiz) tx += 330;
      else ty += 330;
    }
    placed.push([tx, ty]);
    out.push(`<circle cx="${tx}" cy="${ty}" r="150" fill="#fff" stroke="#d62728" stroke-width="22"/><text x="${tx}" y="${ty}" font-size="170" text-anchor="middle" dominant-baseline="central" fill="#d62728" font-weight="bold">${e.no}</text>`);
  }
  out.push('</svg>');
  return out.join('');
}

const plan = JSON.parse(readFileSync('plans/my-house.json', 'utf8'));
const date = new Date().toLocaleDateString('sv-SE');
const list = BACKING.map((b) => backing(plan, b)).filter(Boolean);
list.sort((p, q) => p.fi - q.fi);
list.forEach((e, i) => (e.no = i + 1));
const missing = BACKING.filter((b) => b.id && !list.some((e) => e.id === b.id)).map((b) => b.id);
if (missing.length) console.warn('見つからない家具:', missing.join(', '));

const backingHtml = plan.floors
  .map((floor, fi) => {
    const here = list.filter((e) => e.fi === fi);
    if (!here.length) return '';
    const rows = here.map((e) => `<tr><td class="n"><b>${e.no}</b></td><td>${esc(e.room)}</td><td>${esc(`${e.side}の壁`)}</td><td>${esc(e.what)}</td><td>${esc(rangeText(e))}</td><td>${esc(e.who)}</td></tr>`).join('');
    return `<h3>${esc(floor.name)}</h3>${planSvg(plan, fi, here)}<div class="tbl"><table><thead><tr><th class="n">番号</th><th>部屋</th><th>面</th><th>付ける物</th><th>下地の範囲（mm）</th><th>付ける人</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  })
  .join('');

const builtinHtml = BUILTINS.map(
  (b) => `<div class="bi"><div class="pics">${[b.img, b.img2].filter(Boolean).map((i) => `<img src="backing-images/${i}" alt="${esc(b.title)}" loading="lazy">`).join('')}</div><div class="bt"><h3>${esc(b.floor)}　${esc(b.title)}</h3><div class="tbl"><table><tbody>${b.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div>${b.note ? `<p class="note">${esc(b.note)}</p>` : ''}</div></div>`,
).join('');

// 色はトークン（ダークモードでも読めるように）。図は白い紙のまま
const dark = '--bg:#17191b;--fg:#e6e8ea;--muted:#a3a9ae;--line:#3a3f44;--panel:#212427;color-scheme:dark';
const css = `:root{--bg:#fbfbfa;--fg:#1f2326;--muted:#5d646a;--line:#d5d8db;--panel:#f1f2f3}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}
:root[data-theme="dark"]{${dark}}
body{font-family:'Yu Gothic','Meiryo','Hiragino Sans','Noto Sans JP',sans-serif;color:var(--fg);font-size:13.5px;background:var(--bg);line-height:1.65}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:21px;margin:0 0 4px;text-wrap:balance}h2{font-size:17px;margin:32px 0 8px;border-bottom:2px solid var(--fg);padding-bottom:4px}h3{font-size:15px;margin:20px 0 8px}
.note{color:var(--muted);font-size:12.5px}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:6px 0 12px;font-variant-numeric:tabular-nums}th,td{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}th{background:var(--panel)}td.n,th.n{text-align:right;white-space:nowrap}
svg.plan{width:100%;max-width:900px;height:auto;display:block;margin:6px 0;background:#fff;border-radius:4px}
.bi{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:14px;align-items:start;border-top:1px solid var(--line);padding:14px 0}.pics{display:grid;gap:8px}.bi img{display:block;width:100%;height:auto;border-radius:6px}.bi h3{margin:0 0 6px}.bi th{width:9em;white-space:nowrap}
.noimg{border:1px dashed var(--line);border-radius:6px;padding:40px 10px;text-align:center;color:var(--muted);font-size:12.5px}
@media (max-width:700px){.bi{grid-template-columns:1fr}}
@media print{body{margin:10mm}h3{break-before:page}}`;
const body = `<h1>${esc(plan.name)}　壁の下地と造作</h1>
<p class="note">${date} 時点の 3D シミュレーターから作成。ワンダーハウスさんへの説明用。寸法は mm、FL は各階の床から、x は西の外壁の芯から東へ、y は北の外壁の芯から南へ（施工図の通り芯 い〜・1〜 の 910 の倍数）。クロスの貼り分けは別紙「クロス貼り分け表」。</p>
<h2>壁の下地（補強）を入れてほしい所</h2>
<p class="note">あとで物を付けるので、石膏ボードの裏に合板などの下地を入れてほしい所。範囲は付ける物の大きさに上下左右 100 ずつ足した目安（棚は棚柱が付く範囲）。図の赤い線が下地の範囲、番号は表の番号。自分で付けるかもしれない造作棚の場所はまだ決まっていない。</p>
${backingHtml}
<h2>造作（棚・枕棚・ハンガーパイプ・ベンチなど）</h2>
<p class="note">3D シミュレーターの画面（服や小物は消して撮った。シューズクロークは壁を低く切って上から、パントリーは手前の壁を消して、トイレの収納は前の板を半透明にして中が見えるようにした）。寸法は今の 3D の値。高さは各階の床から。</p>
${builtinHtml}`;
mkdirSync('dist-docs', { recursive: true });
writeFileSync('notes/下地資料.html', `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>壁の下地と造作</title><style>${css}body{margin:24px}</style></head><body>${body}</body></html>\n`);
writeFileSync('dist-docs/backing.html', `<title>壁の下地と造作</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>${css}body{margin:0;padding-block:20px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}</style><div class="wrap">${body}</div>\n`);
console.log('notes/下地資料.html', list.length);
