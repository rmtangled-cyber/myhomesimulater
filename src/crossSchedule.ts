// 「クロス表」: 今の 3D に貼ってあるクロス（壁・天井）を面ごとに集計し、貼り分け表と金額の目安を HTML にする。
// 面の大きさは作った 3D の面（開口部を抜いた後）から測るので、図面の寸法と同じ。
// 金額は施工会社のルール: SP で始まる品番は何面でも無料、それ以外のクロスは 8 面まで無料・9 面目から 1 面 3,000 円。
// クロスでない仕上げ（AICA セラールなど）は別に、板の枚数と設計価格を出す

import * as THREE from 'three';
import type { BuiltPlan } from './builder';
import { getMaterialDef } from './materials';
import { centroid, pointInPolygon } from './geometry';
import type { Plan, Point, Side } from './types';

const SIDE_NAME: Record<Side, string> = { north: '北', east: '東', south: '南', west: '西' };
const TSUURI_X = ['い', 'ろ', 'は', 'に', 'ほ', 'へ', 'と', 'ち', 'り', 'ぬ', 'る'];
/** 1 面に数えない小さな面（m²）。開口の上の細い壁など */
const MIN_FACE = 0.3;
const FREE_FACES = 8;
const FACE_PRICE = 3000;
/** クロスでない仕上げの板（品番の素材 ID → 板の大きさ mm と設計価格） */
const PANELS: Record<string, { w: number; h: number; price: number; name: string }> = {
  'aica-fj901zd': { w: 935, h: 2455, price: 29100, name: 'AICA セラール FJGA901ZD（935×2455・3mm）' },
};

interface Face {
  /** 面のキー（間取りの crossSchedule.merges で使う） */
  key: string;
  floor: number;
  room: string;
  roomName: string;
  kind: 'wall' | 'ceiling';
  side?: Side;
  zone?: string;
  material: string;
  area: number;
  /** 面の範囲（mm・間取りの座標） */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** 表の 1 行（1 面として数える物）。部屋をまとめた所や、指定で 1 面にした面は parts が複数 */
interface Entry {
  parts: Face[];
  seq: number;
  floor: number;
  area: number;
  materials: string[];
  /** SP 以外のクロスの面として数える順番（1〜） */
  no?: number;
}

/** 区分: SP（無料）・品番のない標準の色（白など・無料）・有料の対象のクロス・クロス以外 */
function category(id: string): 'sp' | 'std' | 'cross' | 'other' {
  if (id.startsWith('cross-sp')) return 'sp';
  if (/^cross-[a-z]{2}\d/.test(id)) return 'cross';
  if (id.startsWith('cross-')) return 'std';
  return 'other';
}

const yen = (v: number) => `${v.toLocaleString('ja-JP')} 円`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const matName = (id: string) => getMaterialDef(id)?.name ?? id;

/** 3D の面を集めて、部屋・壁の辺・ゾーン・素材ごとにまとめる */
function collect(plan: Plan, built: BuiltPlan): Face[] {
  built.root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(built.root.matrixWorld).invert();
  const faces = new Map<string, Face>();
  // 面を座標で分ける指定（merges の「キー@x<6430」）
  const splits = new Map<string, { axis: 'x' | 'y'; at: number }>();
  for (const k of (plan.crossSchedule?.merges ?? []).flat()) {
    const mm = k.match(/^(.*)@([xy])[<>](-?[\d.]+)$/);
    if (mm) splits.set(mm[1], { axis: mm[2] as 'x' | 'y', at: Number(mm[3]) });
  }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  built.floors.forEach((bf, fi) => {
    const floor = plan.floors[fi];
    bf.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const info = mesh.userData.info;
      if (!mesh.isMesh || !info || (info.kind !== 'wall' && info.kind !== 'ceiling')) return;
      const m = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      const n = idx ? idx.count : pos.count;
      const area = 1;
      if (area <= 0) return;
      const base = info.kind === 'wall' ? `${fi}|${info.roomId}|w${info.edge}|${info.zone ?? ''}|${info.materialId}` : `${fi}|${info.roomId}|c|${info.materialId}`;
      const room = floor.rooms.find((r) => r.id === info.roomId);
      if (room?.noCross) return;
      const elev = floor.elevation ?? 0;
      const split = splits.get(base);
      for (let i = 0; i < n; i += 3) {
        const [i0, i1, i2] = idx ? [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)] : [i, i + 1, i + 2];
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        const ta = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
        if (ta <= 0) continue;
        // 面を座標で分ける指定（「@x<6430」）があれば、三角形の重心で振り分ける
        let key = base;
        if (split) {
          const v = split.axis === 'x' ? (a.x + b.x + c.x) / 3 : (a.z + b.z + c.z) / 3;
          key = `${base}@${split.axis}${v < split.at ? '<' : '>'}${split.at}`;
        }
        const f = faces.get(key);
        const lo = new THREE.Vector3().copy(a).min(b).min(c);
        const hi = new THREE.Vector3().copy(a).max(b).max(c);
        if (f) {
          f.area += ta / 1e6;
          f.x0 = Math.min(f.x0, lo.x);
          f.x1 = Math.max(f.x1, hi.x);
          f.y0 = Math.min(f.y0, lo.z);
          f.y1 = Math.max(f.y1, hi.z);
          f.z0 = Math.min(f.z0, lo.y - elev);
          f.z1 = Math.max(f.z1, hi.y - elev);
          continue;
        }
        faces.set(key, {
          key,
          floor: fi,
          room: info.roomId,
          roomName: room?.name ?? info.roomId,
          kind: info.kind,
          side: info.kind === 'wall' ? info.side : undefined,
          zone: info.kind === 'wall' ? info.zone : undefined,
          material: info.materialId,
          area: ta / 1e6,
          x0: lo.x,
          x1: hi.x,
          y0: lo.z,
          y1: hi.z,
          z0: lo.y - elev,
          z1: hi.y - elev,
        });
      }
    });
  });
  // 造作の面: 板を貼った物（洗面脱衣室の小物置きの奥など）と、クロスを貼った箱（ふかし壁・吊り壁・下がり天井の板など）。
  // 面積は一番大きい面（正面の幅 × 高さ、天井の板なら幅 × 奥行）。床の厚みの面や木の板は入れない
  plan.floors.forEach((floor, fi) => {
    for (const x of floor.furniture) {
      if (!x.material) continue;
      const isPanel = !!PANELS[x.material];
      const isCross = x.type === 'box' && x.material.startsWith('cross-') && !/木の板|床の端/.test(x.name);
      if (!isPanel && !isCross) continue;
      const room = floor.rooms.find((r) => pointInPolygon([x.x, x.y], r.polygon));
      if (room?.noCross) continue;
      const a = (x.rotation * Math.PI) / 180;
      const ux = Math.abs(Math.cos(a)) * x.w;
      const uy = Math.abs(Math.sin(a)) * x.w;
      const flat = x.w * x.d > x.w * x.h;
      const key = `${fi}|f|${x.id}`;
      faces.set(key, {
        key, floor: fi, room: '', roomName: `${room?.name ?? ''}・${x.name.replace(/（.*$/, '')}`, kind: 'wall', material: x.material, area: (flat ? x.w * x.d : x.w * x.h) / 1e6,
        x0: x.x - ux / 2, x1: x.x + ux / 2, y0: x.y - uy / 2, y1: x.y + uy / 2, z0: x.z ?? 0, z1: (x.z ?? 0) + x.h,
      });
    }
  });
  return [...faces.values()].filter((f) => f.area >= 0.05);
}

/** 通り芯の名前（910 ごと。い〜・1〜）。通り芯の上でなければ「い＋455」のように */
function tsuuri(plan: Plan, v: number, axis: 'x' | 'y', maxY: number): string {
  const g = plan.grid;
  const k = axis === 'x' ? v / g : (maxY - v) / g;
  const i = Math.floor(k + 0.02);
  const rest = Math.round((k - i) * g);
  const name = axis === 'x' ? (TSUURI_X[i] ?? `${i}`) : String(i + 1);
  return rest < 20 ? name : `${name}+${rest}`;
}

function range(plan: Plan, f: Face, maxY: number): string {
  const dx = f.x1 - f.x0;
  const dy = f.y1 - f.y0;
  if (f.kind === 'ceiling') return '部屋全体';
  const h = `高さ ${Math.round(f.z0)}〜${Math.round(f.z1)}`;
  if (dx >= dy) return `${tsuuri(plan, f.x0, 'x', maxY)}〜${tsuuri(plan, f.x1, 'x', maxY)} 通り（${Math.round(dx).toLocaleString()}）・${h}`;
  return `${tsuuri(plan, f.y1, 'y', maxY)}〜${tsuuri(plan, f.y0, 'y', maxY)} 通り（${Math.round(dy).toLocaleString()}）・${h}`;
}

/** 素材ごとの色（図の線の色） */
const PALETTE = ['#e15759', '#4e79a7', '#59a14f', '#f28e2b', '#b07aa1', '#76b7b2', '#edc948', '#9c755f', '#ff9da7', '#2f4b7c', '#a05195', '#665191', '#d45087', '#003f5c', '#7a5195'];

/** 面をまとめて表の行にする: 部屋のまとめ（roomGroups）と、1 面として数える指定（merges） */
function group(plan: Plan, faces: Face[]): Entry[] {
  const parent = new Map<string, string>(faces.map((f) => [f.key, f.key]));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    parent.set(find(a), find(b));
  };
  const cfg = plan.crossSchedule ?? {};
  const groupOf = new Map<string, string>();
  for (const g of cfg.roomGroups ?? []) for (const r of g.rooms) groupOf.set(r, g.name);
  // 部屋のまとめ: 同じ向きの壁・天井で、品番が同じものを 1 面に
  const byGroup = new Map<string, string>();
  for (const f of faces) {
    const g = groupOf.get(f.room);
    if (!g) continue;
    const k = `${f.floor}|${g}|${f.kind}|${f.side ?? ''}|${f.zone ?? ''}|${f.material}`;
    const first = byGroup.get(k);
    if (first) union(f.key, first);
    else byGroup.set(k, f.key);
  }
  // 1 面として数える指定。最初のキーのない組（面がなくなった時など）でもほかの面どうしはまとめる
  for (const list of cfg.merges ?? []) {
    const have = list.filter((k) => parent.has(k));
    for (let i = 1; i < have.length; i++) union(have[0], have[i]);
  }
  const entries = new Map<string, Face[]>();
  for (const f of faces) {
    const r = find(f.key);
    entries.set(r, [...(entries.get(r) ?? []), f]);
  }
  return [...entries.values()].map((parts) => {
    parts.sort((p, q) => p.floor - q.floor || p.z0 - q.z0);
    return {
      parts,
      seq: 0,
      floor: Math.min(...parts.map((f) => f.floor)),
      area: parts.reduce((s, f) => s + f.area, 0),
      materials: [...new Set(parts.map((f) => f.material))],
    };
  });
}

export function crossScheduleHtml(plan: Plan, built: BuiltPlan, date: string): string {
  const faces = collect(plan, built);
  const entries = group(plan, faces);
  const maxY = Math.max(...plan.floors.flatMap((fl) => fl.rooms.flatMap((r) => r.polygon.map((p) => p[1]))));
  const materials = [...new Set(faces.map((f) => f.material))].sort((p, q) => category(p).localeCompare(category(q)) || p.localeCompare(q));
  const color = new Map(materials.map((m, i) => [m, PALETTE[i % PALETTE.length]]));
  const groupOf = new Map<string, string>();
  for (const g of plan.crossSchedule?.roomGroups ?? []) for (const r of g.rooms) groupOf.set(r, g.name);
  // 造作の面（部屋の id がない）の名前は「部屋・造作の名前」
  const roomLabel = (f: Face) => groupOf.get(f.room) ?? (f.room ? f.roomName : f.roomName.split('・')[0]);
  const whereOf = (f: Face) => (f.kind === 'ceiling' ? '天井' : f.side ? `${SIDE_NAME[f.side]}の壁${f.zone ? '（一部）' : ''}` : `造作（${f.roomName.split('・').slice(1).join('・')}）`);

  // 通し番号: 階ごとに、部屋の名前・北東南西の壁・天井の順。階をまたぐ面は一番下の階で数える
  const SIDE_ORDER: Side[] = ['north', 'east', 'south', 'west'];
  const first = (e: Entry) => e.parts.find((f) => f.floor === e.floor)!;
  entries.sort((p, q) => {
    const a = first(p);
    const b = first(q);
    return p.floor - q.floor || roomLabel(a).localeCompare(roomLabel(b), 'ja') || (a.kind === b.kind ? SIDE_ORDER.indexOf(a.side!) - SIDE_ORDER.indexOf(b.side!) || a.z0 - b.z0 : a.kind === 'wall' ? -1 : 1);
  });
  entries.forEach((e, i) => (e.seq = i + 1));
  // SP 以外のクロスの面（1 面の大きさ以上）を数える
  const counted = entries.filter((e) => e.materials.some((m) => category(m) === 'cross') && e.area >= MIN_FACE);
  counted.forEach((e, i) => (e.no = i + 1));
  const paidFaces = Math.max(0, counted.length - FREE_FACES);
  const crossCost = paidFaces * FACE_PRICE;
  // クロスでない仕上げの板
  const panelRows = faces
    .filter((f) => PANELS[f.material])
    .map((f) => {
      const p = PANELS[f.material];
      const width = Math.max(f.x1 - f.x0, f.y1 - f.y0);
      const height = f.z1 - f.z0;
      // 縦に使うか横に使うか、少ない方（細い帯なら板を横にして切り出す）
      const boards = Math.min(Math.ceil(width / p.w - 0.02) * Math.ceil(height / p.h - 0.02), Math.ceil(width / p.h - 0.02) * Math.ceil(height / p.w - 0.02));
      return { f, p, width, height, boards, cost: boards * p.price };
    });
  const panelCost = panelRows.reduce((s, r) => s + r.cost, 0);

  const tag = (id: string) => {
    const c = category(id);
    if (c === 'std') return '<span class="t sp">標準・無料</span>';
    return c === 'sp' ? '<span class="t sp">SP・無料</span>' : c === 'cross' ? '<span class="t cr">8 面まで無料</span>' : '<span class="t ot">クロス以外</span>';
  };
  const sw = (id: string) => `<i class="sw" style="background:${color.get(id)}"></i>`;
  const paid = (e: Entry) => !!e.no && e.no > FREE_FACES;

  const floorsHtml = plan.floors
    .map((floor, fi) => {
      const list = entries.filter((e) => e.floor === fi);
      const here = entries.filter((e) => e.parts.some((f) => f.floor === fi));
      if (!here.length) return '';
      const rows = list
        .map((e) => {
          const multiFloor = new Set(e.parts.map((f) => f.floor)).size > 1;
          const fl = (f: Face) => (multiFloor ? `${plan.floors[f.floor].name} ` : '');
          const rooms = [...new Set(e.parts.map((f) => fl(f) + roomLabel(f)))].join('・');
          const wheres = [...new Set(e.parts.map(whereOf))].join('・');
          const many = new Set(e.parts.map(roomLabel)).size > 1;
          const ranges = e.parts.map((f) => `${fl(f)}${many ? `${esc(roomLabel(f))}: ` : ''}${range(plan, f, maxY)}`).join('<br>');
          const mats = e.materials.map((m) => `${sw(m)}${esc(matName(m))}`).join('<br>');
          const tags = [...new Set(e.materials.map(tag))].join(' ');
          return `<tr data-key="${esc(e.parts.map((f) => f.key).join(' '))}"><td class="n"><b class="${paid(e) ? 'paid' : ''}">${e.seq}</b></td><td>${esc(rooms)}</td><td>${wheres}</td><td class="rg">${ranges}</td><td>${mats}</td><td class="n">${e.area.toFixed(1)}</td><td>${tags}${paid(e) ? ' <b class="paid">有料の対象</b>' : ''}</td></tr>`;
        })
        .join('');
      const note = here.length > list.length ? `<p class="note">ほかの階で数えた面（階をまたぐ階段の壁など）も、この階の図に同じ番号で描いている。</p>` : '';
      return `<h2>${esc(floor.name)}</h2>${planSvg(plan, fi, here, color, paid)}${note}<table><thead><tr><th class="n">番号</th><th>部屋</th><th>面</th><th>範囲（通り芯・mm）</th><th>品番</th><th class="n">面積 m²</th><th>区分</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join('');

  const totals = materials
    .map((m) => {
      const es = entries.filter((e) => e.materials.includes(m));
      const area = faces.filter((f) => f.material === m).reduce((s, f) => s + f.area, 0);
      return `<tr><td>${sw(m)}${esc(matName(m))}</td><td>${tag(m)}</td><td class="n">${es.filter((e) => e.area >= MIN_FACE).length}</td><td class="n">${area.toFixed(1)}</td></tr>`;
    })
    .join('');

  const panelHtml = panelRows.length
    ? `<h3>クロス以外の仕上げ（板）</h3><table><thead><tr><th>場所</th><th>品番</th><th class="n">幅×高さ mm</th><th class="n">枚数</th><th class="n">設計価格</th></tr></thead><tbody>${panelRows
        .map((r) => `<tr><td>${esc(plan.floors[r.f.floor].name)} ${esc(r.f.roomName)}${r.f.side ? `・${SIDE_NAME[r.f.side]}の壁` : ''}</td><td>${esc(r.p.name)}</td><td class="n">${Math.round(r.width).toLocaleString()}×${Math.round(r.height).toLocaleString()}</td><td class="n">${r.boards}</td><td class="n">${yen(r.cost)}</td></tr>`)
        .join('')}</tbody></table><p class="note">板の枚数は幅と高さを板の大きさで割って切り上げた数（目地・端の割り付けで変わる）。設計価格は定価で、実際の金額・施工費は施工会社に確認。見積もりに入っているかも確認。</p>`
    : '';

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(plan.name)} クロス貼り分け表</title>
<style>
body{font-family:'Yu Gothic','Meiryo','Hiragino Sans','Noto Sans JP',sans-serif;color:#222;margin:24px;font-size:13px;background:#fff}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:2px solid #333;padding-bottom:4px}h3{font-size:14px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;margin:6px 0 10px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f2f2f2;font-weight:600}
td.n,th.n{text-align:right;white-space:nowrap}td.rg{font-size:12px;color:#444}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.t{font-size:11px;padding:1px 6px;border-radius:8px;white-space:nowrap}.t.sp{background:#e3f4e1;color:#2c6b27}.t.cr{background:#fde8d4;color:#9a4a00}.t.ot{background:#e6eef8;color:#1f4f86}
.paid{color:#c0392b}.sum{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.card{border:1px solid #ddd;border-radius:8px;padding:10px 14px;min-width:180px}.card b{display:block;font-size:20px;margin-top:2px}
.note{color:#666;font-size:12px}svg.plan{width:100%;max-width:1000px;height:auto;display:block;margin:4px 0}
@media print{body{margin:10mm}h2{break-before:page}}
</style></head><body>
<h1>${esc(plan.name)}　クロス貼り分け表</h1>
<p class="note">${date} 時点の 3D の仕上げから作成。面積は開口部を抜いた実面積（m²）。通り芯は施工会社の図面と同じ（い〜る は西から、1〜9 は南から 910 ごと）。範囲の「い+455」は い通りから東へ 455、「3+455」は 3 通りから北へ 455 の所。高さは各階の床から（1 階の土間は −150 から）。</p>
<div class="sum">
<div class="card">SP 以外のクロスの面<b>${counted.length} 面</b><span class="note">8 面まで無料</span></div>
<div class="card">クロスの追加料金（目安）<b>${yen(crossCost)}</b><span class="note">${paidFaces} 面 × ${yen(FACE_PRICE)}</span></div>
${panelRows.length ? `<div class="card">クロス以外の板（設計価格）<b>${yen(panelCost)}</b><span class="note">${panelRows.reduce((s, r) => s + r.boards, 0)} 枚</span></div>` : ''}
<div class="card">合計（目安）<b>${yen(crossCost + panelCost)}</b><span class="note">施工費・税は含まない</span></div>
</div>
<p class="note">表の左の番号は、図の丸い番号と同じ面。同じ壁を品番で貼り分けている所は、線と番号を並べて描いた。<b class="paid">赤い番号・「有料の対象」</b>は、SP 以外のクロスの面を数えて 9 面目から（1 面 3,000 円）。どの面から有料になるかは数える順番で変わるので、目安。</p>
<p class="note">浴室（TOTO のセット見積もり）・PS（クロスなし）・ポーチ（外装）・車庫は入れていない。</p>
<p class="note">面の数え方: 部屋の壁 1 面（部屋の角から角まで・同じ品番）と天井 1 面をそれぞれ 1 面とし、ひと続きの壁（階段の吹き抜けの壁など）は 1 面にまとめた。${MIN_FACE} m² 未満の小さな面は数えていない。</p>
<h3>品番ごとの合計</h3><table><thead><tr><th>品番</th><th>区分</th><th class="n">面数</th><th class="n">面積 m²</th></tr></thead><tbody>${totals}</tbody></table>
${panelHtml}
${floorsHtml}
</body></html>`;
}

/** 階の平面図に、壁の面を品番の色の線で描き、丸い番号を付ける */
function planSvg(plan: Plan, fi: number, list: Entry[], color: Map<string, string>, paid: (e: Entry) => boolean): string {
  const floor = plan.floors[fi];
  const pts = floor.rooms.flatMap((r) => r.polygon);
  const x0 = Math.min(...pts.map((p) => p[0])) - 400;
  const y0 = Math.min(...pts.map((p) => p[1])) - 400;
  const x1 = Math.max(...pts.map((p) => p[0])) + 400;
  const y1 = Math.max(...pts.map((p) => p[1])) + 400;
  const out: string[] = [`<svg class="plan" xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}">`];
  for (const r of floor.rooms) {
    if (r.void) continue;
    out.push(`<polygon points="${r.polygon.map((p) => p.join(',')).join(' ')}" fill="#fafafa" stroke="#999" stroke-width="20"/>`);
  }
  // この階の壁の面。番号は 1 つの行（Entry）につき、この階の一番大きい面に 1 つ
  type W = { e: Entry; f: Face; a: Point; b: Point; d: Point; horiz: boolean; label: boolean };
  const walls: W[] = [];
  for (const e of list) {
    const ws = e.parts.filter((f) => f.floor === fi && f.kind === 'wall');
    const big = ws.reduce<Face | null>((m, f) => (!m || f.area > m.area ? f : m), null);
    for (const f of ws) {
      const horiz = f.x1 - f.x0 >= f.y1 - f.y0;
      const a: Point = horiz ? [f.x0, (f.y0 + f.y1) / 2] : [(f.x0 + f.x1) / 2, f.y0];
      const b: Point = horiz ? [f.x1, (f.y0 + f.y1) / 2] : [(f.x0 + f.x1) / 2, f.y1];
      // 部屋の内側へずらす（造作の面は、その面のある部屋の内側へ）
      const room = floor.rooms.find((r) => r.id === f.room) ?? floor.rooms.find((r) => pointInPolygon([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 100], r.polygon) || pointInPolygon([(a[0] + b[0]) / 2 + 100, (a[1] + b[1]) / 2], r.polygon));
      const [cx, cy] = room ? centroid(room.polygon) : [0, 0];
      const d: Point = horiz ? [0, Math.sign(cy - a[1]) || 1] : [Math.sign(cx - a[0]) || 1, 0];
      walls.push({ e, f, a, b, d, horiz, label: f === big });
    }
  }
  // 同じ壁の線に重なる面（品番の貼り分けなど）は、線を内側へずらして並べ、番号も壁に沿って並べる
  const groups: W[][] = [];
  for (const w of walls) {
    const line = w.horiz ? w.a[1] : w.a[0];
    const g = groups.find((g) => {
      const o = g[0];
      if (o.horiz !== w.horiz || o.d[0] + o.d[1] !== w.d[0] + w.d[1]) return false;
      if (Math.abs((o.horiz ? o.a[1] : o.a[0]) - line) > 40) return false;
      const [p0, p1] = o.horiz ? [o.a[0], o.b[0]] : [o.a[1], o.b[1]];
      const [q0, q1] = w.horiz ? [w.a[0], w.b[0]] : [w.a[1], w.b[1]];
      return Math.min(p1, q1) - Math.max(p0, q0) > Math.min(p1 - p0, q1 - q0) * 0.5;
    });
    if (g) g.push(w);
    else groups.push([w]);
  }
  const lane = new Map<W, { k: number; n: number }>();
  for (const g of groups) g.forEach((w, k) => lane.set(w, { k, n: g.length }));
  for (const w of walls) {
    const { k, n } = lane.get(w)!;
    const off = 70 + k * 85;
    out.push(`<line x1="${w.a[0] + w.d[0] * off}" y1="${w.a[1] + w.d[1] * off}" x2="${w.b[0] + w.d[0] * off}" y2="${w.b[1] + w.d[1] * off}" stroke="${color.get(w.f.material)}" stroke-width="70" stroke-linecap="butt"/>`);
    if (!w.label) continue;
    const along = n > 1 ? (k + 1) / (n + 1) : w.f.room ? 0.5 : 0.25;
    const inner = 70 + (n - 1) * 85 + 230;
    const tx = w.a[0] + (w.b[0] - w.a[0]) * along + w.d[0] * inner;
    const ty = w.a[1] + (w.b[1] - w.a[1]) * along + w.d[1] * inner;
    out.push(`<circle cx="${tx}" cy="${ty}" r="120" fill="#fff" stroke="${color.get(w.f.material)}" stroke-width="18"/><text x="${tx}" y="${ty}" font-size="130" text-anchor="middle" dominant-baseline="central" fill="${paid(w.e) ? '#c0392b' : '#333'}" font-weight="bold">${w.e.seq}</text>`);
  }
  for (const r of floor.rooms) {
    if (r.void || r.noLabel) continue;
    const [cx, cy] = centroid(r.polygon);
    const ceil = list.find((e) => e.parts.some((f) => f.kind === 'ceiling' && f.room === r.id && f.floor === fi));
    out.push(`<text x="${cx}" y="${cy}" font-size="170" text-anchor="middle" dominant-baseline="central" fill="#555">${esc(r.name)}</text>`);
    if (ceil) {
      const f = ceil.parts.find((f) => f.kind === 'ceiling' && f.room === r.id)!;
      out.push(`<rect x="${cx - 120}" y="${cy + 140}" width="240" height="120" fill="${color.get(f.material)}"/><text x="${cx}" y="${cy + 380}" font-size="130" text-anchor="middle" fill="${paid(ceil) ? '#c0392b' : '#555'}" font-weight="bold">天井 ${ceil.seq}</text>`);
    }
  }
  out.push('</svg>');
  return out.join('');
}
