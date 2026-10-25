// 間取りデータ（Plan）から three.js のオブジェクトを組み立てる。
// ここでは mm 単位のまま作り、呼び出し側で 0.001 倍して m にする。
// 3D 座標: X = 平面図の x（東）、Y = 高さ、Z = 平面図の y（南）。

import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  centroid,
  deriveWalls,
  dist,
  edgeSide,
  insetPolygon,
  pointInPolygon,
  openingsOnSegment,
  projectOnLine,
  signedArea,
  type OpeningSpan,
  type WallSegment,
} from './geometry';
import { buildFurniture, getFurnitureType } from './furniture';
import { getMaterial, getMaterialDef, setCustomMaterials } from './materials';
import type { Floor, JambPart, Plan, Point, Roof, Room, Side } from './types';

/** ウォークスルーで「見ているもの」を出すため、面に付けておく情報 */
export type SurfaceInfo =
  | { kind: 'wall'; roomId: string; materialId: string; side: Side; edge: number; zone?: string }
  | { kind: 'floor' | 'ceiling'; roomId: string; materialId: string }
  | { kind: 'exterior'; materialId: string }
  | { kind: 'opening'; openingId: string }
  | { kind: 'jamb'; materialId?: string; openingId?: string; part?: JambPart; sideRoom?: string; floor?: number; capKey?: string };

export interface BuiltFloor {
  group: THREE.Group;
  /** 部屋の床（クリックで部屋を選ぶのに使う） */
  floorMeshes: THREE.Mesh[];
  ceilings: THREE.Mesh[];
  /** 階の上にかぶせる屋根・上階の床下 */
  caps: THREE.Mesh[];
  labels: CSS2DObject[];
}

export interface BuiltPlan {
  root: THREE.Group;
  floors: BuiltFloor[];
  furniture: Map<string, THREE.Group>;
  warnings: string[];
  bounds: THREE.Box3;
}

/** 平面図の点と軸から 3D の点を作る小さなヘルパー。 */
class Frame {
  readonly D: THREE.Vector3;
  readonly N: THREE.Vector3;
  constructor(
    readonly origin: Point,
    dir: Point,
  ) {
    const len = Math.hypot(dir[0], dir[1]);
    this.D = new THREE.Vector3(dir[0] / len, 0, dir[1] / len);
    // D × Y。平面図では (−dy, dx) の向き
    this.N = new THREE.Vector3(-this.D.z, 0, this.D.x);
  }
  at(u: number, v: number, s: number): THREE.Vector3 {
    return new THREE.Vector3(this.origin[0], v, this.origin[1])
      .addScaledVector(this.D, u)
      .addScaledVector(this.N, s);
  }
}

const Y = new THREE.Vector3(0, 1, 0);
/** 方角の向き（平面図の x, y） */
const SIDE_VEC: Record<Side, Point> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

/** 線分（f の向き）の上の開口部 s の、片引き戸の戸袋の範囲 [u0, u1]（戸を引く向きに、戸の幅 = 開口部 + 80） */
function pocketSpan(f: Frame, s: { u0: number; u1: number; opening: { slideTo?: Side; slideLength?: number } }, len: number): [number, number] | null {
  if (!s.opening.slideTo) return null;
  const v = SIDE_VEC[s.opening.slideTo];
  const along = v[0] * f.D.x + v[1] * f.D.z;
  if (Math.abs(along) < 0.5) return null;
  const w = s.opening.slideLength ?? s.u1 - s.u0 + 80;
  const [u0, u1] = along > 0 ? [s.u1, s.u1 + w] : [s.u0 - w, s.u0];
  return [Math.max(0, u0), Math.min(len, u1)];
}

/** 巾木の高さと出 */
const BASEBOARD_H = 60;
const BASEBOARD_T = 8;

/** 四角形を三角形2枚で追加する。法線は a × b の向き。UV は mm。 */
class MeshBuilder {
  positions: number[] = [];
  uvs: number[] = [];
  quad(o: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, uv0: [number, number], uvSize: [number, number]) {
    const p = [o, o.clone().add(a), o.clone().add(a).add(b), o.clone().add(b)];
    const t = [
      [uv0[0], uv0[1]],
      [uv0[0] + uvSize[0], uv0[1]],
      [uv0[0] + uvSize[0], uv0[1] + uvSize[1]],
      [uv0[0], uv0[1] + uvSize[1]],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      this.positions.push(p[i].x, p[i].y, p[i].z);
      this.uvs.push(t[i][0], t[i][1]);
    }
  }
  get empty() {
    return this.positions.length === 0;
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.computeVertexNormals();
    return g;
  }
}

interface Rect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * 長さ len、高さ v0〜v1 の面から開口部をくり抜き、残りを長方形の集まりで返す。
 * 開口部の高さ（sill など）は v と同じ基準（階の FL）で測る。
 */
/** 壁の片側（s = +1 は N の側）の面の穴（片引き戸の戸袋） */
interface Hole {
  s: 1 | -1;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** 長方形 r から穴を抜いた残りの長方形 */
function cutRect(r: Rect, holes: { u0: number; u1: number; v0: number; v1: number }[]): Rect[] {
  let rects: Rect[] = [r];
  for (const hl of holes) {
    const next: Rect[] = [];
    for (const q of rects) {
      const u0 = Math.max(q.u0, hl.u0);
      const u1 = Math.min(q.u1, hl.u1);
      const v0 = Math.max(q.v0, hl.v0);
      const v1 = Math.min(q.v1, hl.v1);
      if (u1 - u0 < 0.5 || v1 - v0 < 0.5) {
        next.push(q);
        continue;
      }
      if (u0 > q.u0) next.push({ ...q, u1: u0 });
      if (u1 < q.u1) next.push({ ...q, u0: u1 });
      if (v0 > q.v0) next.push({ u0, u1, v0: q.v0, v1: v0 });
      if (v1 < q.v1) next.push({ u0, u1, v0: v1, v1: q.v1 });
    }
    rects = next;
  }
  return rects.filter((q) => q.u1 - q.u0 > 0.5 && q.v1 - q.v0 > 0.5);
}

function rectsWithHoles(len: number, v0: number, v1: number, spans: OpeningSpan[]): Rect[] {
  const rects: Rect[] = [];
  let u = 0;
  for (const s of spans) {
    if (s.u0 > u) rects.push({ u0: u, u1: s.u0, v0, v1 });
    const bottom = Math.max(v0, s.opening.sill);
    const top = Math.min(v1, s.opening.sill + s.opening.height);
    if (bottom >= top) {
      rects.push({ u0: s.u0, u1: s.u1, v0, v1 }); // この面の高さの範囲に開口部がかからない
    } else {
      if (bottom > v0) rects.push({ u0: s.u0, u1: s.u1, v0, v1: bottom });
      if (top < v1) rects.push({ u0: s.u0, u1: s.u1, v0: top, v1 });
    }
    u = Math.max(u, s.u1);
  }
  if (u < len) rects.push({ u0: u, u1: len, v0, v1 });
  return rects.filter((r) => r.u1 - r.u0 > 0.5 && r.v1 - r.v0 > 0.5);
}

const slabMat = new THREE.MeshStandardMaterial({ color: '#b9b6b0', roughness: 0.9 });
const roofMat = new THREE.MeshStandardMaterial({ color: '#5d5f62', roughness: 0.8 });
/** 黒い板金（雨どい・水切り・鼻隠し） */
const blackMetal = new THREE.MeshStandardMaterial({ color: '#17181a', roughness: 0.45, metalness: 0.5 });
blackMetal.userData.shared = true;
/** 水切りの薄い板（表裏の両面を描く） */
const blackMetalBoth = new THREE.MeshStandardMaterial({ color: '#17181a', roughness: 0.45, metalness: 0.5, side: THREE.DoubleSide });
blackMetalBoth.userData.shared = true;
slabMat.userData.shared = roofMat.userData.shared = true;

/**
 * 屋根の外形（軒先）。外に面した辺は壁の外の面から軒の出だけ外へ、上の階の壁に突き当たる辺（辺の外が上の階の部屋）は
 * 壁芯で止める（家の中に軒が出ないように）
 */
function roofOutline(plan: Plan, roof: Roof): Point[] {
  const t = plan.wallThickness + 2 * (plan.claddingThickness ?? 0);
  const poly = signedArea(roof.polygon) > 0 ? roof.polygon : [...roof.polygon].reverse();
  const upper = plan.floors[roof.floor + 1]?.rooms ?? [];
  const n = poly.length;
  // 辺ごとの外への距離と、ずらした直線（点 p と向き d）
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const len = dist(a, b);
    const d: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    // 外向き（反時計回りなので右手側）
    const nx = d[1];
    const ny = -d[0];
    const probe: Point = [(a[0] + b[0]) / 2 + nx * (t / 2 + 30), (a[1] + b[1]) / 2 + ny * (t / 2 + 30)];
    const off = upper.some((r) => pointInPolygon(probe, r.polygon)) ? 0 : t / 2 + roof.eave;
    return { p: [a[0] + nx * off, a[1] + ny * off] as Point, d };
  });
  return poly.map((_, i) => {
    const l1 = lines[(i + n - 1) % n];
    const l2 = lines[i];
    const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
    if (Math.abs(den) < 1e-9) return l2.p;
    const s = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / den;
    return [l1.p[0] + l1.d[0] * s, l1.p[1] + l1.d[1] * s] as Point;
  });
}

/** 片流れの屋根で、平面図の点 (x, y) が低い側の軒先からどれだけ上がるか（mm） */
function roofRise(roof: Roof, outline: Point[], x: number, y: number): number {
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const d = roof.low === 'north' ? y - Math.min(...ys) : roof.low === 'south' ? Math.max(...ys) - y : roof.low === 'west' ? x - Math.min(...xs) : Math.max(...xs) - x;
  return d * roof.slope;
}

/**
 * 片流れの屋根（軒の出・鼻隠し・黒い軒天）、壁の上端から屋根の下までの外壁、低い側の軒樋と竪樋を作る。
 * 高さは階の壁の上端（階高）から。屋根は「階の上面」と同じく、俯瞰でその階を見るときは隠す
 */
function buildRoof(plan: Plan, roof: Roof, built: BuiltFloor, warnings: string[]) {
  const floor = plan.floors[roof.floor];
  if (!floor) return;
  if (!getMaterialDef(roof.material)) warnings.push(`屋根: 素材ID「${roof.material}」が見つかりません（マゼンタで表示）`);
  // 外壁の外の面（壁の厚みの半分 ＋ 外壁の外側に足した厚み）までを壁として扱う
  const t = plan.wallThickness + 2 * (plan.claddingThickness ?? 0);
  const base = floor.height;
  const poly = signedArea(roof.polygon) > 0 ? roof.polygon : [...roof.polygon].reverse();
  const outline = roofOutline(plan, roof);
  const rise = (x: number, y: number) => roofRise(roof, outline, x, y);
  const objs: THREE.Mesh[] = [];

  // 屋根の板（上面は屋根材、側面＝鼻隠しと下面＝軒天は黒）
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, -y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: roof.thickness, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + base + rise(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const slab = new THREE.Mesh(geo, [getMaterial(roof.material), blackMetal]);
  objs.push(slab);

  // 壁の上端から屋根の下までの外壁（高い側ほど高くなる三角・台形の部分）
  const ext = getMaterial(floor.exterior ?? plan.exterior);
  const fill: number[] = [];
  const fuv: number[] = [];
  const n = poly.length;
  const upper = plan.floors[roof.floor + 1]?.rooms ?? [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const len = dist(a, b);
    if (len < 1) continue;
    // 外側（反時計回りの外形なので右手側）へ壁の厚みの半分ずらした外の面
    const nx = (b[1] - a[1]) / len;
    const ny = -(b[0] - a[0]) / len;
    // 上の階の壁に突き当たる辺（辺の外が上の階の部屋）には作らない（上の階の部屋の中に外壁の帯が出る。3 階の階段）
    const probe: Point = [(a[0] + b[0]) / 2 + nx * (t / 2 + 30), (a[1] + b[1]) / 2 + ny * (t / 2 + 30)];
    if (upper.some((r) => pointInPolygon(probe, r.polygon))) continue;
    const o = t / 2 + 1;
    const p0: Point = [a[0] + nx * o, a[1] + ny * o];
    const p1: Point = [b[0] + nx * o, b[1] + ny * o];
    const h0 = rise(p0[0], p0[1]);
    const h1 = rise(p1[0], p1[1]);
    if (h0 < 1 && h1 < 1) continue;
    const v = [
      [p0[0], base, p0[1]], [p1[0], base, p1[1]], [p1[0], base + h1, p1[1]],
      [p0[0], base, p0[1]], [p1[0], base + h1, p1[1]], [p0[0], base + h0, p0[1]],
    ];
    const uv = [[0, 0], [len, 0], [len, h1], [0, 0], [len, h1], [0, h0]];
    // 表裏の両方から見えるように、逆回りの三角形も足す（素材を複製すると描けなくなる環境がある）
    for (const k of [0, 1, 2, 3, 4, 5, 2, 1, 0, 5, 4, 3]) fill.push(...v[k]);
    for (const k of [0, 1, 2, 3, 4, 5, 2, 1, 0, 5, 4, 3]) fuv.push(...uv[k]);
  }
  if (fill.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(fill, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2));
    g.computeVertexNormals();
    objs.push(new THREE.Mesh(g, ext));
  }

  // 軒樋（低い側の軒先の外、黒の角樋）
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const gw = 105;
  const gh = 90;
  const gy = base + roof.thickness - gh - 15;
  const along = roof.low === 'north' || roof.low === 'south';
  const gl = along ? x1 - x0 : y1 - y0;
  const gutter = new THREE.Mesh(new THREE.BoxGeometry(along ? gl : gw, gh, along ? gw : gl), blackMetal);
  const edge = roof.low === 'north' ? y0 - gw / 2 : roof.low === 'south' ? y1 + gw / 2 : roof.low === 'west' ? x0 - gw / 2 : x1 + gw / 2;
  gutter.position.set(along ? (x0 + x1) / 2 : edge, gy + gh / 2, along ? edge : (y0 + y1) / 2);
  objs.push(gutter);

  // 竪樋（軒樋から下へ。下に低い屋根があればその上面まで、なければ地面まで）
  for (const [px, py] of roof.downpipes ?? []) {
    let bottom = (plan.groundLevel ?? 0) - floor.elevation;
    for (const r of plan.roofs ?? []) {
      if (r === roof || r.floor >= roof.floor) continue;
      const rf = plan.floors[r.floor];
      const ro = roofOutline(plan, r);
      if (pointInPolygon([px, py], ro)) bottom = Math.max(bottom, rf.elevation + rf.height + r.thickness + roofRise(r, ro, px, py) - floor.elevation);
    }
    const top = gy;
    const pipe = new THREE.Mesh(new THREE.BoxGeometry(60, top - bottom, 60), blackMetal);
    pipe.position.set(px, (top + bottom) / 2, py);
    objs.push(pipe);
    // 軒樋から竪樋への呼び樋（横向き）
    const gx = along ? px : edge;
    const gz = along ? edge : py;
    const len = Math.hypot(px - gx, py - gz);
    if (len > 30) {
      const link = new THREE.Mesh(new THREE.BoxGeometry(50, 50, len), blackMetal);
      link.position.set((px + gx) / 2, top - 60, (py + gz) / 2);
      link.lookAt(new THREE.Vector3(px, top - 60, py).add(built.group.position));
      objs.push(link);
    }
  }
  // 太陽光パネル（屋根の勾配なりに並べる）
  if (roof.solar) {
    const { size, cols, rows } = roof.solar;
    const gap = roof.solar.gap ?? 20;
    const [pw, pl, pt] = size;
    // 流れの向き（低い側から高い側）と、それに直交する向き
    const flowX = roof.low === 'west' ? 1 : roof.low === 'east' ? -1 : 0;
    const flowZ = roof.low === 'north' ? 1 : roof.low === 'south' ? -1 : 0;
    const across = flowZ !== 0;
    const cx = (x0 + x1) / 2;
    const cz = (y0 + y1) / 2;
    const totalA = cols * pw + (cols - 1) * gap;
    const totalF = rows * pl + (rows - 1) * gap;
    const panelMat = solarMaterial();
    const angle = Math.atan(roof.slope);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const a = -totalA / 2 + pw / 2 + c * (pw + gap);
        const f = -totalF / 2 + pl / 2 + r * (pl + gap);
        const x = cx + (across ? a : f * flowX);
        const z = cz + (across ? f * flowZ : a);
        const y = base + roof.thickness + rise(x, z) + 100;
        const panel = new THREE.Mesh(new THREE.BoxGeometry(across ? pw : pl, pt, across ? pl : pw), [blackMetal, blackMetal, panelMat, blackMetal, blackMetal, blackMetal]);
        panel.position.set(x, y + pt / 2, z);
        // 高い側へ上がるように傾ける
        if (across) panel.rotation.x = -angle * flowZ;
        else panel.rotation.z = angle * flowX;
        objs.push(panel);
      }
    }
  }
  for (const m of objs) {
    m.castShadow = true;
    m.receiveShadow = true;
    built.group.add(m);
    built.caps.push(m);
  }
}

/** 太陽光パネルの表面（黒いセルと細い線。真ん中で上下 2 つに分かれる） */
let solarMat: THREE.MeshStandardMaterial | null = null;
function solarMaterial(): THREE.MeshStandardMaterial {
  if (solarMat) return solarMat;
  const c = document.createElement('canvas');
  c.width = 120;
  c.height = 186;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0d1016';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#2a2f38';
  g.lineWidth = 1;
  // 6 列 × 上下 10 段ずつのセル
  for (let i = 1; i < 6; i++) {
    g.beginPath();
    g.moveTo((i * c.width) / 6, 0);
    g.lineTo((i * c.width) / 6, c.height);
    g.stroke();
  }
  for (let j = 1; j < 20; j++) {
    g.beginPath();
    g.moveTo(0, (j * c.height) / 20);
    g.lineTo(c.width, (j * c.height) / 20);
    g.stroke();
  }
  g.fillStyle = '#5b6068';
  g.fillRect(0, c.height / 2 - 1.5, c.width, 3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  solarMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.15, metalness: 0.3 });
  solarMat.userData.shared = true;
  return solarMat;
}

export function buildPlan(plan: Plan, clip: THREE.Plane[]): BuiltPlan {
  setCustomMaterials(plan.materials);
  const root = new THREE.Group();
  const warnings: string[] = [];
  const furniture = new Map<string, THREE.Group>();
  const bounds = new THREE.Box3();

  for (const id of new Set([plan.exterior, ...plan.floors.map((f) => f.exterior ?? plan.exterior)])) {
    if (!getMaterialDef(id)) warnings.push(`外壁: 素材ID「${id}」が見つかりません（マゼンタで表示）`);
  }

  const ids = new Set<string>();
  const floors = plan.floors.map((floor, index) => {
    for (const x of [...floor.rooms, ...floor.furniture]) {
      if (ids.has(x.id)) warnings.push(`ID「${x.id}」が重複しています（部屋・家具の ID は全部の階で別にする）`);
      ids.add(x.id);
    }
    const built = buildFloor(plan, floor, index, clip, warnings, furniture);
    dropCoveredJambs(built.group);
    built.group.position.y = floor.elevation;
    root.add(built.group);
    for (const roof of plan.roofs ?? []) if (roof.floor === index) buildRoof(plan, roof, built, warnings);
    for (const r of floor.rooms) {
      for (const [x, y] of r.polygon) {
        bounds.expandByPoint(new THREE.Vector3(x, floor.elevation, y));
        bounds.expandByPoint(new THREE.Vector3(x, floor.elevation + floor.height, y));
      }
    }
    return built;
  });
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(), new THREE.Vector3(10000, 2400, 10000));
  return { root, floors, furniture, warnings, bounds };
}

/**
 * 開口部の側面（jamb）のうち、部屋の壁の仕上げと同じ面に重なっている三角形を消す。
 * 部屋の壁の仕上げは角で壁の厚みの分まで回り込むので、開口部が壁の角の近くで終わると、開口部の側面と同じ所に 2 枚のクロスが重なり、
 * 品番が違うとちらついていた（1 階 シューズクロークの入口・玄関との間の開口など。2026-10-25）。部屋の壁（クリックで選んだクロス）を残す
 */
function dropCoveredJambs(group: THREE.Group) {
  const meshes = group.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh && !!o.userData.info);
  // 部屋の壁の三角形を、面の向き（軸と符号）と位置で分ける
  const walls = new Map<string, number[][]>();
  const keyOf = (n: THREE.Vector3, p: THREE.Vector3) => {
    const ax = Math.abs(n.x) > 0.999 ? 0 : Math.abs(n.y) > 0.999 ? 1 : Math.abs(n.z) > 0.999 ? 2 : -1;
    if (ax < 0) return null;
    const c = [p.x, p.y, p.z][ax];
    return { ax, base: `${ax}${Math.sign([n.x, n.y, n.z][ax])}`, c };
  };
  const tri = (pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number) => [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, i + k));
  const normal = (t: THREE.Vector3[]) => new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0])).normalize();
  for (const m of meshes) {
    if (m.userData.info.kind !== 'wall') continue;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
      const t = tri(pos, i);
      const k = keyOf(normal(t), t[0]);
      if (!k) continue;
      const key = `${k.base}|${Math.round(k.c)}`;
      const list = walls.get(key) ?? [];
      list.push(t.flatMap((v) => [v.x, v.y, v.z]));
      walls.set(key, list);
    }
  }
  const inside = (q: THREE.Vector3, w: number[]) => {
    const a = new THREE.Vector3(w[0], w[1], w[2]);
    const v0 = new THREE.Vector3(w[6], w[7], w[8]).sub(a);
    const v1 = new THREE.Vector3(w[3], w[4], w[5]).sub(a);
    const v2 = q.clone().sub(a);
    const d00 = v0.dot(v0), d01 = v0.dot(v1), d02 = v0.dot(v2), d11 = v1.dot(v1), d12 = v1.dot(v2);
    const inv = 1 / (d00 * d11 - d01 * d01);
    const u = (d11 * d02 - d01 * d12) * inv;
    const v = (d00 * d12 - d01 * d02) * inv;
    return u > -0.001 && v > -0.001 && u + v < 1.001;
  };
  for (const m of meshes) {
    if (m.userData.info.kind !== 'jamb') continue;
    const pos = m.geometry.getAttribute('position');
    const uv = m.geometry.getAttribute('uv');
    const keepP: number[] = [];
    const keepUv: number[] = [];
    let dropped = 0;
    for (let i = 0; i < pos.count; i += 3) {
      const t = tri(pos, i);
      const k = keyOf(normal(t), t[0]);
      const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
      let covered = false;
      if (k) for (let d = -2; d <= 2 && !covered; d++) covered = (walls.get(`${k.base}|${Math.round(k.c) + d}`) ?? []).some((w) => Math.abs([w[0], w[1], w[2]][k.ax] - k.c) < 2 && inside(c, w));
      if (covered) {
        dropped++;
        continue;
      }
      for (let j = 0; j < 3; j++) {
        keepP.push(pos.getX(i + j), pos.getY(i + j), pos.getZ(i + j));
        keepUv.push(uv.getX(i + j), uv.getY(i + j));
      }
    }
    if (!dropped) continue;
    if (!keepP.length) {
      m.removeFromParent();
      m.geometry.dispose();
      continue;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(keepP, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(keepUv, 2));
    g.computeVertexNormals();
    m.geometry.dispose();
    m.geometry = g;
  }
}

function buildFloor(
  plan: Plan,
  floor: Floor,
  index: number,
  clip: THREE.Plane[],
  warnings: string[],
  furnitureOut: Map<string, THREE.Group>,
): BuiltFloor {
  const group = new THREE.Group();
  group.userData.floorIndex = index;
  const t = plan.wallThickness;
  /** 外に面した壁の外側に足す厚み（外壁材・通気胴縁・構造用面材） */
  const clad = plan.claddingThickness ?? 0;
  const where = (s: string) => (plan.floors.length > 1 ? `${floor.name} ${s}` : s);
  const checkMaterial = (id: string, label: string) => {
    if (id && !getMaterialDef(id)) warnings.push(`${where(label)}: 素材ID「${id}」が見つかりません（マゼンタで表示）`);
  };

  // 部屋の外形は面積が正の向きにそろえる（内側の向きを決めるため）
  const rooms: Room[] = floor.rooms.map((r) => ({
    ...r,
    polygon: signedArea(r.polygon) > 0 ? r.polygon : [...r.polygon].reverse(),
  }));

  // 壁は階の FL から上の階の FL まで。1階だけは地面（と一番低い床）から立ち上げる
  const lowest = Math.min(0, ...rooms.map((r) => r.level ?? 0));
  const wallBottom = index === 0 ? Math.min(lowest, plan.groundLevel ?? 0) : 0;
  const wallTop = floor.height;

  // ---- 1 階の基礎（GL から基礎の高さまで）と土台水切り（黒） ----
  if (index === 0 && plan.foundationHeight) {
    const gl = plan.groundLevel ?? 0;
    const topF = gl + plan.foundationHeight;
    const found = new MeshBuilder();
    const flash = new MeshBuilder();
    for (const room of rooms) {
      const n = room.polygon.length;
      for (let i = 0; i < n; i++) {
        const a = room.polygon[i];
        const b = room.polygon[(i + 1) % n];
        const len = dist(a, b);
        if (len < 1) continue;
        // 外側（反時計回りなので右手側）に部屋がなければ外壁
        const nx = (b[1] - a[1]) / len;
        const ny = -(b[0] - a[0]) / len;
        const mid: Point = [(a[0] + b[0]) / 2 + nx * (t / 2 + 30), (a[1] + b[1]) / 2 + ny * (t / 2 + 30)];
        const outsideRoom = rooms.some((r) => pointInPolygon(mid, r.polygon));
        // 外に面していない壁でも、この部屋の床が基礎の上端より低ければ（車庫・ポーチ・ポーチの段）、部屋の側に基礎が見える
        const lvl = room.level ?? 0;
        const lowInside = lvl < topF - 1;
        if (outsideRoom && !lowInside) continue;
        // 床まで抜けた開口部（玄関・シャッター・壁のない所）は除く
        const spans = openingsOnSegment(floor.openings, a, b, t / 2 + 5)
          .filter((s) => (s.opening.sill ?? 0) <= (room.level ?? 0) + 1 && s.opening.type !== 'window')
          .map((s) => [s.u0, s.u1] as [number, number])
          .sort((p, q) => p[0] - q[0]);
        const runs: [number, number][] = [];
        let u = -t / 2;
        for (const [s0, s1] of spans) {
          if (s0 > u + 1) runs.push([u, s0]);
          u = Math.max(u, s1);
        }
        if (len + t / 2 > u + 1) runs.push([u, len + t / 2]);
        const f = new Frame(a, [b[0] - a[0], b[1] - a[1]]);
        // N は左手側（部屋の内側）なので、外は −N
        const out = -(t / 2 + 4);
        // 土台水切りは外壁の外の面（外側に足した厚みの先）からさらに 18 出す
        const fo = -(t / 2 + clad + 4);
        for (const [r0, r1] of runs) {
          const w = r1 - r0;
          if (!outsideRoom) {
            found.quad(f.at(r1, gl, out), f.D.clone().multiplyScalar(-w), Y.clone().multiplyScalar(topF - gl), [r0, gl], [w, topF - gl]);
            // 水切りは角で外壁の外の面の先まで延ばして、隣の辺の水切りと突き合わせる
            const ext = clad + 18;
            const q0 = r0 <= -t / 2 + 1 ? r0 - ext : r0;
            const q1 = r1 >= len + t / 2 - 1 ? r1 + ext : r1;
            const qw = q1 - q0;
            flash.quad(f.at(q1, topF - 5, fo - 18), f.D.clone().multiplyScalar(-qw), Y.clone().multiplyScalar(35), [q0, 0], [qw, 35]);
            flash.quad(f.at(q1, topF + 30, fo - 18), f.D.clone().multiplyScalar(-qw), f.N.clone().multiplyScalar(-(fo - 18) + out), [q0, 0], [qw, out - fo + 18]);
          }
          if (lowInside) {
            // 部屋の側（N の向き）の面。床から基礎の上端まで
            const inn = t / 2 + 4;
            found.quad(f.at(r0, lvl, inn), f.D.clone().multiplyScalar(w), Y.clone().multiplyScalar(topF - lvl), [r0, lvl], [w, topF - lvl]);
            flash.quad(f.at(r0, topF - 5, inn + 18), f.D.clone().multiplyScalar(w), Y.clone().multiplyScalar(35), [r0, 0], [w, 35]);
            flash.quad(f.at(r0, topF + 30, inn), f.D.clone().multiplyScalar(w), f.N.clone().multiplyScalar(18), [r0, 0], [w, 18]);
          }
        }
      }
    }
    if (!found.empty) {
      const fm = new THREE.Mesh(found.geometry(), getMaterial('foundation-concrete', { clip }));
      fm.receiveShadow = true;
      group.add(fm);
    }
    if (!flash.empty) {
      const m = new THREE.Mesh(flash.geometry(), blackMetalBoth);
      m.castShadow = true;
      group.add(m);
    }
  }

  // ---- 構造壁（外壁の素材で作り、室内側は仕上げ面で覆う） ----
  const walls = deriveWalls(rooms);
  const wallBuilder = new MeshBuilder();
  // 壁の端に、ほかの壁（開口部で抜けていない所）がつながっているか。
  // つながる壁が端のすぐ横（壁の厚みの半分以内）で開口部になっているときは、延ばすと開口部の中に切れ端（柱のような物）が出るので、つながっていないことにする
  const joined = (p: Point, self: WallSegment) => {
    return walls.some((w2) => {
      if (w2 === self) return false;
      const len2 = dist(w2.from, w2.to);
      const { u, off } = projectOnLine(p, w2.from, w2.to);
      if (off > 1 || u < -1 || u > len2 + 1) return false;
      return !openingsOnSegment(floor.openings, w2.from, w2.to, t / 2 + 1).some((s) => u > s.u0 - t / 2 - 1 && u < s.u1 + t / 2 + 1);
    });
  };
  // 開口部まわり・壁の切れ目の面（壁の厚みの面）は、すぐ隣の壁のクロスで巻き込む。
  // 厚みの真ん中で分けて、それぞれの側の部屋の壁クロス（部屋がない外側は外壁）を貼る
  const finishAt = (p: Point): string | undefined => {
    const room = rooms.find((r) => pointInPolygon(p, r.polygon));
    if (!room) return undefined;
    let best = 0;
    let bestOff = Infinity;
    room.polygon.forEach((a, i) => {
      const b = room.polygon[(i + 1) % room.polygon.length];
      const { u, off } = projectOnLine(p, a, b);
      if (u >= -1 && u <= dist(a, b) + 1 && Math.abs(off) < bestOff) [best, bestOff] = [i, Math.abs(off)];
    });
    return room.accent?.[edgeSide(room.polygon, best)] ?? room.wall;
  };
  const exteriorId = floor.exterior ?? plan.exterior;
  const sideBuilders = new Map<string, { mb: MeshBuilder; id: string; openingId?: string; part?: JambPart; sideRoom?: string; capKey?: string }>();
  /** 壁 f の位置 u で、s の側（+1 = N の側）の仕上げを入れる先。開口部まわりの面で、開口部にクロスの指定があればそれを貼る */
  const sideBuilder = (f: Frame, u: number, s: 1 | -1, openingId?: string, part?: JambPart): MeshBuilder => {
    const p = f.at(u, 0, s * (t / 2 + 20));
    // 開口部に属さない面（壁の切れ目）は、面の位置をキーにして 1 面ずつ張り替えられるようにする
    const capKey = openingId ? undefined : `${Math.round(p.x / 10) * 10},${Math.round(p.z / 10) * 10}`;
    const op = openingId ? floor.openings.find((o) => o.id === openingId) : undefined;
    // 開口部の面は、1 面の片側の半分（左右の側面・上の面 × 壁の厚みの真ん中で分けた部屋の側）の指定 → 1 面の指定 → 開口部全体の指定 → 側の部屋の壁のクロス
    const sideRoom = openingId ? rooms.find((r) => pointInPolygon([p.x, p.z], r.polygon))?.id : undefined;
    const faces = op?.jambFaces;
    const own = openingId ? ((part && (faces?.[`${part}|${sideRoom ?? ''}`] ?? faces?.[part])) ?? op?.jamb) : floor.jambs?.[capKey!];
    const id = own ?? finishAt([p.x, p.z]) ?? exteriorId;
    const key = `${id}|${openingId ?? ''}|${part ?? ''}|${sideRoom ?? ''}|${capKey ?? ''}`;
    const entry = sideBuilders.get(key) ?? { mb: new MeshBuilder(), id, openingId, part, sideRoom, capKey };
    sideBuilders.set(key, entry);
    return entry.mb;
  };
  // ---- 外に面した壁の外側の厚み（外壁材など）。壁の外の面から clad だけ外へ、外壁の素材の箱を足す ----
  const inRoom = (p: Point) => rooms.some((r) => pointInPolygon(p, r.polygon));
  const inWall = (p: Point) =>
    walls.some((w2) => {
      const { u, off } = projectOnLine(p, w2.from, w2.to);
      return off < t / 2 + 0.5 && u > -t / 2 && u < dist(w2.from, w2.to) + t / 2;
    });
  // 1 階は基礎の上端（土台水切り）から上だけ
  const cladBottom = index === 0 && plan.foundationHeight ? (plan.groundLevel ?? 0) + plan.foundationHeight : wallBottom;
  const addCladding = (f: Frame, len: number, rects: Rect[]) => {
    const h = t / 2;
    for (const s of [1, -1] as const) {
      // 外側（部屋がない側）の所を 50mm ごとに調べて、続いている範囲ごとに足す
      const outside = (u: number) => {
        const p = f.at(u, 0, s * (h + clad / 2));
        return !inRoom([p.x, p.z]) && !inWall([p.x, p.z]);
      };
      for (const r of rects) {
        const v0 = Math.max(r.v0, cladBottom);
        const v1 = r.v1;
        if (v1 - v0 < 1) continue;
        const steps = Math.max(1, Math.ceil((r.u1 - r.u0) / 50));
        let start = -1;
        for (let k = 0; k <= steps; k++) {
          const u = r.u0 + ((k + 0.5) / steps) * (r.u1 - r.u0);
          const on = k < steps && outside(u);
          if (on && start < 0) start = k;
          if (on || start < 0) continue;
          let u0 = r.u0 + (start / steps) * (r.u1 - r.u0);
          let u1 = r.u0 + (k / steps) * (r.u1 - r.u0);
          start = -1;
          // 壁の端（外の角）は外壁の厚みだけ延ばして角を包む。入隅は相手の壁の手前で止まる（outside が壁の中を除く）
          const corner = (uEnd: number, dir: 1 | -1) => {
            const q = f.at(uEnd + dir * (clad / 2), 0, s * (h + clad / 2));
            return !inRoom([q.x, q.z]) && !inWall([q.x, q.z]) ? clad : 0;
          };
          if (u0 < 0.5) u0 -= corner(u0, -1);
          if (u1 > len - 0.5) u1 += corner(u1, 1);
          const du = u1 - u0;
          const dv = v1 - v0;
          if (du < 1) continue;
          const lo = s > 0 ? h : -h - clad;
          const hi = s > 0 ? h + clad : -h;
          const outer = s > 0 ? hi : lo;
          // 外の面
          if (s > 0) wallBuilder.quad(f.at(u0, v0, outer), f.D.clone().multiplyScalar(du), Y.clone().multiplyScalar(dv), [u0, v0], [du, dv]);
          else wallBuilder.quad(f.at(u1, v0, outer), f.D.clone().multiplyScalar(-du), Y.clone().multiplyScalar(dv), [-u1, v0], [du, dv]);
          const n = f.N.clone().multiplyScalar(hi - lo);
          // 端の面（開口部の外側の見込み・壁の切れ目）
          wallBuilder.quad(f.at(u0, v0, lo), n, Y.clone().multiplyScalar(dv), [0, v0], [clad, dv]);
          wallBuilder.quad(f.at(u1, v0, lo), Y.clone().multiplyScalar(dv), n, [v0, 0], [dv, clad]);
          // 上面（窓の下）・下面（開口部の上・張り出しの下端）
          if (v1 < wallTop - 0.5) wallBuilder.quad(f.at(u0, v1, hi), f.D.clone().multiplyScalar(du), n.clone().negate(), [u0, 0], [du, clad]);
          if (v0 > cladBottom + 0.5 || index > 0) wallBuilder.quad(f.at(u0, v0, lo), f.D.clone().multiplyScalar(du), n, [u0, 0], [du, clad]);
        }
      }
    }
  };
  for (const w of walls) {
    const len0 = dist(w.from, w.to);
    const dir: Point = [(w.to[0] - w.from[0]) / len0, (w.to[1] - w.from[1]) / len0];
    // 角を埋めるため、ほかの壁につながる端は t/2 延ばす。何もつながらない端（開口部に面した壁の切れ目）は延ばさず、端面を描く
    const joinStart = joined(w.from, w);
    const joinEnd = joined(w.to, w);
    const e0 = joinStart ? t / 2 : 0;
    const e1 = joinEnd ? t / 2 : 0;
    const start: Point = [w.from[0] - dir[0] * e0, w.from[1] - dir[1] * e0];
    const len = len0 + e0 + e1;
    const f = new Frame(start, dir);
    const end: Point = [start[0] + dir[0] * len, start[1] + dir[1] * len];
    // 開口部が壁の端まで達しているときは、角を埋めるために延ばした分も一緒に抜く（柱のような切れ端を残さない）
    const spans = openingsOnSegment(floor.openings, start, end, t / 2 + 1).map((s) => ({
      ...s,
      u0: s.u0 <= e0 + 2 ? 0 : s.u0,
      u1: s.u1 >= len - e1 - 2 ? len : s.u1,
    }));
    // 位置 u にある開口部（開口部まわりの面がどの開口部のものか）
    const openingAt = (u: number) => spans.find((s) => u > s.u0 - 2 && u < s.u1 + 2)?.opening.id;
    // 開口部まわりの面が、開口部のどの面か（左右の側面 a・b、上下の面 h）
    const partOf = (u: number, id?: string): JambPart | undefined => {
      const sp = id ? spans.find((s) => s.opening.id === id) : undefined;
      if (!sp) return undefined;
      return u < sp.u0 + 2 ? 'a' : u > sp.u1 - 2 ? 'b' : 'h';
    };
    // 片引き戸の戸袋で削る所（壁の片側の面の穴）
    const holes: Hole[] = [];
    for (const sp of spans) {
      const o = sp.opening;
      const ps = o.slideRoom ? pocketSpan(f, sp, len) : null;
      const room = o.slideRoom ? rooms.find((x) => x.id === o.slideRoom) : undefined;
      if (!ps || !room) continue;
      // 戸のある部屋が壁のどちらの側か（部屋の中心で調べる。戸袋が隣の部屋の前まで続いても同じ側を削る）
      const [cx, cy] = centroid(room.polygon);
      const q = f.at((sp.u0 + sp.u1) / 2, 0, 0);
      holes.push({ s: (cx - q.x) * f.N.x + (cy - q.z) * f.N.z > 0 ? 1 : -1, u0: ps[0], u1: ps[1], v0: o.sill, v1: o.sill + o.height });
    }
    const rects = rectsWithHoles(len, wallBottom, wallTop, spans);
    if (clad > 0) addCladding(f, len, rects);
    for (const r of rects) {
      const drawStart = r.u0 > 0.5 || !joinStart;
      const drawEnd = r.u1 < len - 0.5 || !joinEnd;
      addWallBox(wallBuilder, (u, s, o) => sideBuilder(f, u, s, o, partOf(u, o)), openingAt, f, r, t, wallBottom, wallTop, drawStart, drawEnd, floor.ceilingHeight, holes, (u, s, v) => {
        // その側の部屋に、この高さで天井があるか（天井がない・もっと高いなら下面を描く）
        const p = f.at(u, 0, s * (t / 2 + 20));
        const room = rooms.find((x) => pointInPolygon([p.x, p.z], x.polygon));
        if (!room) return true;
        if (!room.ceiling) return true;
        return (room.level ?? 0) + (room.ceilingHeight ?? floor.ceilingHeight) > v + 1;
      });
    }
  }
  if (!wallBuilder.empty) {
    // 開口部の側面などの壁の厚みの面（隣の壁のクロスで巻き込む）
    for (const { mb, id, openingId, part, sideRoom, capKey } of sideBuilders.values()) {
      if (mb.empty) continue;
      const faces = new THREE.Mesh(mb.geometry(), getMaterial(id, { clip }));
      faces.userData.info = { kind: 'jamb', materialId: id, openingId, part, sideRoom, floor: index, capKey } satisfies SurfaceInfo;
      faces.castShadow = faces.receiveShadow = true;
      group.add(faces);
    }
    const mesh = new THREE.Mesh(wallBuilder.geometry(), getMaterial(floor.exterior ?? plan.exterior, { clip }));
    mesh.userData.info = { kind: 'exterior', materialId: floor.exterior ?? plan.exterior } satisfies SurfaceInfo;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ---- 開口部の枠とガラス ----
  for (const o of floor.openings) {
    const wall = findWall(walls, o.at, t);
    if (!wall) {
      warnings.push(`${where(`開口部「${o.id}」`)}: 位置 (${o.at.join(', ')}) が壁の上にありません`);
      continue;
    }
    const og = buildOpening(o, wall, t, clip);
    // 外に面した窓は外寄りに付ける（半外付けのサッシ: 枠の室内側の面が壁芯のあたり、外側は外壁の面から少し引っ込む）
    if (o.type === 'window' && clad > 0) {
      const len = dist(wall.from, wall.to);
      const nx = -(wall.to[1] - wall.from[1]) / len;
      const ny = (wall.to[0] - wall.from[0]) / len;
      const probe = (s: number): Point => [o.at[0] + nx * s * (t / 2 + clad / 2), o.at[1] + ny * s * (t / 2 + clad / 2)];
      const s = !inRoom(probe(1)) ? 1 : !inRoom(probe(-1)) ? -1 : 0;
      og.position.x += nx * s * WINDOW_SHIFT;
      og.position.z += ny * s * WINDOW_SHIFT;
    }
    og.userData.info = { kind: 'opening', openingId: o.id } satisfies SurfaceInfo;
    group.add(og);
  }

  // ---- 部屋ごとの床・壁クロス・天井 ----
  const floorMeshes: THREE.Mesh[] = [];
  const ceilings: THREE.Mesh[] = [];
  const caps: THREE.Mesh[] = [];
  const labels: CSS2DObject[] = [];
  // 巾木は素材ごと（部屋の baseboard。省略時は黒）
  const baseboards = new Map<string, MeshBuilder>();
  // 片引き戸の戸袋（壁の線・戸袋の範囲・削る側）。戸袋の長さは戸の幅（開口部 + 80）
  const pocketDefs = floor.openings.flatMap((o) => {
    const room = o.slideRoom && o.slideTo ? rooms.find((r) => r.id === o.slideRoom) : undefined;
    if (!room || !o.slideTo) return [];
    const v = SIDE_VEC[o.slideTo];
    const vertical = v[0] === 0;
    const dir = v[0] + v[1];
    const c = vertical ? o.at[1] : o.at[0];
    const start = c + (dir * o.width) / 2;
    const far = start + dir * (o.slideLength ?? o.width + 80);
    const [cx, cy] = centroid(room.polygon);
    const line = vertical ? o.at[0] : o.at[1];
    return [{ o, vertical, line, p0: Math.min(start, far), p1: Math.max(start, far), far, sideSign: Math.sign((vertical ? cx : cy) - line) }];
  });
  for (const room of rooms) {
    checkMaterial(room.floor, `${room.name}の床`);
    checkMaterial(room.wall, `${room.name}の壁`);
    checkMaterial(room.ceiling, `${room.name}の天井`);
    for (const [side, id] of Object.entries(room.accent ?? {})) checkMaterial(id, `${room.name}のアクセント(${side})`);

    const level = room.level ?? 0;
    const top = level + (room.ceilingHeight ?? floor.ceilingHeight);
    // 天井のない部屋（階段の吹き抜けなど）は、壁の仕上げを上の階の床まで張る
    const finishTop = room.ceiling ? top : wallTop;
    const inner = insetPolygon(room.polygon, t / 2);

    // 床。吹き抜けでも、クリックで選べるよう見えない床を置く
    // 床は壁芯まで張る。壁のない所（開口部）で隣の部屋の床と隙間なくつながる
    const floorShape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, -y)));
    const floorMesh: THREE.Mesh = new THREE.Mesh(new THREE.ShapeGeometry(floorShape), getMaterial(room.floor));
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = level;
    floorMesh.receiveShadow = true;
    floorMesh.userData = { roomId: room.id, floorIndex: index, lightHeight: top - 150, info: { kind: 'floor', roomId: room.id, materialId: room.floor } satisfies SurfaceInfo };
    // 見えない床（クリック用）。visible=false でもマウスの当たり判定には使える
    if (room.void) floorMesh.visible = false;
    group.add(floorMesh);
    floorMeshes.push(floorMesh);

    // 床が周りより高い部屋は、段差の側面を埋める（車庫から見たホールの床など）
    if (!room.void && level > wallBottom && index === 0) {
      const outer = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, -y)));
      const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(outer, { depth: level - wallBottom, bevelEnabled: false }), slabMat);
      slab.rotation.x = -Math.PI / 2;
      slab.position.y = wallBottom - 1;
      slab.receiveShadow = true;
      group.add(slab);
    }

    // 2階より上の床の裏（下の階がない所では軒天として外から見える）。下の階の天井より上なので室内からは見えない
    // 床の厚み（300）ぶんの側面も付けて、張り出した所の先端（鼻先）をふさぐ。
    // 外に面する側面は軒天と同じ黒、階段の吹き抜けなど家の中に面する側面は壁クロスにする
    if (!room.void && index > 0) {
      const slabT = 300;
      // 壁の厚みの半分だけ外へ広げて、上の階の外壁の下端もふさぐ
      // 外に面した辺だけ外壁の厚み（clad）まで広げる。家の中（階段の吹き抜けなど）に面した辺は壁の面まで
      const outline = insetPolygon(room.polygon, (i) => {
        const a = room.polygon[i];
        const b = room.polygon[(i + 1) % room.polygon.length];
        const len = dist(a, b);
        const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const n: Point = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        const side = (k: number): Point => [mid[0] + n[0] * k * (t / 2 + 30), mid[1] + n[1] * k * (t / 2 + 30)];
        const out = pointInPolygon(side(1), room.polygon) ? side(-1) : side(1);
        return -(t / 2 + (floor.rooms.some((r) => pointInPolygon(out, r.polygon)) ? 0 : clad));
      });
      const underShape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
      const under = new THREE.Mesh(new THREE.ShapeGeometry(underShape), getMaterial('cross-black'));
      under.rotation.x = Math.PI / 2;
      under.position.y = -slabT;
      under.receiveShadow = true;
      group.add(under);
      const outside = new MeshBuilder();
      const inside = new Map<string, MeshBuilder>();
      const flashing = new MeshBuilder();
      const n = room.polygon.length;
      for (let i = 0; i < n; i++) {
        const a = outline[i];
        const b = outline[(i + 1) % n];
        const len = dist(a, b);
        if (len < 1) continue;
        // 辺の外側の点が、この階の別の部屋の中にあるか（あれば家の中に面している）
        let nx = -(b[1] - a[1]) / len;
        let ny = (b[0] - a[0]) / len;
        const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pointInPolygon([mid[0] + nx * 10, mid[1] + ny * 10], outline)) [nx, ny] = [-nx, -ny];
        const probe: Point = [mid[0] + nx * 10, mid[1] + ny * 10];
        // 家の中に面している（階段の吹き抜けなど）ときは、その部屋の壁のクロスを貼る
        const innerRoom = floor.rooms.find((r) => r.id !== room.id && pointInPolygon(probe, r.polygon));
        // 面の向き（D × Y）が外を向くように始点を選ぶ
        const fwd = new Frame(a, [b[0] - a[0], b[1] - a[1]]);
        const f = fwd.N.x * nx + fwd.N.z * ny > 0 ? fwd : new Frame(b, [a[0] - b[0], a[1] - b[1]]);
        if (innerRoom) {
          const id = innerRoom.wall || 'cross-sp2540';
          const mb = inside.get(id) ?? new MeshBuilder();
          inside.set(id, mb);
          mb.quad(f.at(0, -slabT, 0), f.D.clone().multiplyScalar(len), Y.clone().multiplyScalar(slabT), [0, 0], [len, slabT]);
          continue;
        }
        // 下の階の部屋の真上（下に外壁がある所）は、その外壁が鼻先を隠すので描かない（面が重なってちらつく）。
        // 辺の途中で変わることがあるので 50mm ごとに調べる
        const below = plan.floors[index - 1]?.rooms ?? [];
        const steps = Math.max(1, Math.ceil(len / 50));
        let runStart = -1;
        for (let k = 0; k <= steps; k++) {
          const u = ((k + 0.5) / steps) * len;
          const p: Point = [f.origin[0] + f.D.x * u - nx * (t / 2 + clad + 10), f.origin[1] + f.D.z * u - ny * (t / 2 + clad + 10)];
          const open = k < steps && !below.some((r) => pointInPolygon(p, r.polygon));
          if (open && runStart < 0) runStart = k;
          if (!open && runStart >= 0) {
            const u0 = (runStart / steps) * len;
            const u1 = (k / steps) * len;
            outside.quad(f.at(u0, -slabT, 0), f.D.clone().multiplyScalar(u1 - u0), Y.clone().multiplyScalar(slabT), [u0, 0], [u1 - u0, slabT]);
            // 張り出した所の外壁の下端の水切り（黒い板金。外へ 20 出す）
            flashing.quad(f.at(u0, -12, 20), f.D.clone().multiplyScalar(u1 - u0), Y.clone().multiplyScalar(30), [u0, 0], [u1 - u0, 30]);
            flashing.quad(f.at(u1, 18, 20), f.D.clone().multiplyScalar(-(u1 - u0)), f.N.clone().multiplyScalar(-20), [u0, 0], [u1 - u0, 20]);
            flashing.quad(f.at(u0, -12, 20), f.N.clone().multiplyScalar(-20), f.D.clone().multiplyScalar(u1 - u0), [u0, 0], [u1 - u0, 20]);
            runStart = -1;
          }
        }
      }
      for (const [mb, id] of [[outside, 'cross-black'] as const, ...[...inside].map(([k, v]) => [v, k] as const)]) {
        if (mb.empty) continue;
        const sides = new THREE.Mesh(mb.geometry(), getMaterial(id));
        sides.receiveShadow = true;
        group.add(sides);
      }
      if (!flashing.empty) {
        const fl = new THREE.Mesh(flashing.geometry(), blackMetalBoth);
        fl.castShadow = true;
        group.add(fl);
      }
    }

    if (room.ceiling) {
      // 天井も壁芯まで張る。壁のない所（開口部）で隣の部屋の天井と隙間なくつながる
      const ceilShape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
      const ceiling = new THREE.Mesh(new THREE.ShapeGeometry(ceilShape), getMaterial(room.ceiling));
      ceiling.rotation.x = Math.PI / 2;
      ceiling.position.y = top;
      ceiling.receiveShadow = true;
      ceiling.userData.info = { kind: 'ceiling', roomId: room.id, materialId: room.ceiling } satisfies SurfaceInfo;
      group.add(ceiling);
      ceilings.push(ceiling);

      // 階の上面（屋根、または上の階の床下）。上が吹き抜けの部屋には付けない
      const capShape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, -y)));
      const cap = new THREE.Mesh(new THREE.ShapeGeometry(capShape), roofMat);
      cap.rotation.x = -Math.PI / 2;
      cap.position.y = wallTop - 30;
      cap.receiveShadow = true;
      cap.castShadow = true;
      group.add(cap);
      caps.push(cap);
    }

    // 壁クロス。方角ごとに素材が違うことがあるので、方角ごとにまとめる（見ている面の情報にも使う）
    const finish = insetPolygon(room.polygon, t / 2 + 1);
    const n = room.polygon.length;
    // 外形の向きをそろえたときに逆順にした部屋は、辺の番号を元の polygon の番号に戻す
    const original = floor.rooms.find((r) => r.id === room.id)!.polygon;
    const reversed = signedArea(original) <= 0;
    const edgeIndex = (i: number) => (reversed ? (((n - 2 - i) % n) + n) % n : i);
    // 出隅でない角（部屋の内側から見て 90° の角）では、仕上げを壁の中心線まで延ばす。
    // 隣の部屋と壁なしでつながっている所で、仕上げの切れ目から構造壁が見えないようにするため
    const convex = (k: number) => {
      const [p0, p1, p2] = [room.polygon[(k + n - 1) % n], room.polygon[k], room.polygon[(k + 1) % n]];
      return (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]) > 0;
    };
    for (let i = 0; i < finish.length; i++) {
      const len0 = dist(finish[i], finish[(i + 1) % finish.length]);
      if (len0 < 1) continue;
      const dir: Point = [(finish[(i + 1) % finish.length][0] - finish[i][0]) / len0, (finish[(i + 1) % finish.length][1] - finish[i][1]) / len0];
      // 角の先の辺が、角から始まる通り抜けの開口部のとき（壁の角の先が開口部）は、角を埋めた構造の壁の厚みの分まで仕上げを延ばす
      // （延ばさないと、開口部から構造の壁の外壁の面が細い帯のように見える）
      const passage = (sp: OpeningSpan) => (sp.opening.sill ?? 0) <= (room.level ?? 0) + 1 && sp.opening.height >= 2000 && sp.opening.type !== 'window';
      const openAtCorner = (j: number, atStart: boolean) => {
        const pa = room.polygon[(j + n) % n];
        const pb = room.polygon[(j + 1) % n];
        const l = dist(pa, pb);
        return openingsOnSegment(floor.openings, pa, pb, t / 2 + 5).some((sp) => passage(sp) && (atStart ? sp.u0 < 2 : sp.u1 > l - 2));
      };
      // 点 p に、向き (dx, dz) の壁の本体（開口部でない所）があるか
      const solidAt = (p: Point, dx: number, dz: number) =>
        walls.some((w) => {
          const wl = dist(w.from, w.to);
          if (Math.abs(((w.to[0] - w.from[0]) * dx + (w.to[1] - w.from[1]) * dz) / wl) < 0.99) return false;
          const { u, off } = projectOnLine(p, w.from, w.to);
          if (off > 1 || u < 0 || u > wl) return false;
          return !openingsOnSegment(floor.openings, w.from, w.to, t / 2 + 1).some((sp) => u > sp.u0 - 1 && u < sp.u1 + 1);
        });
      // 角の先（隣の辺の線を角の向こうへ延ばした所）に壁が続いているか。続いていれば、角を埋めた分まで仕上げで覆う
      const wallBeyond = (k: number, j: number, atEnd: boolean) => {
        const pa = room.polygon[(j + n) % n];
        const pb = room.polygon[(j + 1) % n];
        const l = dist(pa, pb);
        const d: Point = [(pb[0] - pa[0]) / l, (pb[1] - pa[1]) / l];
        const c = room.polygon[k % n];
        const sgn = atEnd ? 1 : -1;
        return solidAt([c[0] + d[0] * sgn * (t / 2 + 20), c[1] + d[1] * sgn * (t / 2 + 20)], d[0], d[1]);
      };
      const e0 = convex(i) ? (openAtCorner(i - 1, false) && wallBeyond(i, i - 1, true) ? t + 1 : t / 2 + 1) : 0;
      const e1 = convex((i + 1) % n) ? (openAtCorner(i + 1, true) && wallBeyond(i + 1, i + 1, false) ? t + 1 : t / 2 + 1) : 0;
      const a: Point = [finish[i][0] - dir[0] * e0, finish[i][1] - dir[1] * e0];
      const b: Point = [finish[(i + 1) % finish.length][0] + dir[0] * e1, finish[(i + 1) % finish.length][1] + dir[1] * e1];
      const len = len0 + e0 + e1;
      const side = edgeSide(room.polygon, i);
      const edge = edgeIndex(i);
      const matId = room.edges?.[String(edge)] ?? room.accent?.[side] ?? room.wall;
      const mb = new MeshBuilder();
      const f = new Frame(a, [b[0] - a[0], b[1] - a[1]]);
      // 開口部が辺の端の角（部屋の外形の頂点）まで達しているときは、角で延ばした分（出隅では壁の厚みの半分はみ出す分も）一緒に抜く（仕上げの切れ端が柱のように残らない）。
      // 頂点の手前で終わる開口部は、その先に構造の壁の切れ端が残るので仕上げも残す（抜くと外壁の面が見える）
      const v0 = e0 > 0 ? 0 : t / 2 + 1;
      const v1 = e1 > 0 ? len : len - t / 2 - 1;
      // 開口部の端に、直角の壁が突き当たっているとき（その壁の芯が開口部の端）は、角を埋めた構造の壁の厚みの半分まで仕上げを残す
      const inwardSign = (() => {
        const m0 = f.at(len / 2, 0, 30);
        return pointInPolygon([m0.x, m0.z], room.polygon) ? 1 : -1;
      })();
      const teeAt = (u: number, side: 1 | -1) => {
        const c = f.at(u, 0, -inwardSign * (t / 2 + 1));
        // 開口部と反対の側に、この辺の壁の本体が続いているときだけ（続いていなければ仕上げが宙に飛び出す）
        if (!solidAt([c.x + f.D.x * side * (t / 2 + 20), c.z + f.D.z * side * (t / 2 + 20)], f.D.x, f.D.z)) return false;
        return walls.some((w) => {
          const wd: Point = [w.to[0] - w.from[0], w.to[1] - w.from[1]];
          const wl = Math.hypot(wd[0], wd[1]);
          if (Math.abs((wd[0] * f.D.x + wd[1] * f.D.z) / wl) > 0.1) return false;
          return Math.hypot(w.from[0] - c.x, w.from[1] - c.z) < 3 || Math.hypot(w.to[0] - c.x, w.to[1] - c.z) < 3;
        });
      };
      const spans = openingsOnSegment(floor.openings, a, b, t / 2 + 5).map((sp) => ({
        ...sp,
        u0: sp.u0 <= v0 + 3 ? 0 : teeAt(sp.u0, -1) && passage(sp) ? sp.u0 + t / 2 : sp.u0,
        u1: sp.u1 >= v1 - 3 ? len : teeAt(sp.u1, 1) && passage(sp) ? sp.u1 - t / 2 : sp.u1,
      }));
      // 部屋の内側の向き（巾木を出す側）
      const m = f.at(len / 2, 0, 30);
      const inward = pointInPolygon([m.x, m.z], room.polygon) ? 1 : -1;
      // 片引き戸の戸袋（この部屋の側の壁を削った所）
      const recess = new MeshBuilder();
      const pockets: Hole[] = [];
      // 戸袋は隣の部屋の壁まで続くことがある（シューズクロークの入口など）ので、同じ壁の線で同じ側にある辺なら削る
      const pa = room.polygon[i];
      const pb = room.polygon[(i + 1) % n];
      for (const pd of pocketDefs) {
        const c = pd.vertical ? 0 : 1;
        if (Math.abs(pa[c] - pd.line) > 1 || Math.abs(pb[c] - pd.line) > 1) continue;
        if (Math.sign((pd.vertical ? m.x : m.z) - pd.line) !== pd.sideSign) continue;
        // 戸袋の範囲（壁に沿った座標）を、この仕上げの辺の u に直す
        const k = pd.vertical ? f.D.z : f.D.x;
        const a0 = pd.vertical ? a[1] : a[0];
        const ua = (pd.p0 - a0) * k;
        const ub = (pd.p1 - a0) * k;
        const u0 = Math.max(0, Math.min(ua, ub));
        const u1 = Math.min(len, Math.max(ua, ub));
        if (u1 - u0 < 1) continue;
        const o = pd.o;
        const dep = o.slideDepth ?? 40;
        const [v0, v1] = [o.sill, o.sill + o.height];
        pockets.push({ s: 1, u0, u1, v0, v1 });
        const back = -inward * dep;
        const du = u1 - u0;
        // 面の向きを気にしなくてよいよう、表と裏の 2 枚ずつ張る（素材を複製すると描けないことがあるため）
        const both = (o: THREE.Vector3, p: THREE.Vector3, q: THREE.Vector3, uv: [number, number], size: [number, number]) => {
          recess.quad(o, p, q, uv, size);
          recess.quad(o, q, p, [uv[1], uv[0]], [size[1], size[0]]);
        };
        both(f.at(u0, v0, back), f.D.clone().multiplyScalar(du), Y.clone().multiplyScalar(v1 - v0), [u0, v0], [du, v1 - v0]);
        both(f.at(u0, v1, 0), f.D.clone().multiplyScalar(du), f.N.clone().multiplyScalar(back), [u0, 0], [du, dep]);
        // 戸袋の奥の端（開口部と反対の端がこの辺の中にあれば）
        const farU = (pd.far - a0) * k;
        if (farU > -1 && farU < len + 1) both(f.at(farU, v0, 0), f.N.clone().multiplyScalar(back), Y.clone().multiplyScalar(v1 - v0), [0, v0], [dep, v1 - v0]);
      }
      const finishRects = rectsWithHoles(len, level, finishTop, spans).flatMap((r) => cutRect(r, pockets));
      if (!recess.empty) {
        const rm = new THREE.Mesh(recess.geometry(), getMaterial(matId, { clip }));
        rm.receiveShadow = true;
        rm.userData.info = { kind: 'wall', roomId: room.id, materialId: matId, side, edge } satisfies SurfaceInfo;
        group.add(rm);
      }
      // 壁の一部だけ別のクロスを貼る所（ゾーン）。辺の上の範囲 [u0, u1]、高さの範囲 [v0, v1]
      const zoneDefs = (room.zones ?? [])
        .filter((z) => z.edge === edge)
        .map((z) => {
          const p0 = projectOnLine(z.start, a, b).u;
          const p1 = projectOnLine(z.end, a, b).u;
          const v0 = z.bottom !== undefined ? level + z.bottom : -Infinity;
          const v1 = z.top !== undefined ? level + z.top : Infinity;
          return { z, u0: Math.min(p0, p1), u1: Math.max(p0, p1), v0, v1, mb: new MeshBuilder() };
        });
      // ゾーンの高さの境で、仕上げの四角を横の帯に分ける
      const bands = finishRects.flatMap((r0) => {
        const cuts = [r0.v0, r0.v1, ...zoneDefs.flatMap((zd) => [zd.v0, zd.v1]).filter((v) => v > r0.v0 + 1 && v < r0.v1 - 1)].sort((p, q) => p - q);
        const out: typeof finishRects = [];
        for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] - cuts[i] > 0.5) out.push({ ...r0, v0: cuts[i], v1: cuts[i + 1] });
        return out;
      });
      for (const r of bands) {
        let segs: [number, number][] = [[r.u0, r.u1]];
        for (const zd of zoneDefs) {
          if (zd.v0 > r.v0 + 0.5 || zd.v1 < r.v1 - 0.5) continue;
          const next: [number, number][] = [];
          for (const [s0, s1] of segs) {
            const o0 = Math.max(s0, zd.u0);
            const o1 = Math.min(s1, zd.u1);
            if (o1 - o0 < 1) {
              next.push([s0, s1]);
              continue;
            }
            zd.mb.quad(f.at(o0, r.v0, 0), f.D.clone().multiplyScalar(o1 - o0), Y.clone().multiplyScalar(r.v1 - r.v0), [o0, r.v0], [o1 - o0, r.v1 - r.v0]);
            if (o0 - s0 > 1) next.push([s0, o0]);
            if (s1 - o1 > 1) next.push([o1, s1]);
          }
          segs = next;
        }
        for (const [s0, s1] of segs) mb.quad(f.at(s0, r.v0, 0), f.D.clone().multiplyScalar(s1 - s0), Y.clone().multiplyScalar(r.v1 - r.v0), [s0, r.v0], [s1 - s0, r.v1 - r.v0]);
        // 巾木（床に接する所だけ。高さ 60・出 8）
        if (!room.noBaseboard && !room.void && Math.abs(r.v0 - level) < 1) {
          const bbId = room.baseboard ?? 'baseboard-black';
          if (!baseboards.has(bbId)) baseboards.set(bbId, new MeshBuilder());
          const baseboard = baseboards.get(bbId)!;
          const du = f.D.clone().multiplyScalar(r.u1 - r.u0);
          baseboard.quad(f.at(r.u0, level, inward * BASEBOARD_T), du, Y.clone().multiplyScalar(BASEBOARD_H), [r.u0, 0], [r.u1 - r.u0, BASEBOARD_H]);
          baseboard.quad(f.at(r.u0, level + BASEBOARD_H, 0), du, f.N.clone().multiplyScalar(inward * BASEBOARD_T), [r.u0, 0], [r.u1 - r.u0, BASEBOARD_T]);
        }
      }
      for (const zd of zoneDefs) {
        if (zd.mb.empty) continue;
        checkMaterial(zd.z.material, `${room.name}の${zd.z.name}`);
        const zm = new THREE.Mesh(zd.mb.geometry(), getMaterial(zd.z.material, { clip }));
        zm.receiveShadow = true;
        zm.userData.info = { kind: 'wall', roomId: room.id, materialId: zd.z.material, side, edge, zone: zd.z.id } satisfies SurfaceInfo;
        group.add(zm);
      }
      if (mb.empty) continue;
      const mesh = new THREE.Mesh(mb.geometry(), getMaterial(matId, { clip }));
      mesh.receiveShadow = true;
      mesh.userData.info = { kind: 'wall', roomId: room.id, materialId: matId, side, edge } satisfies SurfaceInfo;
      group.add(mesh);
    }

    if (room.noLabel) continue;
    const [cx, cy] = centroid(inner);
    const areaM2 = Math.abs(signedArea(room.polygon)) / 1e6;
    const el = document.createElement('div');
    el.className = 'room-label';
    el.innerHTML = `<b>${escapeHtml(room.name)}</b><span>${(areaM2 / 1.62).toFixed(1)}帖</span>`;
    const label = new CSS2DObject(el);
    label.position.set(cx, level + 50, cy);
    group.add(label);
    labels.push(label);
  }

  for (const [id, baseboard] of baseboards) {
    if (baseboard.empty) continue;
    const mat = getMaterial(id, { clip });
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(baseboard.geometry(), mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ---- 引き戸の縦枠（戸先の側） ----
  // 引き戸でも、戸が閉まって当たる側（戸先）には縦枠が付く（LIXIL ラフィス 上吊引戸 ライン枠の取付け説明書: 縦枠に戸じゃくり、戸当たりを接着）。
  // 開口部の戸袋と反対の端に、壁の厚みいっぱいの縦枠（開口の中へ 25）と、真ん中に戸先が入る溝（戸じゃくり）を描く（2026-10-25）
  for (const o of floor.openings) {
    if (!o.slideTo) continue;
    const v = SIDE_VEC[o.slideTo];
    const FRAME = 25;
    // 戸先の側の端から、開口の中へ FRAME の所まで
    const ex = o.at[0] - v[0] * (o.width / 2 - FRAME / 2);
    const ez = o.at[1] - v[1] * (o.width / 2 - FRAME / 2);
    const door = floor.furniture.find((f) => ['sliding-door', 'mirror-sliding-door', 'mirror-sheet-door'].includes(f.type) && Math.hypot(f.x - o.at[0], f.y - o.at[1]) < o.width);
    // ラフィスの引き戸の戸当たり（縦枠）は開き戸と同じく白（標準）か黒（+2,000 円・frame: 'black'）。フルハイトドア fit（ミラー引き戸）は戸の色
    const mat =
      door?.type === 'mirror-sliding-door'
        ? new THREE.MeshStandardMaterial({ color: door.color, roughness: 0.6, clippingPlanes: clip })
        : (o.frame === 'black' ? frameBlack : frameWhite).clone();
    mat.clippingPlanes = clip;
    const along = Math.abs(v[0]) > 0.5 ? 'x' : 'z';
    const sx = along === 'x' ? FRAME : t + 2;
    const sz = along === 'x' ? t + 2 : FRAME;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(sx, o.height, sz), mat);
    frame.position.set(ex, o.sill + o.height / 2, ez);
    frame.castShadow = frame.receiveShadow = true;
    group.add(frame);
    // 戸じゃくり（戸先が入る溝。幅 40・深さ 12）
    const groove = new THREE.Mesh(
      new THREE.BoxGeometry(along === 'x' ? 2 : 40, o.height - 20, along === 'x' ? 40 : 2),
      new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.8, clippingPlanes: clip }),
    );
    groove.position.set(ex + v[0] * (FRAME / 2 + 0.6), o.sill + o.height / 2, ez + v[1] * (FRAME / 2 + 0.6));
    group.add(groove);
  }

  // ---- 家具 ----
  for (const f of floor.furniture) {
    if (getFurnitureType(f.type).type !== f.type) warnings.push(`${where(`家具「${f.name}」`)}: 種類「${f.type}」が見つかりません（箱で表示）`);
    const g = buildFurniture(f);
    g.userData.floorIndex = index;
    group.add(g);
    furnitureOut.set(f.id, g);
  }

  return { group, floorMeshes, ceilings, caps, labels };
}

/**
 * 壁の箱。両側の面は mb（外壁の素材）。開口部まわり・壁の切れ目の厚みの面は、真ん中で分けて side(u, ±1) の側の仕上げに入れる。
 * drawStart / drawEnd: 端面を描くか（開口部に面する端・壁の切れ目だけ。壁どうしの角の端面は隣の壁と重なってちらつくので描かない）
 */
const noSoffit = () => false;

function addWallBox(mb: MeshBuilder, side: (u: number, s: 1 | -1, openingId?: string) => MeshBuilder, openingAt: (u: number) => string | undefined, f: Frame, r: Rect, t: number, bottom: number, top: number, drawStart: boolean, drawEnd: boolean, ceiling: number, holes: Hole[] = [], needSoffit: (u: number, s: 1 | -1, v: number) => boolean = noSoffit) {
  const du = r.u1 - r.u0;
  const dv = r.v1 - r.v0;
  const D = f.D;
  const N = f.N;
  const h = t / 2;
  const along = D.clone().multiplyScalar(du);
  const up = Y.clone().multiplyScalar(dv);
  const nHalf = N.clone().multiplyScalar(h);
  const nHalfNeg = N.clone().multiplyScalar(-h);
  const mid = (r.u0 + r.u1) / 2;
  // 両側の面（片引き戸の戸袋で削る所は抜く）
  for (const q of cutRect(r, holes.filter((x) => x.s === 1))) mb.quad(f.at(q.u0, q.v0, h), D.clone().multiplyScalar(q.u1 - q.u0), Y.clone().multiplyScalar(q.v1 - q.v0), [q.u0, q.v0], [q.u1 - q.u0, q.v1 - q.v0]);
  for (const q of cutRect(r, holes.filter((x) => x.s === -1))) mb.quad(f.at(q.u1, q.v0, -h), D.clone().multiplyScalar(-(q.u1 - q.u0)), Y.clone().multiplyScalar(q.v1 - q.v0), [-q.u1, q.v0], [q.u1 - q.u0, q.v1 - q.v0]);
  // 上面・下面（壁の上端・下端の面は見えないので省く）
  // 床の高さ以下で終わる部分（掃き出しの開口部の下）は床でふさがるので上面を描かない
  if (r.v1 < top && r.v1 > 0) {
    const o = openingAt(mid);
    side(mid, 1, o).quad(f.at(r.u0, r.v1, h), along, nHalfNeg, [r.u0, 0], [du, h]);
    side(mid, -1, o).quad(f.at(r.u0, r.v1, 0), along, nHalfNeg, [r.u0, h], [du, h]);
  }
  // 開口部の上の壁の下面は、その側の部屋の天井と同じ高さならふさがるので描かない（その側の部屋で判断する）。
  // 天井がない側（階段の吹き抜けなど）や天井がもっと高い側は、描かないと壁の中が見えるので描く。
  // 階の天井高だけで決めていたときは、下がり天井の部屋（3 階トイレの北の半分）で天井と下面が重なってちらついた（2026-10-25）
  if (r.v0 > bottom) {
    const o = openingAt(mid);
    const need = (s: 1 | -1) => (needSoffit === noSoffit ? r.v0 < ceiling - 1 : needSoffit(mid, s, r.v0));
    if (need(-1)) side(mid, -1, o).quad(f.at(r.u0, r.v0, -h), along, nHalf, [r.u0, 0], [du, h]);
    if (need(1)) side(mid, 1, o).quad(f.at(r.u0, r.v0, 0), along, nHalf, [r.u0, h], [du, h]);
  }
  // 端面（開口部の側面・壁の切れ目）。隣の壁の位置（端から 30 内側）で両側の仕上げを調べる
  if (drawStart) {
    const u = Math.min(r.u0 + 30, mid);
    const o = openingAt(r.u0 - 3);
    side(u, -1, o).quad(f.at(r.u0, r.v0, -h), nHalf, up, [0, r.v0], [h, dv]);
    side(u, 1, o).quad(f.at(r.u0, r.v0, 0), nHalf, up, [h, r.v0], [h, dv]);
  }
  if (drawEnd) {
    const u = Math.max(r.u1 - 30, mid);
    const o = openingAt(r.u1 + 3);
    side(u, -1, o).quad(f.at(r.u1, r.v0, -h), up, nHalf, [r.v0, 0], [dv, h]);
    side(u, 1, o).quad(f.at(r.u1, r.v0, 0), up, nHalf, [r.v0, h], [dv, h]);
  }
}

function findWall(walls: WallSegment[], p: Point, t: number): WallSegment | undefined {
  return walls.find((w) => {
    const { u, off } = projectOnLine(p, w.from, w.to);
    return off <= t / 2 + 1 && u >= -1 && u <= dist(w.from, w.to) + 1;
  });
}

/** 窓（サッシ）を壁芯から外へずらす量。サッシの見込み 70 の真ん中が 35 外 = 室内側の面が壁芯 */
const WINDOW_SHIFT = 35;

// 開口部ごとに clone して使う元の材質
const frameWhite = new THREE.MeshStandardMaterial({ color: '#f2f1ee', roughness: 0.5 });
const frameBlack = new THREE.MeshStandardMaterial({ color: '#262627', roughness: 0.5 });
const sashBase = new THREE.MeshStandardMaterial({ color: '#3a3b3d', roughness: 0.4, metalness: 0.3 });
const glassMat = new THREE.MeshPhysicalMaterial({
  color: '#cfe3ea',
  roughness: 0.05,
  transmission: 0,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function buildOpening(o: Floor['openings'][number], wall: WallSegment, t: number, clip: THREE.Plane[]): THREE.Group {
  const g = new THREE.Group();
  const dx = wall.to[0] - wall.from[0];
  const dy = wall.to[1] - wall.from[1];
  g.position.set(o.at[0], o.sill, o.at[1]);
  g.rotation.y = -Math.atan2(dy, dx);
  const mats = new Map<THREE.Material, THREE.Material>();
  const clipped = (m: THREE.Material) => {
    let c = mats.get(m);
    if (!c) {
      c = m.clone();
      c.clippingPlanes = clip;
      mats.set(m, c);
    }
    return c;
  };
  const add = (w: number, h: number, d: number, x: number, y: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), clipped(mat));
    m.position.set(x, y, 0);
    m.castShadow = mat !== glassMat;
    g.add(m);
  };
  const { width: W, height: Hh } = o;
  if (o.type === 'door') {
    // 室内ドアの枠（frame: 'black' で黒）。LIXIL ラフィスのライン枠は見付 6mm
    const fw = 6;
    const frameMat = o.frame === 'black' ? frameBlack : frameWhite;
    // frame: 'none' は枠の見えないドア。'calm' は KAMIYA CALM: 壁の面にそろう細い縦枠（タイト材の当たり）と、天井の上枠。色は扉に合わせる
    if (o.frame === 'calm') {
      const cm = new THREE.MeshStandardMaterial({ color: o.frameColor ?? '#969698', roughness: 0.55 });
      const cw = 20;
      add(cw, Hh, t + 2, -W / 2 + cw / 2, Hh / 2, cm);
      add(cw, Hh, t + 2, W / 2 - cw / 2, Hh / 2, cm);
      add(W, 25, t + 2, 0, Hh - 12.5, cm);
    } else if (o.frame !== 'none') {
      add(fw, Hh, t + 16, -W / 2 + fw / 2, Hh / 2, frameMat);
      add(fw, Hh, t + 16, W / 2 - fw / 2, Hh / 2, frameMat);
      add(W, fw, t + 16, 0, Hh - fw / 2, frameMat);
    }
  } else if (o.type === 'window') {
    const fw = 40;
    const depth = 70;
    // サッシの色（sashColor。白など）。省略時はダークグレー
    const sashMat = o.sashColor ? new THREE.MeshStandardMaterial({ color: o.sashColor, roughness: 0.45, metalness: 0.1 }) : sashBase;
    add(fw, Hh, depth, -W / 2 + fw / 2, Hh / 2, sashMat);
    add(fw, Hh, depth, W / 2 - fw / 2, Hh / 2, sashMat);
    add(W, fw, depth, 0, Hh - fw / 2, sashMat);
    add(W, fw, depth, 0, fw / 2, sashMat);
    if (o.style === 'fix') {
      // FIX 窓（開かない）: 枠とガラスだけ
    } else if (W > Hh) {
      // 横長の窓は横すべり出し窓: 1 枚の障子（内側の枠）と、下の真ん中の取手
      const sw = 28;
      add(sw, Hh - fw * 2, 40, -W / 2 + fw + sw / 2, Hh / 2, sashMat);
      add(sw, Hh - fw * 2, 40, W / 2 - fw - sw / 2, Hh / 2, sashMat);
      add(W - fw * 2, sw, 40, 0, Hh - fw - sw / 2, sashMat);
      add(W - fw * 2, sw, 40, 0, fw + sw / 2, sashMat);
      add(110, 18, depth + 40, 0, fw + sw + 9, sashMat);
    } else if (W > 1200) {
      add(fw, Hh, depth, 0, Hh / 2, sashMat); // 引き違いの召し合わせ
    }
    add(W - fw * 2, Hh - fw * 2, 6, 0, Hh / 2, glassMat);
  }
  return g;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
