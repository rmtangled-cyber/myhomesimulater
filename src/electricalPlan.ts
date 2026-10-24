// 「電気図出力」: 今の間取りデータから、各階の電灯コンセント図を SVG で作る。
// 施工会社（ワンダーハウス）の「電灯コンセント図」（R8.09.21・A3 横・1/60）の書き方に合わせる:
// 通り芯（い〜る・1〜9）と寸法、照明は水色の丸（ダウンライトは二重丸・シーリングは CL）、コンセントは緑の丸に縦線、
// エアコン用は赤い丸に AC/E、テレビは赤い四角に TV、スイッチは赤い点（3 路は 3）、スイッチと照明を赤い線で結ぶ。
// 右に凡例と標準取付高さ表、下に表題欄。施工会社の標準から動かした物・増やした物・変えた物には印を付ける。
// 施主の名前・住所や施工会社のロゴは入れない。DOM を使わない（Node のスクリプトからも呼べる）

import { deriveWalls, dist, openingsOnSegment, signedArea, centroid, pointInPolygon } from './geometry';
import type { Floor, Furniture, Plan, Point } from './types';

/** 図面の縮尺（1/60）。紙の上の長さは mm */
const SCALE = 60;
/** 紙（A3 横） */
const PAPER_W = 420;
const PAPER_H = 297;
/** 建物の原点（x 0・y 0）を置く紙の位置 */
const OX = 72;
const OY = 72;

const RED = '#d4242b';
const GREEN = '#33b34a';
const CYAN = '#7fd0e6';
const PINK = '#f28aa6';
const BLUE = '#1f5fbf';
const ORANGE = '#e07000';
const FONT = "'Yu Gothic','Meiryo','Hiragino Sans','Noto Sans JP',sans-serif";

const DOWNLIGHTS = new Set(['downlight']);
const CEILING = new Set(['ceiling-light']);
const BRACKETS = new Set(['wall-light', 'down-bracket', 'aj-wall-lamp']);
const FOOTLIGHTS = new Set(['foot-light']);
const PENDANTS = new Set(['star-pendant', 'pendant-light']);
const LINES = new Set(['line-light', 'halo-light']);
const RAILS = new Set(['lighting-rail']);
const OUTLETS = new Set(['outlet']);
const FLOOR_OUTLETS = new Set(['floor-outlet']);
const SWITCHES = new Set(['switch']);
const PANELS = new Set(['remote-panel', 'intercom', 'breaker-panel', 'wifi-router', 'onu', 'fiber-outlet', 'lan-outlet']);
const ELECTRIC = new Set([...DOWNLIGHTS, ...CEILING, ...BRACKETS, ...FOOTLIGHTS, ...PENDANTS, ...LINES, ...RAILS, ...OUTLETS, ...FLOOR_OUTLETS, ...SWITCHES, ...PANELS]);
/** 家具の外形を薄く描かない物（道路まわり・戸・小物） */
const SKIP_OUTLINE = new Set(['road', 'sidewalk', 'crosswalk', 'utility-pole', 'swing-door', 'sliding-door', 'mirror-sliding-door', 'mirror-sheet-door', 'framed-glass-door', 'entry-door', 'bifold-door', 'roll-screen', 'vertical-blind', 'rod-screen', 'fire-roll-screen']);

const TSUURI_X = ['い', 'ろ', 'は', 'に', 'ほ', 'へ', 'と', 'ち', 'り', 'ぬ', 'る'];

export interface ElectricalOptions {
  /** 表題欄の日付（例 2026-10-25） */
  date: string;
}

/** 紙の上の位置（mm） */
const P = (x: number, y: number): Point => [OX + x / SCALE, OY + y / SCALE];
const n2 = (v: number) => v.toFixed(2);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function text(x: number, y: number, s: string, size: number, color = '#222', anchor: 'start' | 'middle' | 'end' = 'middle', extra = '') {
  return `<text x="${n2(x)}" y="${n2(y)}" font-size="${size}" fill="${color}" text-anchor="${anchor}" dominant-baseline="central" font-family="${FONT}" ${extra}>${esc(s)}</text>`;
}
const circle = (x: number, y: number, r: number, fill: string, stroke = '#222', sw = 0.2) => `<circle cx="${n2(x)}" cy="${n2(y)}" r="${n2(r)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const lineS = (a: Point, b: Point, color: string, sw: number, extra = '') => `<line x1="${n2(a[0])}" y1="${n2(a[1])}" x2="${n2(b[0])}" y2="${n2(b[1])}" stroke="${color}" stroke-width="${sw}" ${extra}/>`;
const rect = (x: number, y: number, w: number, h: number, fill: string, stroke = '#222', sw = 0.2) => `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;

/** 家具の正面の向き（rotation 0 で南 = +y） */
function front(f: Furniture): Point {
  const a = (f.rotation * Math.PI) / 180;
  return [-Math.sin(a), Math.cos(a)];
}

/** 施工会社の標準からの変更の印（null は標準のまま） */
export function changeTag(f: Furniture): '移動' | '追加' | '変更' | null {
  const std = f.id.startsWith('std-');
  // 標準の物を外して別の id で置き直した物（分電盤など）は、名前に「標準の〜から移動」と書く
  if (!std && /標準の.*移動/.test(f.name)) return '移動';
  if (!std) return /代わり|変更/.test(f.name) && !/（追加）/.test(f.name) ? '変更' : '追加';
  if (/移動/.test(f.name)) return '移動';
  if (/変更|代わり/.test(f.name)) return '変更';
  return null;
}

/** 電灯コンセント図（1 階分）の SVG */
export function electricalSvg(plan: Plan, floorIndex: number, opts: ElectricalOptions): string {
  const floor = plan.floors[floorIndex];
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAPER_W} ${PAPER_H}" width="${PAPER_W}mm" height="${PAPER_H}mm">`);
  out.push(rect(0, 0, PAPER_W, PAPER_H, '#ffffff', 'none', 0));
  // 図枠（二重線）
  out.push(rect(8, 8, PAPER_W - 16, PAPER_H - 16, 'none', '#222', 0.5), rect(9.2, 9.2, PAPER_W - 18.4, PAPER_H - 18.4, 'none', '#222', 0.15));

  const house = houseBounds(plan);
  const fb = floorBounds(floor);
  out.push(...gridAndDims(plan, floor, house, fb));
  out.push(...walls(plan, floor));
  out.push(...outlines(floor));
  out.push(...wiring(plan, floorIndex));
  out.push(...lanRoute(plan, floorIndex));
  out.push(...symbols(plan, floorIndex), ...equipmentCallout(plan, floorIndex));
  out.push(...legend(floor));
  out.push(...titleBlock(plan, floor, opts));
  out.push('</svg>');
  return out.join('\n');
}

function houseBounds(plan: Plan) {
  const pts = plan.floors.flatMap((f) => f.rooms.flatMap((r) => r.polygon));
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
}

function floorBounds(floor: Floor) {
  const pts = floor.rooms.flatMap((r) => r.polygon);
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
}

/** 通り芯（グリッドの線と丸い番号）と寸法線 */
function gridAndDims(plan: Plan, floor: Floor, house: ReturnType<typeof houseBounds>, fb: ReturnType<typeof floorBounds>): string[] {
  const out: string[] = [];
  const g = plan.grid;
  const nx = Math.round((house.x1 - house.x0) / g) + 1;
  const ny = Math.round((house.y1 - house.y0) / g) + 1;
  const top = P(0, house.y0)[1] - 26;
  const bottom = P(0, house.y1)[1] + 22;
  const left = P(house.x0, 0)[0] - 30;
  const right = P(house.x1, 0)[0] + 40;
  // 縦の線（い〜）。左から
  for (let i = 0; i <= nx; i++) {
    const x = P(house.x0 + i * g, 0)[0];
    out.push(lineS([x, top], [x, bottom], '#c4c4c4', 0.12, 'stroke-dasharray="3 0.8 0.6 0.8"'));
    out.push(circle(x, bottom + 4, 2.6, '#fff', '#555', 0.2), text(x, bottom + 4, TSUURI_X[i] ?? '', 2.6, '#333'));
  }
  // 横の線（1〜）。下から
  for (let j = 0; j < ny; j++) {
    const y = P(0, house.y1 - j * g)[1];
    out.push(lineS([left, y], [right, y], '#c4c4c4', 0.12, 'stroke-dasharray="3 0.8 0.6 0.8"'));
    out.push(circle(left - 4, y, 2.6, '#fff', '#555', 0.2), text(left - 4, y, String(j + 1), 2.6, '#333'));
  }
  // 寸法: 外周の部屋の角（上下左右の辺に乗る角）で区切る
  const pts = floor.rooms.flatMap((r) => r.polygon);
  const uniq = (a: number[]) => [...new Set(a.map((v) => Math.round(v * 10) / 10))].sort((p, q) => p - q);
  const xsTop = uniq(pts.filter((p) => Math.abs(p[1] - fb.y0) < 1).map((p) => p[0]));
  const xsBot = uniq(pts.filter((p) => Math.abs(p[1] - fb.y1) < 1).map((p) => p[0]));
  const ysLeft = uniq(pts.filter((p) => Math.abs(p[0] - fb.x0) < 1).map((p) => p[1]));
  const ysRight = uniq(pts.filter((p) => Math.abs(p[0] - fb.x1) < 1).map((p) => p[1]));
  const yTop = P(0, fb.y0)[1];
  const yBot = P(0, fb.y1)[1];
  const xL = P(fb.x0, 0)[0];
  const xR = P(fb.x1, 0)[0];
  out.push(...dimRow(xsTop, yTop - 9, 'h'), ...dimRow([fb.x0, fb.x1], yTop - 15, 'h'));
  out.push(...dimRow(xsBot, yBot + 8, 'h'), ...dimRow([fb.x0, fb.x1], yBot + 14, 'h'));
  out.push(...dimRow(ysLeft, xL - 9, 'v'), ...dimRow([fb.y0, fb.y1], xL - 16, 'v'));
  out.push(...dimRow(ysRight, xR + 10, 'v'), ...dimRow([fb.y0, fb.y1], xR + 17, 'v'));
  return out;
}

/** 寸法の 1 列（cuts は mm の座標、at は紙の上の線の位置） */
function dimRow(cuts: number[], at: number, dir: 'h' | 'v'): string[] {
  const out: string[] = [];
  if (cuts.length < 2) return out;
  const c = cuts.map((v) => (dir === 'h' ? P(v, 0)[0] : P(0, v)[1]));
  const a: Point = dir === 'h' ? [c[0], at] : [at, c[0]];
  const b: Point = dir === 'h' ? [c[c.length - 1], at] : [at, c[c.length - 1]];
  out.push(lineS(a, b, '#444', 0.15));
  for (let i = 0; i < c.length; i++) {
    const t: Point = dir === 'h' ? [c[i], at] : [at, c[i]];
    out.push(lineS([t[0] - 0.8, t[1] + 0.8], [t[0] + 0.8, t[1] - 0.8], '#444', 0.2));
    if (i === 0) continue;
    const len = Math.round(cuts[i] - cuts[i - 1]);
    if (len < 200) continue;
    const m = (c[i] + c[i - 1]) / 2;
    const label = len.toLocaleString('en-US');
    out.push(dir === 'h' ? text(m, at - 1.8, label, 2.3, '#333') : text(at - 1.8, m, label, 2.3, '#333', 'middle', `transform="rotate(-90 ${n2(at - 1.8)} ${n2(m)})"`));
  }
  return out;
}

/** 壁（開口部で抜く）と窓 */
function walls(plan: Plan, floor: Floor, faintNames = true): string[] {
  const out: string[] = [];
  const t = plan.wallThickness;
  // 部屋の外形（薄い床の色と、部屋の名前）
  for (const r of floor.rooms) {
    if (r.void) continue;
    const pts = r.polygon.map((p) => P(p[0], p[1]).map(n2).join(',')).join(' ');
    out.push(`<polygon points="${pts}" fill="${(r.level ?? 0) < 0 ? '#f1f0ec' : '#ffffff'}" stroke="none"/>`);
  }
  const rooms = floor.rooms.map((r) => ({ ...r, polygon: signedArea(r.polygon) > 0 ? r.polygon : [...r.polygon].reverse() }));
  for (const w of deriveWalls(rooms)) {
    const len = dist(w.from, w.to);
    const d: Point = [(w.to[0] - w.from[0]) / len, (w.to[1] - w.from[1]) / len];
    const nrm: Point = [-d[1], d[0]];
    const at = (u: number, k = 0): Point => P(w.from[0] + d[0] * u + nrm[0] * k, w.from[1] + d[1] * u + nrm[1] * k);
    const piece = (u0: number, u1: number) => {
      const q = [at(u0, -t / 2), at(u1, -t / 2), at(u1, t / 2), at(u0, t / 2)];
      return `<polygon points="${q.map((p) => p.map(n2).join(',')).join(' ')}" fill="#d6d6d6" stroke="#222" stroke-width="0.18"/>`;
    };
    const spans = openingsOnSegment(floor.openings, w.from, w.to, t / 2 + 1);
    let u = 0;
    for (const s of [...spans, { u0: len, u1: len, opening: null }]) {
      if (s.u0 > u + 1) out.push(piece(u, s.u0));
      if (s.opening?.type === 'window') {
        out.push(lineS(at(s.u0, -t / 6), at(s.u1, -t / 6), '#222', 0.15), lineS(at(s.u0, t / 6), at(s.u1, t / 6), '#222', 0.15));
        out.push(lineS(at(s.u0, -t / 2), at(s.u0, t / 2), '#222', 0.18), lineS(at(s.u1, -t / 2), at(s.u1, t / 2), '#222', 0.18));
      }
      u = Math.max(u, s.u1);
    }
  }
  // 部屋の名前（薄く）
  for (const r of faintNames ? floor.rooms : []) {
    const area = Math.abs(signedArea(r.polygon)) / 1e6;
    if (area < 1.2 || r.noLabel || r.void) continue;
    const [cx, cy] = centroid(r.polygon);
    const [x, y] = P(cx, cy);
    out.push(text(x, y + 5, r.name, 2.1, '#a0a0a0'));
  }
  return out;
}

/** 家具・設備の外形（薄い灰色） */
function outlines(floor: Floor): string[] {
  const out: string[] = [];
  for (const f of floor.furniture) {
    if (ELECTRIC.has(f.type) || SKIP_OUTLINE.has(f.type)) continue;
    if ((f.z ?? 0) > 300 || f.w * f.d < 150000) continue;
    const a = (f.rotation * Math.PI) / 180;
    const ux: Point = [Math.cos(a), Math.sin(a)];
    const uz: Point = [-Math.sin(a), Math.cos(a)];
    const c = (sx: number, sz: number) => P(f.x + (ux[0] * sx * f.w + uz[0] * sz * f.d) / 2, f.y + (ux[1] * sx * f.w + uz[1] * sz * f.d) / 2);
    const q = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
    out.push(`<polygon points="${q.map((p) => p.map(n2).join(',')).join(' ')}" fill="none" stroke="#bdbdbd" stroke-width="0.12"/>`);
  }
  return out;
}

/** 記号を置く紙の上の位置（壁付けの物は壁から少し部屋の側へ） */
function spot(f: Furniture): Point {
  const [x, y] = P(f.x, f.y);
  if (OUTLETS.has(f.type) || SWITCHES.has(f.type) || PANELS.has(f.type) || BRACKETS.has(f.type) || FOOTLIGHTS.has(f.type)) {
    const [fx, fy] = front(f);
    // ルーターは分電盤の下に置くことが多いので、図では少し横にずらして重ならないようにする
    const k = f.type === 'wifi-router' ? 5 : 0;
    return [x + fx * 2.2 - fy * k, y + fy * 2.2 + fx * k];
  }
  return [x, y];
}

/** LAN の口があるコンセント */
const hasLan = (f: Furniture) => f.type === 'outlet' && (!!f.lan || /LAN/.test(f.name));

/** 3 路スイッチ（2 か所以上から操作する回路のスイッチ） */
function threeWay(plan: Plan): Set<string> {
  const s = new Set<string>();
  for (const c of plan.circuits ?? []) if (new Set(c.switches.map((w) => w.id)).size >= 2) c.switches.forEach((w) => s.add(w.id));
  return s;
}

/** スイッチと照明を結ぶ赤い線（回路ごと）。ほかの階へ続く回路は「2Fへ」と書く */
function wiring(plan: Plan, floorIndex: number): string[] {
  const out: string[] = [];
  const here = new Map(plan.floors[floorIndex].furniture.map((f) => [f.id, f]));
  const floorOf = new Map(plan.floors.flatMap((fl, i) => fl.furniture.map((f) => [f.id, i] as const)));
  for (const c of plan.circuits ?? []) {
    const sws = c.switches.map((w) => here.get(w.id)).filter((f): f is Furniture => !!f);
    const lights = c.lights.map((id) => here.get(id)).filter((f): f is Furniture => !!f);
    // ほかの階のスイッチ・照明
    const other = [...c.switches.map((w) => w.id), ...c.lights].map((id) => floorOf.get(id)).filter((i): i is number => i !== undefined && i !== floorIndex);
    if (!sws.length && !lights.length) continue;
    // 照明を、スイッチから近い順につないでいく
    const pts: Point[] = [];
    const rest = lights.map(spot);
    let cur = sws.length ? spot(sws[0]) : rest.shift()!;
    pts.push(cur);
    while (rest.length) {
      let k = 0;
      for (let i = 1; i < rest.length; i++) if (dist(rest[i], cur) < dist(rest[k], cur)) k = i;
      cur = rest.splice(k, 1)[0];
      pts.push(cur);
    }
    for (let i = 1; i < pts.length; i++) out.push(lineS(pts[i - 1], pts[i], RED, 0.3));
    // 2 つ目からのスイッチは、一番近い照明（なければ 1 つ目のスイッチ）へ
    for (const s of sws.slice(1)) {
      const p = spot(s);
      const near = pts.slice(1).length ? pts.slice(1).reduce((a, b) => (dist(a, p) < dist(b, p) ? a : b)) : pts[0];
      if (dist(near, p) > 0.5) out.push(lineS(p, near, RED, 0.3));
    }
    if (other.length) {
      const to = [...new Set(other)].map((i) => `${i + 1}F`).join('・');
      const [x, y] = sws.length ? spot(sws[0]) : pts[0];
      out.push(`<path d="M ${n2(x)} ${n2(y)} l -5 3" stroke="${RED}" stroke-width="0.3" fill="none" marker-end="url(#arrow)"/>`);
      out.push(text(x - 6.5, y + 4.6, `${to}へ`, 2.1, RED, 'end'));
    }
  }
  if (out.length) out.unshift(`<defs><marker id="arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="${RED}"/></marker></defs>`);
  return out;
}

/** LAN 配管（2 階のパントリーのルーターから、LAN 付きのコンセントへ。点線） */
function lanRoute(plan: Plan, floorIndex: number): string[] {
  const out: string[] = [];
  let router: { f: Furniture; floor: number } | null = null;
  // 配線の元: ルーターの近くの壁の LAN 端子（なければルーター）
  plan.floors.forEach((fl, i) => fl.furniture.forEach((f) => f.type === 'wifi-router' && !router && (router = { f, floor: i })));
  plan.floors.forEach((fl, i) => fl.furniture.forEach((f) => f.type === 'lan-outlet' && (router = { f, floor: i })));
  if (!router) return out;
  const r = router as { f: Furniture; floor: number };
  const lans = plan.floors[floorIndex].furniture.filter(hasLan);
  if (!lans.length && r.floor !== floorIndex) return out;
  const rp = r.floor === floorIndex ? spot(r.f) : P(r.f.x, r.f.y);
  if (r.floor !== floorIndex) {
    // ほかの階のルーターの位置を点線の四角で
    out.push(`<rect x="${n2(rp[0] - 2.5)}" y="${n2(rp[1] - 2.5)}" width="5" height="5" fill="none" stroke="${BLUE}" stroke-width="0.25" stroke-dasharray="0.8 0.6"/>`);
    out.push(text(rp[0] + 3.5, rp[1], `ルーター（${r.floor + 1}F パントリー）の真上・真下`, 1.9, BLUE, 'start'));
  }
  for (const f of lans) {
    const p = spot(f);
    // 壁に沿うように、先に縦、次に横
    out.push(`<polyline points="${n2(rp[0])},${n2(rp[1])} ${n2(rp[0])},${n2(p[1])} ${n2(p[0])},${n2(p[1])}" fill="none" stroke="${BLUE}" stroke-width="0.3" stroke-dasharray="1.2 0.8"/>`);
  }
  return out;
}

/** 1 か所に集まる設備（分電盤・光コンセント・ONU・ルーター・LAN 端子）。記号が重なるので、引き出し線の先の囲みにまとめて書く */
const EQUIPMENT = new Set(['breaker-panel', 'fiber-outlet', 'onu', 'wifi-router', 'lan-outlet']);

/** 囲みにまとめる物: 設備と、その近く（900 以内）のリモコン・インターホン */
function calloutItems(floor: Floor): Furniture[] {
  const eq = floor.furniture.filter((f) => EQUIPMENT.has(f.type));
  const near = floor.furniture.filter((f) => f.type === 'remote-panel' && eq.some((e) => Math.hypot(e.x - f.x, e.y - f.y) < 900));
  return [...eq, ...near];
}

function equipmentCallout(plan: Plan, floorIndex: number): string[] {
  const out: string[] = [];
  const items = calloutItems(plan.floors[floorIndex]);
  if (!items.length) return out;
  const order = ['breaker-panel', 'remote-panel', 'fiber-outlet', 'onu', 'wifi-router', 'lan-outlet'];
  items.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const pts = items.map((f) => P(f.x, f.y));
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  // 実際の位置に小さな点と、まとめた囲み（部屋の中・東へ）への引き出し線
  for (const [x, y] of pts) out.push(circle(x, y, 0.6, BLUE, BLUE, 0.1));
  const rowH = 3.6;
  const bw = 60;
  // 囲みは建物の北の外（寸法線より上）に置き、部屋の中の記号を隠さない
  const ys = plan.floors[floorIndex].rooms.flatMap((r) => r.polygon.map((q) => q[1]));
  const bh = items.length * rowH + 2;
  const bx = cx - 6;
  const by = P(0, Math.min(...ys))[1] - 22 - bh;
  out.push(lineS([cx, cy], [cx, by + bh], BLUE, 0.25));
  out.push(rect(bx, by, bw, bh, '#ffffff', BLUE, 0.3));
  items.forEach((f, i) => {
    const y = by + 1 + rowH * (i + 0.5);
    const sx = bx + 4;
    const label =
      f.type === 'breaker-panel' ? '分電盤' :
      f.type === 'fiber-outlet' ? '光コンセント（屋外から空配管）' :
      f.type === 'onu' ? 'NTT ONU' :
      f.type === 'wifi-router' ? 'Wi-Fi ルーター' :
      f.type === 'remote-panel' ? f.name.replace(/（.*$/, '') :
      `LAN 端子 ${f.count ?? 4} 口（①〜④ へ Cat6A）`;
    const sym =
      f.type === 'breaker-panel' ? rect(sx - 2.5, y - 1.2, 5, 2.4, 'url(#hatch3)', '#222', 0.25) :
      f.type === 'fiber-outlet' ? rect(sx - 2.2, y - 1.3, 4.4, 2.6, '#fff', BLUE, 0.3) + text(sx, y, '光', 1.4, BLUE) :
      f.type === 'onu' ? rect(sx - 2.5, y - 1.3, 5, 2.6, '#fff', BLUE, 0.3) + text(sx, y, 'ONU', 1.3, BLUE) :
      f.type === 'wifi-router' ? rect(sx - 2.5, y - 1.3, 5, 2.6, '#fff', BLUE, 0.3) + text(sx, y, 'Wi-Fi', 1.2, BLUE) :
      f.type === 'remote-panel' ? (/インターホン/.test(f.name) ? circle(sx, y, 1.3, '#fff', RED, 0.3) + text(sx, y, 't', 1.5, RED) : rect(sx - 1.3, y - 1.3, 2.6, 2.6, '#fff', RED, 0.3) + text(sx, y, /給湯/.test(f.name) ? 'R' : '交', 1.4, RED)) :
      rect(sx - 2.5, y - 1.3, 5, 2.6, '#fff', BLUE, 0.3) + text(sx, y, 'LAN', 1.3, BLUE);
    out.push(sym, text(sx + 4, y, label, 1.9, f.type === 'breaker-panel' ? '#222' : f.type === 'remote-panel' ? RED : BLUE, 'start'));
    const tag = changeTag(f);
    if (tag && f.type !== 'wifi-router' && f.type !== 'onu') out.push(`<rect x="${n2(bx + bw - 6.5)}" y="${n2(y - 1.2)}" width="5.2" height="2.4" rx="0.5" fill="${tag === '移動' ? BLUE : ORANGE}"/>`, text(bx + bw - 3.9, y, tag, 1.6, '#fff', 'middle', 'font-weight="bold"'));
  });
  out.push(`<defs><pattern id="hatch3" width="1" height="1" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1" stroke="#666" stroke-width="0.2"/></pattern></defs>`);
  return out;
}

/** 照明・コンセント・スイッチなどの記号 */
function symbols(plan: Plan, floorIndex: number): string[] {
  const out: string[] = [];
  const floor = plan.floors[floorIndex];
  const three = threeWay(plan);
  const inCallout = new Set(calloutItems(floor).map((f) => f.id));
  for (const f of floor.furniture) {
    if (!ELECTRIC.has(f.type) || inCallout.has(f.id)) continue;
    const [x, y] = spot(f);
    const [fx, fy] = front(f);
    // 記号の横の文字を置く向き（壁に沿う方向）
    const side: Point = [-fy, fx];
    const lab = (k: number, s: string, size = 2, color = RED) => text(x + side[0] * k + fx * 0.6, y + side[1] * k + fy * 0.6, s, size, color);
    if (DOWNLIGHTS.has(f.type)) {
      out.push(circle(x, y, 1.9, CYAN, '#222', 0.2), circle(x, y, 1.1, 'none', '#222', 0.15));
      if (f.sensor) out.push(text(x, y - 3.2, 'センサー', 1.8, RED));
    } else if (CEILING.has(f.type)) {
      out.push(circle(x, y, 2.2, CYAN, '#222', 0.2), text(x, y, 'CL', 1.9, '#222'));
    } else if (BRACKETS.has(f.type)) {
      out.push(circle(x, y, 1.8, CYAN, '#222', 0.2), lineS([x - fx * 1.8 + side[0] * 1.8, y - fy * 1.8 + side[1] * 1.8], [x - fx * 1.8 - side[0] * 1.8, y - fy * 1.8 - side[1] * 1.8], '#222', 0.3));
    } else if (FOOTLIGHTS.has(f.type)) {
      // 足元灯: 壁に沿う横長の四角（下半分が光る）
      out.push(`<rect x="${n2(x - 2.2)}" y="${n2(y - 1.1)}" width="4.4" height="2.2" fill="${CYAN}" stroke="#222" stroke-width="0.2" transform="rotate(${Math.abs(side[1]) > 0.5 ? 90 : 0} ${n2(x)} ${n2(y)})"/>`, text(x + fx * 3.2, y + fy * 3.2, 'FL', 1.6, '#222'));
    } else if (PENDANTS.has(f.type)) {
      out.push(circle(x, y, 1.9, CYAN, '#222', 0.2), text(x, y, 'P', 1.9, '#222'));
    } else if (LINES.has(f.type)) {
      const a = (f.rotation * Math.PI) / 180;
      const half = Math.max(f.w, f.h > f.w * 3 ? 0 : f.w) / 2 / SCALE;
      const ux: Point = [Math.cos(a), Math.sin(a)];
      if (f.type === 'halo-light') out.push(circle(x, y, f.w / 2 / SCALE, 'none', CYAN, 0.6));
      else out.push(lineS([x - ux[0] * half, y - ux[1] * half], [x + ux[0] * half, y + ux[1] * half], CYAN, 0.9), lineS([x - ux[0] * half, y - ux[1] * half], [x + ux[0] * half, y + ux[1] * half], '#222', 0.12));
    } else if (RAILS.has(f.type)) {
      const a = (f.rotation * Math.PI) / 180;
      const half = f.w / 2 / SCALE;
      const ux: Point = [Math.cos(a), Math.sin(a)];
      out.push(lineS([x - ux[0] * half, y - ux[1] * half], [x + ux[0] * half, y + ux[1] * half], '#222', 0.8));
      const n = f.count ?? 2;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        out.push(circle(x + ux[0] * f.w * t / SCALE, y + ux[1] * f.w * t / SCALE, 1.3, CYAN, '#222', 0.15), text(x + ux[0] * f.w * t / SCALE, y + ux[1] * f.w * t / SCALE, f.fixture === 'pendant' ? 'P' : 'S', 1.5, '#222'));
      }
    } else if (OUTLETS.has(f.type)) {
      const ac = /エアコン/.test(f.name);
      const earth = /アース/.test(f.name);
      const tv = /テレビ|TV/.test(f.name) && !/テレビ端子はなし/.test(f.name);
      const wp = (f.z ?? 0) < 0 || /屋外|防水|外の/.test(f.name);
      const n = f.count ?? 2;
      out.push(circle(x, y, 1.9, ac ? PINK : GREEN, '#222', 0.2));
      // 差し込み口（縦線）。壁に沿う向き
      for (let i = 0; i < n; i++) {
        const k = (i - (n - 1) / 2) * 1.0;
        out.push(lineS([x + side[0] * k - fx * 1.2, y + side[1] * k - fy * 1.2], [x + side[0] * k + fx * 1.2, y + side[1] * k + fy * 1.2], '#222', 0.25));
      }
      const tags: string[] = [];
      if (ac) tags.push('AC/E');
      else if (earth) tags.push(n === 1 ? 'E' : '2E');
      if (wp) tags.push('WP');
      if (tags.length) out.push(text(x + fx * 4, y + fy * 4, tags.join(' '), 1.9, RED));
      let k = 3.4;
      if (tv) {
        out.push(rect(x + side[0] * k - 1.8, y + side[1] * k - 1.8, 3.6, 3.6, '#fff', RED, 0.3), text(x + side[0] * k, y + side[1] * k, 'TV', 1.7, RED));
        k += 4;
      }
      if (hasLan(f)) {
        const label = f.lanPort ? `LAN${'①②③④⑤⑥⑦⑧'[f.lanPort - 1] ?? f.lanPort}` : 'LAN';
        out.push(rect(x + side[0] * k - 2.8, y + side[1] * k - 1.6, 5.6, 3.2, '#fff', BLUE, 0.3), text(x + side[0] * k, y + side[1] * k, label, 1.6, BLUE));
        if (f.lanLabel) out.push(text(x + side[0] * k + fx * 3, y + side[1] * k + fy * 3, f.lanLabel, 1.6, BLUE));
      }
      // 標準の高さ（一般 FL+250・エアコン 天井−500）と違う物は高さを書く
      const center = Math.round((f.z ?? 0) + f.h / 2);
      if (!ac && Math.abs(center - 250) > 30) out.push(text(x - fx * 0 - side[0] * 3.6, y - side[1] * 3.6 + 2.6, `FL+${center}`, 1.6, '#444'));
    } else if (FLOOR_OUTLETS.has(f.type)) {
      out.push(rect(x - 2.2, y - 2.2, 4.4, 4.4, '#fff', '#222', 0.2), circle(x, y, 1.6, GREEN, '#222', 0.2), lineS([x - 0.5, y - 1], [x - 0.5, y + 1], '#222', 0.25), text(x, y + 3.8, /アース/.test(f.name) ? '床 E' : '床', 1.8, RED));
    } else if (SWITCHES.has(f.type)) {
      const n = Math.max(1, f.count ?? 1);
      for (let i = 0; i < n; i++) {
        const k = (i - (n - 1) / 2) * 1.5;
        out.push(circle(x + side[0] * k, y + side[1] * k, 0.7, RED, RED, 0.1));
      }
      if (three.has(f.id)) out.push(text(x + fx * 1.9 + side[0] * (n * 0.75 + 0.9), y + fy * 1.9 + side[1] * (n * 0.75 + 0.9), '3', 1.8, RED));
      const center = Math.round((f.z ?? 0) + f.h / 2);
      if (Math.abs(center - 1200) > 40) out.push(text(x + fx * 3.2, y + fy * 3.2, `FL+${center}`, 1.6, '#444'));
    } else if (PANELS.has(f.type)) {
      if (f.type === 'lan-outlet') {
        out.push(rect(x - 3.6, y - 1.6, 7.2, 3.2, '#fff', BLUE, 0.3), text(x, y, `LAN×${f.count ?? 4}`, 1.6, BLUE));
        out.push(text(x + fx * 3.6, y + fy * 3.6, 'LAN 端子①〜④（ルーターから）', 1.7, BLUE));
        const tag = changeTag(f);
        if (tag) out.push(`<rect x="${n2(x + side[0] * 6 - 2.6)}" y="${n2(y + side[1] * 6 - 1.25)}" width="5.2" height="2.5" rx="0.5" fill="${ORANGE}"/>`, text(x + side[0] * 6, y + side[1] * 6, tag, 1.7, '#fff', 'middle', 'font-weight="bold"'));
        continue;
      }
      if (f.type === 'onu' || f.type === 'fiber-outlet') {
        const onu = f.type === 'onu';
        out.push(rect(x - 2.6, y - 1.5, 5.2, 3, '#fff', BLUE, 0.3), text(x, y, onu ? 'ONU' : '光', 1.6, BLUE));
        out.push(text(x + fx * 3.4 + (onu ? 0 : 0), y + fy * 3.4, onu ? 'NTT ONU' : '光コンセント', 1.7, BLUE));
        const tag = changeTag(f);
        if (tag && !onu) out.push(`<rect x="${n2(x + side[0] * 4.5 - 2.6)}" y="${n2(y + side[1] * 4.5 - 1.25)}" width="5.2" height="2.5" rx="0.5" fill="${ORANGE}"/>`, text(x + side[0] * 4.5, y + side[1] * 4.5, tag, 1.7, '#fff', 'middle', 'font-weight="bold"'));
        continue;
      }
      const s = f.type === 'breaker-panel' ? '分電盤' : f.type === 'wifi-router' ? 'ルーター' : /給湯/.test(f.name) ? 'R' : /熱交換|換気/.test(f.name) ? '交' : /インターホン|インターフォン/.test(f.name) ? 't' : '';
      if (f.type === 'breaker-panel' || f.type === 'wifi-router') {
        out.push(rect(x - 3, y - 1.6, 6, 3.2, f.type === 'breaker-panel' ? 'url(#hatch)' : '#fff', f.type === 'wifi-router' ? BLUE : '#222', 0.25));
        out.push(`<defs><pattern id="hatch" width="1" height="1" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1" stroke="#666" stroke-width="0.2"/></pattern></defs>`);
        out.push(text(x + fx * 3.6, y + fy * 3.6, s, 1.9, f.type === 'wifi-router' ? BLUE : '#222'));
      } else if (s === 't') out.push(circle(x, y, 1.6, '#fff', RED, 0.3), text(x, y, 't', 1.8, RED));
      else out.push(rect(x - 1.6, y - 1.6, 3.2, 3.2, '#fff', RED, 0.3), text(x, y, s || '□', 1.7, RED));
    }
    // 標準からの変更の印
    const tag = changeTag(f);
    if (tag && f.type !== 'wifi-router' && f.type !== 'onu') {
      const color = tag === '移動' ? BLUE : ORANGE;
      const tx = x - fx * 0 + side[0] * -3.6 + fx * 3.6;
      const ty = y + side[1] * -3.6 + fy * 3.6 - 0.2;
      out.push(`<rect x="${n2(tx - 2.6)}" y="${n2(ty - 1.25)}" width="5.2" height="2.5" rx="0.5" fill="${color}"/>`, text(tx, ty, tag, 1.7, '#fff', 'middle', 'font-weight="bold"'));
    }
    void lab;
  }
  return out;
}

/** 右の凡例と標準取付高さ表 */
function legend(floor: Floor): string[] {
  const out: string[] = [];
  const x0 = 262;
  const y0 = 70;
  const W = 140;
  const rowH = 5;
  const items: [string, (x: number, y: number) => string][] = [
    ['ダウンライト', (x, y) => circle(x, y, 1.6, CYAN) + circle(x, y, 0.9, 'none', '#222', 0.15)],
    ['シーリングライト', (x, y) => circle(x, y, 1.9, CYAN) + text(x, y, 'CL', 1.6)],
    ['ブラケット', (x, y) => circle(x, y, 1.6, CYAN) + lineS([x - 1.6, y + 1.6], [x + 1.6, y + 1.6], '#222', 0.3)],
    ['ペンダントライト', (x, y) => circle(x, y, 1.6, CYAN) + text(x, y, 'P', 1.6)],
    ['フットライト（足元灯・壁埋込）', (x, y) => rect(x - 2.2, y - 1.1, 4.4, 2.2, CYAN) + text(x + 4, y, 'FL', 1.4)],
    ['間接照明（ライン）', (x, y) => lineS([x - 2.5, y], [x + 2.5, y], CYAN, 0.9)],
    ['ライティングレール（S スポット・P ペンダント）', (x, y) => lineS([x - 3, y], [x + 3, y], '#222', 0.8) + circle(x, y, 1.1, CYAN, '#222', 0.15)],
    ['コンセント 2 口', (x, y) => circle(x, y, 1.6, GREEN) + lineS([x - 0.5, y - 1], [x - 0.5, y + 1], '#222', 0.25) + lineS([x + 0.5, y - 1], [x + 0.5, y + 1], '#222', 0.25)],
    ['コンセント アース付（E・2E）', (x, y) => circle(x, y, 1.6, GREEN) + text(x + 3.2, y, '2E', 1.6, RED)],
    ['エアコン用コンセント（専用回路）', (x, y) => circle(x, y, 1.6, PINK) + text(x + 3.6, y, 'AC/E', 1.5, RED)],
    ['テレビ端子', (x, y) => rect(x - 1.6, y - 1.6, 3.2, 3.2, '#fff', RED, 0.3) + text(x, y, 'TV', 1.5, RED)],
    ['LAN（ルーターから空配管）', (x, y) => rect(x - 2, y - 1.5, 4, 3, '#fff', BLUE, 0.3) + text(x, y, 'LAN', 1.4, BLUE)],
    ['フロアコンセント（床）', (x, y) => rect(x - 1.9, y - 1.9, 3.8, 3.8, '#fff') + circle(x, y, 1.3, GREEN)],
    ['スイッチ（3 は 3 路スイッチ）', (x, y) => circle(x, y, 0.7, RED, RED, 0.1) + text(x + 2, y - 1, '3', 1.6, RED)],
    ['給湯器リモコン／熱交換器リモコン', (x, y) => rect(x - 1.4, y - 1.4, 2.8, 2.8, '#fff', RED, 0.3) + text(x, y, 'R', 1.5, RED)],
    ['インターホン（親機）', (x, y) => circle(x, y, 1.4, '#fff', RED, 0.3) + text(x, y, 't', 1.5, RED)],
    ['分電盤', (x, y) => rect(x - 2.5, y - 1.3, 5, 2.6, 'url(#hatch2)', '#222', 0.25)],
    ['Wi-Fi ルーター・LAN 配管（壁内 Cat6A）', (x, y) => rect(x - 2.5, y - 1.3, 5, 2.6, '#fff', BLUE, 0.25) + lineS([x + 2.5, y], [x + 6, y], BLUE, 0.3, 'stroke-dasharray="1.2 0.8"')],
    ['光コンセント・ONU', (x, y) => rect(x - 2.2, y - 1.3, 4.4, 2.6, '#fff', BLUE, 0.3) + text(x, y, '光', 1.4, BLUE)],
    ['スイッチと照明の回路', (x, y) => lineS([x - 3, y], [x + 3, y], RED, 0.3)],
  ];
  out.push(`<defs><pattern id="hatch2" width="1" height="1" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1" stroke="#666" stroke-width="0.2"/></pattern></defs>`);
  out.push(text(x0, y0 - 4, '電気設備凡例', 2.6, '#222', 'start'));
  const half = Math.ceil(items.length / 2);
  const colW = W / 2;
  out.push(rect(x0, y0 - 1.5, W, half * rowH, 'none', '#444', 0.2), lineS([x0 + colW, y0 - 1.5], [x0 + colW, y0 - 1.5 + half * rowH], '#444', 0.2));
  items.forEach(([label, draw], i) => {
    const col = Math.floor(i / half);
    const row = i % half;
    const cx = x0 + col * colW + 5;
    const cy = y0 + 1 + row * rowH;
    if (row) out.push(lineS([x0 + col * colW, cy - 2.5], [x0 + (col + 1) * colW, cy - 2.5], '#ccc', 0.12));
    out.push(draw(cx, cy), text(cx + 9, cy, label, 2.05, '#222', 'start'));
  });
  // 標準からの変更の印
  let y = y0 + half * rowH + 5;
  out.push(text(x0, y, '標準（施工会社の電灯コンセント図 R8.09.21）からの変更', 2.3, '#222', 'start'));
  y += 4.5;
  const marks: [string, string, string][] = [
    ['移動', BLUE, '標準の物を動かす（無料の範囲）'],
    ['追加', ORANGE, '標準にない物を増やす（有料・差額は要確認）'],
    ['変更', ORANGE, '標準の物の種類・器具を変える（差額は要確認）'],
  ];
  for (const [m, c, d] of marks) {
    out.push(`<rect x="${n2(x0 + 1)}" y="${n2(y - 1.25)}" width="5.2" height="2.5" rx="0.5" fill="${c}"/>`, text(x0 + 3.6, y, m, 1.7, '#fff', 'middle', 'font-weight="bold"'), text(x0 + 9, y, d, 2.05, '#222', 'start'));
    y += 4;
  }
  out.push(text(x0, y, '※ 印のない物は標準の位置のまま。標準から外した器具は描いていない', 1.9, '#555', 'start'));
  y += 3.6;
  out.push(text(x0, y, '※ 高さが標準と違う物は FL+（中心の高さ）を書いた', 1.9, '#555', 'start'));
  // 標準取付高さ表
  y += 7;
  out.push(text(x0, y, '標準取付高さ表', 2.4, '#222', 'start'));
  y += 2;
  const rows: [string, string, string][] = [
    ['コンセント等', '一般用', 'FL ＋250'],
    ['', '冷蔵庫用', 'FL ＋1850'],
    ['', '電子レンジ用', 'FL ＋1200'],
    ['', '洗濯機用', 'FL ＋1350'],
    ['', 'インターフォン用', 'FL ＋1400'],
    ['', 'エアコン用', '天井 －500'],
    ['スイッチ', '一般用', 'FL ＋1200'],
    ['その他', 'リモコン・コントローラー', 'FL ＋1400'],
  ];
  out.push(rect(x0, y, W, rows.length * 4, 'none', '#444', 0.2));
  rows.forEach(([a, b, c], i) => {
    const yy = y + 2 + i * 4;
    if (i) out.push(lineS([x0 + 22, yy - 2], [x0 + W, yy - 2], '#ccc', 0.12));
    if (a) out.push(text(x0 + 2, yy, a, 2, '#222', 'start'));
    out.push(text(x0 + 30, yy, b, 2, '#222', 'start'), text(x0 + W - 22, yy, c, 2, '#222', 'start'));
  });
  y += rows.length * 4 + 5;
  out.push(rect(x0, y, 76, 9, 'none', '#222', 0.3), text(x0 + 3, y + 4.5, `${floor.name.replace('階', '')}階　電灯コンセント図　S：1/60`, 3.6, '#222', 'start', 'letter-spacing="0.3"'));
  return out;
}

/** 下の表題欄（施主名・住所・会社の情報は入れない） */
function titleBlock(plan: Plan, floor: Floor, opts: ElectricalOptions, kind: 'electrical' | 'plan' = 'electrical'): string[] {
  const out: string[] = [];
  const y0 = 252;
  const h = PAPER_H - 9.2 - y0;
  out.push(lineS([9.2, y0], [PAPER_W - 9.2, y0], '#222', 0.3));
  const cols = [9.2, 130, 250, 330, PAPER_W - 9.2];
  for (const c of cols.slice(1, -1)) out.push(lineS([c, y0], [c, y0 + h], '#222', 0.2));
  out.push(text(12, y0 + 4, '工事名', 2.2, '#222', 'start'), text(70, y0 + 13, plan.name, 3, '#222'));
  out.push(text(133, y0 + 4, '備考', 2.2, '#222', 'start'));
  const notes =
    kind === 'plan'
      ? ['施工会社の平面詳細図（1/60）の寸法で作った間取りに、', '家具・設備の配置を書き込んだ検討用の平面図', '（マイホームシミュレーターの間取りから作成）']
      : ['施工会社の電灯コンセント図（R8.09.21）をもとに、', '移動・追加・変更と LAN の配管を書き込んだ要望図', '（マイホームシミュレーターの間取りから作成）'];
  notes.forEach((t, i) => out.push(text(136, y0 + 12 + i * 4.5, t, 2.2, '#333', 'start')));
  out.push(text(253, y0 + 4, '日付', 2.2, '#222', 'start'), text(290, y0 + 14, opts.date, 3, '#222'));
  out.push(text(333, y0 + 4, '図面名', 2.2, '#222', 'start'), text(372, y0 + 12, `${floor.name}　${kind === 'plan' ? '平面図' : '電灯コンセント図'}`, 3, '#222'), text(372, y0 + 19, kind === 'plan' ? '（家具配置・検討用）　S：1/60' : '（要望・変更案）　S：1/60', 2.4, '#333'));
  return out;
}

/** 全部の階の電灯コンセント図を、A3 横で 1 階ずつ印刷できる HTML にする（ブラウザの「印刷 → PDF に保存」で PDF にできる） */
export function electricalHtml(plan: Plan, opts: ElectricalOptions): string {
  const pages = [...plan.floors.map((_, i) => electricalSvg(plan, i, opts)), networkSvg(plan, opts)].map((svg) => `<section>${svg}</section>`).join('\n');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(plan.name)} 電灯コンセント図</title>
<style>@page{size:A3 landscape;margin:0}html,body{margin:0;background:#888}section{width:420mm;height:297mm;margin:8mm auto;background:#fff;page-break-after:always;break-after:page}section svg{display:block;width:420mm;height:297mm}
@media print{html,body{background:#fff}section{margin:0}}</style></head><body>${pages}</body></html>`;
}

/**
 * LAN の接続図（系統図）: 屋外の光回線 → 光コンセント → ONU → ルーター → LAN ポート ①〜 → 壁内の Cat6A → 各部屋の LAN 端子。
 * ユーザーの描いた接続図（2026-10-25）の形。LAN の口（lanPort のあるコンセント）とルーター・ONU の置き場所は間取りから読む
 */
export function networkSvg(plan: Plan, opts: ElectricalOptions): string {
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAPER_W} ${PAPER_H}" width="${PAPER_W}mm" height="${PAPER_H}mm">`);
  out.push(rect(0, 0, PAPER_W, PAPER_H, '#ffffff', 'none', 0));
  out.push(rect(8, 8, PAPER_W - 16, PAPER_H - 16, 'none', '#222', 0.5), rect(9.2, 9.2, PAPER_W - 18.4, PAPER_H - 18.4, 'none', '#222', 0.15));
  // どの階・部屋にあるか
  const where = (id: string) => {
    for (const [i, fl] of plan.floors.entries()) {
      const f = fl.furniture.find((x) => x.id === id);
      if (!f) continue;
      const room = fl.rooms.find((r) => !r.void && pointInPolygon([f.x, f.y], r.polygon)) ?? fl.rooms.find((r) => pointInPolygon([f.x, f.y], r.polygon));
      // 壁付けの物は壁の芯の少し内側で調べる
      const [fx, fy] = front(f);
      const inner = fl.rooms.find((r) => pointInPolygon([f.x + fx * 100, f.y + fy * 100], r.polygon));
      return { f, floor: i, room: (inner ?? room)?.name ?? '' };
    }
    return null;
  };
  const all = plan.floors.flatMap((fl) => fl.furniture);
  const router = all.find((f) => f.type === 'wifi-router');
  const onu = all.find((f) => f.type === 'onu');
  const fiber = all.find((f) => f.type === 'fiber-outlet');
  const ports = all.filter((f) => hasLan(f) && f.lanPort).sort((a, b) => (a.lanPort ?? 0) - (b.lanPort ?? 0));
  const rw = router ? where(router.id) : null;
  const FILL = '#e6f1fb';
  const EDGE = '#b9d3ea';
  const INK = '#1d4f86';
  const node = (cx: number, cy: number, w: number, h: number, label: string, size = 3.4) => rect(cx - w / 2, cy - h / 2, w, h, FILL, EDGE, 0.35).replace('<rect', '<rect rx="2.5"') + text(cx, cy, label, size, INK, 'middle', 'font-weight="bold"');
  const tag = (cx: number, cy: number, label: string) => {
    const w = Math.max(14, label.length * 2.6 + 6);
    return rect(cx - w / 2, cy - 2.6, w, 5.2, '#f4f8fd', EDGE, 0.3).replace('<rect', '<rect rx="2.6"') + text(cx, cy, label, 2.3, INK, 'middle', 'font-weight="bold"');
  };
  const arrow = (x: number, y0: number, y1: number) => lineS([x, y0], [x, y1], '#9fb7cc', 0.3, 'marker-end="url(#narrow)"');
  out.push(`<defs><marker id="narrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#9fb7cc"/></marker></defs>`);
  out.push(text(24, 22, 'LAN 接続図（光回線 → ONU → ルーター → 各部屋の LAN 端子）', 4.2, '#222', 'start', 'font-weight="bold"'));
  const X0 = 60;
  // 屋外の光回線と、引き込みの空配管
  out.push(node(X0, 36, 52, 10, '屋外：光回線 1 本'), arrow(X0, 41, 64), tag(X0, 51, '空配管 1 ルートに光ファイバーを通す'));
  // ルーターの部屋の枠
  const n = Math.max(1, ports.length);
  const colW = Math.min(88, (PAPER_W - 40) / n);
  const left = (PAPER_W - colW * n) / 2;
  const colX = (i: number) => left + colW * (i + 0.5);
  const boxTop = 62;
  const boxBottom = 182;
  out.push(rect(left - 4, boxTop, colW * n + 8, boxBottom - boxTop, '#f7f7f7', '#e2e2e2', 0.3).replace('<rect', '<rect rx="4"'));
  out.push(text(PAPER_W / 2, boxTop + 6, rw ? `${rw.floor + 1}F ${rw.room}` : 'ルーターの置き場所', 3, '#333'));
  out.push(node(X0, 80, 56, 11, fiber ? '光コンセント：1 か所' : '光コンセント（未配置）'), arrow(X0, 85.5, 102), tag(X0, 93, '光コード'));
  out.push(node(X0, 108, 40, 11, onu ? 'NTT ONU' : 'NTT ONU（未配置）'), arrow(X0, 113.5, 130), tag(X0, 121, 'LAN ケーブル'));
  out.push(node(X0, 136, 58, 11, router ? (/ソフトバンク/.test(router.name) ? 'ソフトバンクルーター' : 'ルーター') : 'ルーター（未配置）'));
  ports.forEach((f, i) => {
    const x = colX(i);
    const no = '①②③④⑤⑥⑦⑧'[(f.lanPort ?? 1) - 1] ?? String(f.lanPort);
    const w = where(f.id);
    // ルーターからポートへの線
    const sx = X0 - 20 + i * 10;
    out.push(`<polyline points="${n2(sx)},141.5 ${n2(sx)},${n2(146 + i * 2)} ${n2(x)},${n2(146 + i * 2)} ${n2(x)},158" fill="none" stroke="#9fb7cc" stroke-width="0.3" marker-end="url(#narrow)"/>`);
    out.push(tag(x, 154, `LAN ポート${no}`), node(x, 168, colW - 10, 11, `LAN 端子${no}：${f.lanLabel ?? ''}`, 3.2));
    out.push(arrow(x, 173.5, 210), tag(x, 192, '壁内：Cat6A 1 本'));
    // 行き先の部屋
    const tv = /テレビ/.test(f.lanLabel ?? '');
    const h = tv ? 62 : 36;
    out.push(rect(x - colW / 2 + 3, 204, colW - 6, h, '#f7f7f7', '#e2e2e2', 0.3).replace('<rect', '<rect rx="4"'));
    out.push(text(x, 210, w ? `${w.floor + 1}F ${w.room}` : '', 2.8, '#333'));
    out.push(node(x, 224, colW - 14, 11, tv ? 'テレビ用コンセント位置に LAN 端子：1 口' : '壁の LAN 端子：1 口', tv ? 2.7 : 3.2));
    if (tv) out.push(arrow(x, 229.5, 249), tag(x, 238, 'LAN ケーブル'), node(x, 256, 32, 10, 'テレビ'));
  });
  out.push(text(24, PAPER_H - 16, `※ 間取りの LAN 端子（lanPort）・ONU・ルーターの置き場所から作成。${opts.date}`, 2.2, '#666', 'start'));
  out.push('</svg>');
  return out.join('\n');
}

/** 平面図（1 階分）: 電灯コンセント図と同じ図枠・通り芯・寸法に、部屋の名前と広さ、家具・設備の外形を描く */
export function floorPlanSvg(plan: Plan, floorIndex: number, opts: ElectricalOptions): string {
  const floor = plan.floors[floorIndex];
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAPER_W} ${PAPER_H}" width="${PAPER_W}mm" height="${PAPER_H}mm">`);
  out.push(rect(0, 0, PAPER_W, PAPER_H, '#ffffff', 'none', 0));
  out.push(rect(8, 8, PAPER_W - 16, PAPER_H - 16, 'none', '#222', 0.5), rect(9.2, 9.2, PAPER_W - 18.4, PAPER_H - 18.4, 'none', '#222', 0.15));
  out.push(...gridAndDims(plan, floor, houseBounds(plan), floorBounds(floor)));
  out.push(...walls(plan, floor, false));
  // 家具・設備の外形（小さな物と照明・コンセントは描かない）
  for (const f of floor.furniture) {
    if (ELECTRIC.has(f.type) || SKIP_OUTLINE.has(f.type) || f.w * f.d < 20000 || (f.z ?? 0) > 1900) continue;
    const a = (f.rotation * Math.PI) / 180;
    const ux: Point = [Math.cos(a), Math.sin(a)];
    const uz: Point = [-Math.sin(a), Math.cos(a)];
    const c = (sx: number, sz: number) => P(f.x + (ux[0] * sx * f.w + uz[0] * sz * f.d) / 2, f.y + (ux[1] * sx * f.w + uz[1] * sz * f.d) / 2);
    const q = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
    const high = (f.z ?? 0) > 300;
    out.push(`<polygon points="${q.map((p) => p.map(n2).join(',')).join(' ')}" fill="none" stroke="${high ? '#9aa3a8' : '#6b7378'}" stroke-width="0.15" ${high ? 'stroke-dasharray="0.8 0.5"' : ''}/>`);
  }
  // 部屋の名前と広さ（帖）
  const rows: [string, number][] = [];
  for (const r of floor.rooms) {
    const area = Math.abs(signedArea(r.polygon)) / 1e6;
    if (r.void || r.noLabel || area < 0.6) continue;
    rows.push([r.name, area]);
    const [cx, cy] = centroid(r.polygon);
    const [x, y] = P(cx, cy);
    out.push(text(x, y - 1.4, r.name, area < 2 ? 1.9 : 2.5, '#222', 'middle', 'font-weight="bold"'), text(x, y + 1.8, `${(area / 1.62).toFixed(1)}帖`, 1.9, '#555'));
  }
  // 右の部屋の広さの表
  const x0 = 262;
  let y = 70;
  out.push(text(x0, y - 4, '部屋の広さ', 2.6, '#222', 'start'));
  out.push(rect(x0, y - 1.5, 140, rows.length * 4 + 2, 'none', '#444', 0.2));
  rows.forEach(([name, area], i) => {
    const yy = y + 1 + i * 4;
    if (i) out.push(lineS([x0, yy - 2], [x0 + 140, yy - 2], '#ddd', 0.12));
    out.push(text(x0 + 3, yy, name, 2, '#222', 'start'), text(x0 + 110, yy, `${(area / 1.62).toFixed(1)}帖`, 2, '#222', 'end'), text(x0 + 137, yy, `${area.toFixed(2)} m²`, 2, '#555', 'end'));
  });
  y += rows.length * 4 + 6;
  out.push(text(x0, y, '※ 広さは部屋の線（壁の中心）で囲んだ面積。1 帖 = 1.62 m² で計算', 1.9, '#555', 'start'));
  y += 3.6;
  out.push(text(x0, y, '※ 実線は床に置く家具・設備、点線は吊り戸棚・棚板など高い所の物', 1.9, '#555', 'start'));
  y += 9;
  out.push(rect(x0, y, 76, 9, 'none', '#222', 0.3), text(x0 + 3, y + 4.5, `${floor.name.replace('階', '')}階　平面図　S：1/60`, 3.6, '#222', 'start', 'letter-spacing="0.3"'));
  out.push(...titleBlock(plan, floor, opts, 'plan'));
  out.push('</svg>');
  return out.join('\n');
}

/** 全部の階の平面図を、A3 横で 1 階ずつ印刷できる HTML にする */
export function floorPlanHtml(plan: Plan, opts: ElectricalOptions): string {
  const pages = plan.floors.map((_, i) => `<section>${floorPlanSvg(plan, i, opts)}</section>`).join('\n');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(plan.name)} 平面図</title>
<style>@page{size:A3 landscape;margin:0}html,body{margin:0;background:#888}section{width:420mm;height:297mm;margin:8mm auto;background:#fff;page-break-after:always;break-after:page}section svg{display:block;width:420mm;height:297mm}
@media print{html,body{background:#fff}section{margin:0}}</style></head><body>${pages}</body></html>`;
}
