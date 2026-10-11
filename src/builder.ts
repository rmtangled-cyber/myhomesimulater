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
  openingsOnSegment,
  projectOnLine,
  signedArea,
  type OpeningSpan,
  type WallSegment,
} from './geometry';
import { buildFurniture, getFurnitureType } from './furniture';
import { getMaterial, getMaterialDef } from './materials';
import type { Plan, Point, Room } from './types';

export interface BuiltPlan {
  root: THREE.Group;
  /** 部屋の床（クリックで部屋を選ぶのに使う） */
  floors: THREE.Mesh[];
  ceilings: THREE.Mesh[];
  furniture: Map<string, THREE.Group>;
  labels: CSS2DObject[];
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

/** 長さ len・高さ height の面から開口部をくり抜き、残りを長方形の集まりで返す。 */
function rectsWithHoles(len: number, height: number, spans: OpeningSpan[]): Rect[] {
  const rects: Rect[] = [];
  let u = 0;
  for (const s of spans) {
    if (s.u0 > u) rects.push({ u0: u, u1: s.u0, v0: 0, v1: height });
    const top = Math.min(height, s.opening.sill + s.opening.height);
    if (s.opening.sill > 0) rects.push({ u0: s.u0, u1: s.u1, v0: 0, v1: s.opening.sill });
    if (top < height) rects.push({ u0: s.u0, u1: s.u1, v0: top, v1: height });
    u = Math.max(u, s.u1);
  }
  if (u < len) rects.push({ u0: u, u1: len, v0: 0, v1: height });
  return rects.filter((r) => r.u1 - r.u0 > 0.5 && r.v1 - r.v0 > 0.5);
}

export function buildPlan(plan: Plan, clip: THREE.Plane[]): BuiltPlan {
  const root = new THREE.Group();
  const warnings: string[] = [];
  const t = plan.wallThickness;
  const H = plan.ceilingHeight;

  const checkMaterial = (id: string, where: string) => {
    if (!getMaterialDef(id)) warnings.push(`${where}: 素材ID「${id}」が見つかりません（マゼンタで表示）`);
  };

  // 部屋の外形は面積が正の向きにそろえる（内側の向きを決めるため）
  const rooms: Room[] = plan.rooms.map((r) => ({
    ...r,
    polygon: signedArea(r.polygon) > 0 ? r.polygon : [...r.polygon].reverse(),
  }));

  // ---- 構造壁（外壁の素材で作り、室内側は仕上げ面で覆う） ----
  checkMaterial(plan.exterior, '外壁');
  const walls = deriveWalls(rooms);
  const wallBuilder = new MeshBuilder();
  for (const w of walls) {
    const len0 = dist(w.from, w.to);
    const dir: Point = [(w.to[0] - w.from[0]) / len0, (w.to[1] - w.from[1]) / len0];
    // 角を埋めるため両端を t/2 ずつ延ばす
    const start: Point = [w.from[0] - (dir[0] * t) / 2, w.from[1] - (dir[1] * t) / 2];
    const len = len0 + t;
    const f = new Frame(start, dir);
    const end: Point = [start[0] + dir[0] * len, start[1] + dir[1] * len];
    const spans = openingsOnSegment(plan.openings, start, end, t / 2 + 1);
    for (const r of rectsWithHoles(len, H, spans)) addWallBox(wallBuilder, f, r, t, H);
  }
  if (!wallBuilder.empty) {
    const mesh = new THREE.Mesh(wallBuilder.geometry(), getMaterial(plan.exterior, { clip }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // ---- 開口部の枠とガラス ----
  for (const o of plan.openings) {
    const wall = findWall(walls, o.at, t);
    if (!wall) {
      warnings.push(`開口部「${o.id}」: 位置 (${o.at.join(', ')}) が壁の上にありません`);
      continue;
    }
    root.add(buildOpening(o, wall, t, clip));
  }

  // ---- 部屋ごとの床・壁クロス・天井 ----
  const floors: THREE.Mesh[] = [];
  const ceilings: THREE.Mesh[] = [];
  const labels: CSS2DObject[] = [];
  for (const room of rooms) {
    checkMaterial(room.floor, `${room.name}の床`);
    checkMaterial(room.wall, `${room.name}の壁`);
    checkMaterial(room.ceiling, `${room.name}の天井`);
    for (const [side, id] of Object.entries(room.accent ?? {})) checkMaterial(id, `${room.name}のアクセント(${side})`);

    const inner = insetPolygon(room.polygon, t / 2);

    const floorShape = new THREE.Shape(inner.map(([x, y]) => new THREE.Vector2(x, -y)));
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(floorShape), getMaterial(room.floor));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.roomId = room.id;
    root.add(floor);
    floors.push(floor);

    const ceilShape = new THREE.Shape(inner.map(([x, y]) => new THREE.Vector2(x, y)));
    const ceiling = new THREE.Mesh(new THREE.ShapeGeometry(ceilShape), getMaterial(room.ceiling));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = H;
    ceiling.receiveShadow = true;
    root.add(ceiling);
    ceilings.push(ceiling);

    // 壁クロス。方角ごとに素材が違うことがあるので素材別にまとめる
    const finish = insetPolygon(room.polygon, t / 2 + 1);
    const bySide = new Map<string, MeshBuilder>();
    for (let i = 0; i < finish.length; i++) {
      const a = finish[i];
      const b = finish[(i + 1) % finish.length];
      const len = dist(a, b);
      if (len < 1) continue;
      const matId = room.accent?.[edgeSide(room.polygon, i)] ?? room.wall;
      const mb = bySide.get(matId) ?? new MeshBuilder();
      bySide.set(matId, mb);
      const f = new Frame(a, [b[0] - a[0], b[1] - a[1]]);
      const spans = openingsOnSegment(plan.openings, a, b, t / 2 + 5);
      for (const r of rectsWithHoles(len, H, spans)) {
        mb.quad(f.at(r.u0, r.v0, 0), f.D.clone().multiplyScalar(r.u1 - r.u0), Y.clone().multiplyScalar(r.v1 - r.v0), [r.u0, r.v0], [r.u1 - r.u0, r.v1 - r.v0]);
      }
    }
    for (const [matId, mb] of bySide) {
      const mesh = new THREE.Mesh(mb.geometry(), getMaterial(matId, { clip }));
      mesh.receiveShadow = true;
      root.add(mesh);
    }

    const [cx, cy] = centroid(inner);
    const areaM2 = Math.abs(signedArea(room.polygon)) / 1e6;
    const el = document.createElement('div');
    el.className = 'room-label';
    el.innerHTML = `<b>${escapeHtml(room.name)}</b><span>${(areaM2 / 1.62).toFixed(1)}帖</span>`;
    const label = new CSS2DObject(el);
    label.position.set(cx, 50, cy);
    root.add(label);
    labels.push(label);
  }

  // ---- 家具 ----
  const furniture = new Map<string, THREE.Group>();
  for (const f of plan.furniture) {
    if (getFurnitureType(f.type).type !== f.type) warnings.push(`家具「${f.name}」: 種類「${f.type}」が見つかりません（箱で表示）`);
    const g = buildFurniture(f);
    root.add(g);
    furniture.set(f.id, g);
  }

  const bounds = new THREE.Box3();
  for (const r of rooms) for (const [x, y] of r.polygon) bounds.expandByPoint(new THREE.Vector3(x, 0, y));
  bounds.expandByPoint(new THREE.Vector3(bounds.min.x, H, bounds.min.z));

  return { root, floors, ceilings, furniture, labels, warnings, bounds };
}

function addWallBox(mb: MeshBuilder, f: Frame, r: Rect, t: number, H: number) {
  const du = r.u1 - r.u0;
  const dv = r.v1 - r.v0;
  const D = f.D;
  const N = f.N;
  const along = D.clone().multiplyScalar(du);
  const up = Y.clone().multiplyScalar(dv);
  const back = D.clone().multiplyScalar(-du);
  // 両側の面
  mb.quad(f.at(r.u0, r.v0, t / 2), along, up, [r.u0, r.v0], [du, dv]);
  mb.quad(f.at(r.u1, r.v0, -t / 2), back, up, [-r.u1, r.v0], [du, dv]);
  // 上面・下面（床と天井の位置にある面は見えないので省く）
  if (r.v1 < H) mb.quad(f.at(r.u0, r.v1, t / 2), along, N.clone().multiplyScalar(-t), [r.u0, 0], [du, t]);
  if (r.v0 > 0) mb.quad(f.at(r.u0, r.v0, -t / 2), along, N.clone().multiplyScalar(t), [r.u0, 0], [du, t]);
  // 端面（開口部の側面になる）
  mb.quad(f.at(r.u0, r.v0, -t / 2), N.clone().multiplyScalar(t), up, [0, r.v0], [t, dv]);
  mb.quad(f.at(r.u1, r.v0, -t / 2), up, N.clone().multiplyScalar(t), [r.v0, 0], [dv, t]);
}

function findWall(walls: WallSegment[], p: Point, t: number): WallSegment | undefined {
  return walls.find((w) => {
    const { u, off } = projectOnLine(p, w.from, w.to);
    return off <= t / 2 + 1 && u >= -1 && u <= dist(w.from, w.to) + 1;
  });
}

// 開口部ごとに clone して使う元の材質
const frameMat = new THREE.MeshStandardMaterial({ color: '#f2f1ee', roughness: 0.5 });
const sashMat = new THREE.MeshStandardMaterial({ color: '#3a3b3d', roughness: 0.4, metalness: 0.3 });
const glassMat = new THREE.MeshPhysicalMaterial({
  color: '#cfe3ea',
  roughness: 0.05,
  transmission: 0,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
  side: THREE.DoubleSide,
});

function buildOpening(o: Plan['openings'][number], wall: WallSegment, t: number, clip: THREE.Plane[]): THREE.Group {
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
    // 室内ドアの枠
    const fw = 30;
    add(fw, Hh, t + 16, -W / 2 + fw / 2, Hh / 2, frameMat);
    add(fw, Hh, t + 16, W / 2 - fw / 2, Hh / 2, frameMat);
    add(W, fw, t + 16, 0, Hh - fw / 2, frameMat);
  } else if (o.type === 'window') {
    const fw = 40;
    const depth = 70;
    add(fw, Hh, depth, -W / 2 + fw / 2, Hh / 2, sashMat);
    add(fw, Hh, depth, W / 2 - fw / 2, Hh / 2, sashMat);
    add(W, fw, depth, 0, Hh - fw / 2, sashMat);
    add(W, fw, depth, 0, fw / 2, sashMat);
    if (W > 1200) add(fw, Hh, depth, 0, Hh / 2, sashMat); // 引き違いの召し合わせ
    add(W - fw * 2, Hh - fw * 2, 6, 0, Hh / 2, glassMat);
  }
  return g;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
