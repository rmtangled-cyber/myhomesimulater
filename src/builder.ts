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
import type { Floor, Plan, Point, Room, Side } from './types';

/** ウォークスルーで「見ているもの」を出すため、面に付けておく情報 */
export type SurfaceInfo =
  | { kind: 'wall'; roomId: string; materialId: string; side: Side; edge: number }
  | { kind: 'floor' | 'ceiling'; roomId: string; materialId: string }
  | { kind: 'exterior'; materialId: string }
  | { kind: 'opening'; openingId: string }
  | { kind: 'jamb'; materialId?: string; openingId?: string };

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
function pocketSpan(f: Frame, s: { u0: number; u1: number; opening: { slideTo?: Side } }, len: number): [number, number] | null {
  if (!s.opening.slideTo) return null;
  const v = SIDE_VEC[s.opening.slideTo];
  const along = v[0] * f.D.x + v[1] * f.D.z;
  if (Math.abs(along) < 0.5) return null;
  const w = s.u1 - s.u0 + 80;
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
slabMat.userData.shared = roofMat.userData.shared = true;

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
    built.group.position.y = floor.elevation;
    root.add(built.group);
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

  // ---- 構造壁（外壁の素材で作り、室内側は仕上げ面で覆う） ----
  const walls = deriveWalls(rooms);
  const wallBuilder = new MeshBuilder();
  // 壁の端に、ほかの壁（開口部で抜けていない所）がつながっているか。
  // つながる壁が端のすぐ横（壁の厚みの半分以内）で開口部になっているときは、延ばすと開口部の中に切れ端（柱のような物）が出るので、つながっていないことにする
  const joined = (p: Point, self: WallSegment) =>
    walls.some((w2) => {
      if (w2 === self) return false;
      const len2 = dist(w2.from, w2.to);
      const { u, off } = projectOnLine(p, w2.from, w2.to);
      if (off > 1 || u < -1 || u > len2 + 1) return false;
      return !openingsOnSegment(floor.openings, w2.from, w2.to, t / 2 + 1).some((s) => u > s.u0 - t / 2 - 1 && u < s.u1 + t / 2 + 1);
    });
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
  const sideBuilders = new Map<string, { mb: MeshBuilder; id: string; openingId?: string }>();
  /** 壁 f の位置 u で、s の側（+1 = N の側）の仕上げを入れる先。開口部まわりの面で、開口部にクロスの指定があればそれを貼る */
  const sideBuilder = (f: Frame, u: number, s: 1 | -1, openingId?: string): MeshBuilder => {
    const p = f.at(u, 0, s * (t / 2 + 20));
    const own = openingId ? floor.openings.find((o) => o.id === openingId)?.jamb : undefined;
    const id = own ?? finishAt([p.x, p.z]) ?? exteriorId;
    const key = `${id}|${openingId ?? ''}`;
    const entry = sideBuilders.get(key) ?? { mb: new MeshBuilder(), id, openingId };
    sideBuilders.set(key, entry);
    return entry.mb;
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
    for (const r of rectsWithHoles(len, wallBottom, wallTop, spans)) {
      const drawStart = r.u0 > 0.5 || !joinStart;
      const drawEnd = r.u1 < len - 0.5 || !joinEnd;
      addWallBox(wallBuilder, (u, s, o) => sideBuilder(f, u, s, o), openingAt, f, r, t, wallBottom, wallTop, drawStart, drawEnd, floor.ceilingHeight, holes);
    }
  }
  if (!wallBuilder.empty) {
    // 開口部の側面などの壁の厚みの面（隣の壁のクロスで巻き込む）
    for (const { mb, id, openingId } of sideBuilders.values()) {
      if (mb.empty) continue;
      const faces = new THREE.Mesh(mb.geometry(), getMaterial(id, { clip }));
      faces.userData.info = { kind: 'jamb', materialId: id, openingId } satisfies SurfaceInfo;
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
    og.userData.info = { kind: 'opening', openingId: o.id } satisfies SurfaceInfo;
    group.add(og);
  }

  // ---- 部屋ごとの床・壁クロス・天井 ----
  const floorMeshes: THREE.Mesh[] = [];
  const ceilings: THREE.Mesh[] = [];
  const caps: THREE.Mesh[] = [];
  const labels: CSS2DObject[] = [];
  const baseboard = new MeshBuilder();
  // 片引き戸の戸袋（壁の線・戸袋の範囲・削る側）。戸袋の長さは戸の幅（開口部 + 80）
  const pocketDefs = floor.openings.flatMap((o) => {
    const room = o.slideRoom && o.slideTo ? rooms.find((r) => r.id === o.slideRoom) : undefined;
    if (!room || !o.slideTo) return [];
    const v = SIDE_VEC[o.slideTo];
    const vertical = v[0] === 0;
    const dir = v[0] + v[1];
    const c = vertical ? o.at[1] : o.at[0];
    const start = c + (dir * o.width) / 2;
    const far = start + dir * (o.width + 80);
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
      const outline = insetPolygon(room.polygon, -t / 2);
      const underShape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
      const under = new THREE.Mesh(new THREE.ShapeGeometry(underShape), getMaterial('cross-black'));
      under.rotation.x = Math.PI / 2;
      under.position.y = -slabT;
      under.receiveShadow = true;
      group.add(under);
      const outside = new MeshBuilder();
      const inside = new MeshBuilder();
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
        const inner = floor.rooms.some((r) => r.id !== room.id && pointInPolygon(probe, r.polygon));
        // 面の向き（D × Y）が外を向くように始点を選ぶ
        const fwd = new Frame(a, [b[0] - a[0], b[1] - a[1]]);
        const f = fwd.N.x * nx + fwd.N.z * ny > 0 ? fwd : new Frame(b, [a[0] - b[0], a[1] - b[1]]);
        if (inner) {
          inside.quad(f.at(0, -slabT, 0), f.D.clone().multiplyScalar(len), Y.clone().multiplyScalar(slabT), [0, 0], [len, slabT]);
          continue;
        }
        // 下の階の部屋の真上（下に外壁がある所）は、その外壁が鼻先を隠すので描かない（面が重なってちらつく）。
        // 辺の途中で変わることがあるので 50mm ごとに調べる
        const below = plan.floors[index - 1]?.rooms ?? [];
        const steps = Math.max(1, Math.ceil(len / 50));
        let runStart = -1;
        for (let k = 0; k <= steps; k++) {
          const u = ((k + 0.5) / steps) * len;
          const p: Point = [f.origin[0] + f.D.x * u - nx * (t / 2 + 10), f.origin[1] + f.D.z * u - ny * (t / 2 + 10)];
          const open = k < steps && !below.some((r) => pointInPolygon(p, r.polygon));
          if (open && runStart < 0) runStart = k;
          if (!open && runStart >= 0) {
            const u0 = (runStart / steps) * len;
            const u1 = (k / steps) * len;
            outside.quad(f.at(u0, -slabT, 0), f.D.clone().multiplyScalar(u1 - u0), Y.clone().multiplyScalar(slabT), [u0, 0], [u1 - u0, slabT]);
            runStart = -1;
          }
        }
      }
      for (const [mb, id] of [[outside, 'cross-black'], [inside, 'cross-sp2540']] as const) {
        if (mb.empty) continue;
        const sides = new THREE.Mesh(mb.geometry(), getMaterial(id));
        sides.receiveShadow = true;
        group.add(sides);
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
      const e0 = convex(i) ? t / 2 + 1 : 0;
      const e1 = convex((i + 1) % n) ? t / 2 + 1 : 0;
      const a: Point = [finish[i][0] - dir[0] * e0, finish[i][1] - dir[1] * e0];
      const b: Point = [finish[(i + 1) % finish.length][0] + dir[0] * e1, finish[(i + 1) % finish.length][1] + dir[1] * e1];
      const len = len0 + e0 + e1;
      const side = edgeSide(room.polygon, i);
      const edge = edgeIndex(i);
      const matId = room.edges?.[String(edge)] ?? room.accent?.[side] ?? room.wall;
      const mb = new MeshBuilder();
      const f = new Frame(a, [b[0] - a[0], b[1] - a[1]]);
      const spans = openingsOnSegment(floor.openings, a, b, t / 2 + 5);
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
      for (const r of finishRects) {
        mb.quad(f.at(r.u0, r.v0, 0), f.D.clone().multiplyScalar(r.u1 - r.u0), Y.clone().multiplyScalar(r.v1 - r.v0), [r.u0, r.v0], [r.u1 - r.u0, r.v1 - r.v0]);
        // 巾木（床に接する所だけ。高さ 60・出 8）
        if (!room.noBaseboard && !room.void && Math.abs(r.v0 - level) < 1) {
          const du = f.D.clone().multiplyScalar(r.u1 - r.u0);
          baseboard.quad(f.at(r.u0, level, inward * BASEBOARD_T), du, Y.clone().multiplyScalar(BASEBOARD_H), [r.u0, 0], [r.u1 - r.u0, BASEBOARD_H]);
          baseboard.quad(f.at(r.u0, level + BASEBOARD_H, 0), du, f.N.clone().multiplyScalar(inward * BASEBOARD_T), [r.u0, 0], [r.u1 - r.u0, BASEBOARD_T]);
        }
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

  if (!baseboard.empty) {
    const mat = getMaterial('baseboard-gray', { clip });
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(baseboard.geometry(), mat);
    mesh.receiveShadow = true;
    group.add(mesh);
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
function addWallBox(mb: MeshBuilder, side: (u: number, s: 1 | -1, openingId?: string) => MeshBuilder, openingAt: (u: number) => string | undefined, f: Frame, r: Rect, t: number, bottom: number, top: number, drawStart: boolean, drawEnd: boolean, ceiling: number, holes: Hole[] = []) {
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
  // 天井の高さまである開口部の上の壁の下面は、両側の天井でふさがるので描かない
  if (r.v0 > bottom && r.v0 < ceiling - 1) {
    const o = openingAt(mid);
    side(mid, -1, o).quad(f.at(r.u0, r.v0, -h), along, nHalf, [r.u0, 0], [du, h]);
    side(mid, 1, o).quad(f.at(r.u0, r.v0, 0), along, nHalf, [r.u0, h], [du, h]);
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
