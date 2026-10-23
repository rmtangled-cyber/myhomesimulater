// ウォークスルーで壁・閉まったドア・造作の家具をすり抜けないようにする当たり判定。
// 体は真上から見た円（半径 RADIUS）で、平面（x, z）だけで調べる。高さは「足元の段より上・頭より下」に重なる物だけ。
// 壁は間取りのデータから線分で作り、家具はメッシュごとの箱（ワールド座標）で作る。扉は開け閉めで動くので、動いたら箱を作り直す。

import * as THREE from 'three';
import { deriveWalls, openingsOnSegment } from './geometry';
import type { Plan } from './types';

const MM = 0.001;
/** 体の半径（m） */
const RADIUS = 0.22;
/** 上り下りできる段の高さ（m）。これより低い物は当たらない（床の板・段など） */
const STEP = 0.45;

/** ぶつからない家具の種類（布のスクリーン・床や天井に付く物） */
const PASS_TYPES = new Set(['roll-screen', 'vertical-blind', 'fire-roll-screen', 'rug', 'road', 'sidewalk', 'crosswalk', 'floor-hatch', 'floor-hatch-framed', 'sumika-exhaust', 'ceiling-vent']);

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** 壁の厚みの半分 */
  half: number;
  y0: number;
  y1: number;
}

export class Collision {
  private walls: Seg[] = [];
  /** 箱: [minX, maxX, minY, maxY, minZ, maxZ] を 6 つずつ */
  private staticBoxes = new Float32Array(0);
  private doorBoxes = new Float32Array(0);
  private doorGroups: THREE.Object3D[] = [];

  /** 間取りから壁を作り、家具の箱を集める（3D を作り直したあと、ワールド座標が決まってから呼ぶ） */
  setPlan(plan: Plan, furniture: Map<string, THREE.Group>, looseIds: Set<string>) {
    const half = (plan.wallThickness / 2) * MM;
    this.walls = [];
    for (const floor of plan.floors) {
      const y0 = (floor.elevation - 600) * MM;
      const y1 = (floor.elevation + floor.height) * MM;
      for (const w of deriveWalls(floor.rooms)) {
        const len = Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1]);
        const dx = (w.to[0] - w.from[0]) / len;
        const dy = (w.to[1] - w.from[1]) / len;
        // 通れる開口部（窓以外で、床に近い所から人の背より高くまで開いている物）の所は壁を抜く
        const gaps = openingsOnSegment(floor.openings, w.from, w.to, plan.wallThickness / 2 + 1)
          .filter((s) => s.opening.type !== 'window' && s.opening.sill <= STEP / MM && s.opening.sill + s.opening.height >= 1600)
          .map((s) => [s.u0, s.u1] as const);
        let u = 0;
        const push = (u0: number, u1: number) => {
          if (u1 - u0 < 1) return;
          this.walls.push({ ax: (w.from[0] + dx * u0) * MM, az: (w.from[1] + dy * u0) * MM, bx: (w.from[0] + dx * u1) * MM, bz: (w.from[1] + dy * u1) * MM, half, y0, y1 });
        };
        for (const [g0, g1] of gaps) {
          push(u, g0);
          u = Math.max(u, g1);
        }
        push(u, len);
      }
    }
    const statics: number[] = [];
    this.doorGroups = [];
    for (const [id, g] of furniture) {
      if (looseIds.has(id) || g.userData.walkable || PASS_TYPES.has(g.userData.furnitureType)) continue;
      let moving = false;
      g.traverse((o) => {
        if (o.userData.door) moving = true;
      });
      if (moving) this.doorGroups.push(g);
      else collectBoxes(g, statics);
    }
    this.staticBoxes = new Float32Array(statics);
    this.updateDoors();
  }

  /** 扉が動いたら呼ぶ（扉のある家具の箱を作り直す） */
  updateDoors() {
    const out: number[] = [];
    for (const g of this.doorGroups) collectBoxes(g, out);
    this.doorBoxes = new Float32Array(out);
  }

  /** (x, z) に立ったとき、どれだけ物にめり込むか（めり込みの深さの合計） */
  private depth(x: number, z: number, feet: number, head: number): number {
    const lo = feet + STEP;
    let d = 0;
    for (const s of this.walls) {
      if (s.y1 < lo || s.y0 > head) continue;
      const r = RADIUS + s.half - distToSeg(x, z, s);
      if (r > 0) d += r;
    }
    for (const b of [this.staticBoxes, this.doorBoxes]) {
      for (let i = 0; i < b.length; i += 6) {
        if (b[i + 3] < lo || b[i + 2] > head) continue;
        const dx = Math.max(b[i] - x, 0, x - b[i + 1]);
        const dz = Math.max(b[i + 4] - z, 0, z - b[i + 5]);
        if (dx > RADIUS || dz > RADIUS) continue;
        const r = RADIUS - Math.hypot(dx, dz);
        if (r > 0) d += r;
      }
    }
    return d;
  }

  /**
   * from から (dx, dz) だけ動く。ぶつかる向きの動きは止め、壁に沿って滑らせる（x と z を別々に試す）。
   * もともとめり込んでいるときは、めり込みが増えない動きだけ許す（抜け出せるように）
   */
  move(from: THREE.Vector3, dx: number, dz: number, feet: number, head: number) {
    let d = this.depth(from.x, from.z, feet, head);
    const tryMove = (nx: number, nz: number) => {
      const nd = this.depth(nx, nz, feet, head);
      if (nd > d + 1e-5) return false;
      from.x = nx;
      from.z = nz;
      d = nd;
      return true;
    };
    if (tryMove(from.x + dx, from.z + dz)) return;
    tryMove(from.x + dx, from.z);
    tryMove(from.x, from.z + dz);
  }
}

const tmpBox = new THREE.Box3();

/** 見えているメッシュごとに、ワールド座標の箱を集める（見えない当たり用の板は除く） */
function collectBoxes(root: THREE.Object3D, out: number[]) {
  root.updateWorldMatrix(true, true);
  const walk = (o: THREE.Object3D) => {
    if (!o.visible || (o as THREE.Light).isLight) return;
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      const mat = m.material as THREE.Material;
      if (!(mat && !Array.isArray(mat) && mat.transparent && mat.opacity === 0)) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        tmpBox.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
        out.push(tmpBox.min.x, tmpBox.max.x, tmpBox.min.y, tmpBox.max.y, tmpBox.min.z, tmpBox.max.z);
      }
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
}

function distToSeg(x: number, z: number, s: Seg): number {
  const vx = s.bx - s.ax;
  const vz = s.bz - s.az;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * vx + (z - s.az) * vz) / l2)) : 0;
  return Math.hypot(x - s.ax - vx * t, z - s.az - vz * t);
}
