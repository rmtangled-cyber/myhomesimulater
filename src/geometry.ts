// 部屋の外形から壁を作るための平面幾何。

import type { Opening, Point, Room, Side } from './types';

export interface WallSegment {
  from: Point;
  to: Point;
}

const EPS = 0.5;

function key(n: number): number {
  return Math.round(n);
}

export function signedArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function centroid(poly: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p[0];
    y += p[1];
  }
  return [x / poly.length, y / poly.length];
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 部屋の辺をすべて集めて、重なりをまとめた壁芯の線分にする。 */
export function deriveWalls(rooms: Room[]): WallSegment[] {
  const horizontal = new Map<number, [number, number][]>();
  const vertical = new Map<number, [number, number][]>();
  const diagonal: WallSegment[] = [];

  for (const room of rooms) {
    const poly = room.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (Math.abs(a[1] - b[1]) < EPS) {
        const k = key(a[1]);
        const list = horizontal.get(k) ?? [];
        list.push([Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
        horizontal.set(k, list);
      } else if (Math.abs(a[0] - b[0]) < EPS) {
        const k = key(a[0]);
        const list = vertical.get(k) ?? [];
        list.push([Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
        vertical.set(k, list);
      } else {
        const dup = diagonal.some(
          (s) =>
            (dist(s.from, a) < EPS && dist(s.to, b) < EPS) ||
            (dist(s.from, b) < EPS && dist(s.to, a) < EPS),
        );
        if (!dup) diagonal.push({ from: a, to: b });
      }
    }
  }

  const walls: WallSegment[] = [];
  for (const [y, intervals] of horizontal) {
    for (const [x0, x1] of mergeIntervals(intervals)) walls.push({ from: [x0, y], to: [x1, y] });
  }
  for (const [x, intervals] of vertical) {
    for (const [y0, y1] of mergeIntervals(intervals)) walls.push({ from: [x, y0], to: [x, y1] });
  }
  return walls.concat(diagonal);
}

function mergeIntervals(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + EPS) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 点を線分の直線へ射影したときの、始点からの距離と直線までの距離。 */
export function projectOnLine(p: Point, a: Point, b: Point): { u: number; off: number } {
  const len = dist(a, b);
  const dx = (b[0] - a[0]) / len;
  const dy = (b[1] - a[1]) / len;
  const px = p[0] - a[0];
  const py = p[1] - a[1];
  return { u: px * dx + py * dy, off: Math.abs(px * -dy + py * dx) };
}

/** 線分 a→b の上にある開口部の区間（a からの距離）を返す。 */
export interface OpeningSpan {
  opening: Opening;
  u0: number;
  u1: number;
}

export function openingsOnSegment(
  openings: Opening[],
  a: Point,
  b: Point,
  tolerance: number,
): OpeningSpan[] {
  const len = dist(a, b);
  const spans: OpeningSpan[] = [];
  for (const o of openings) {
    const { u, off } = projectOnLine(o.at, a, b);
    if (off > tolerance) continue;
    const u0 = Math.max(0, u - o.width / 2);
    const u1 = Math.min(len, u + o.width / 2);
    if (u1 - u0 > EPS) spans.push({ opening: o, u0, u1 });
  }
  return spans.sort((x, y) => x.u0 - y.u0);
}

/**
 * 多角形を内側へ d だけ縮める（各辺を平行移動して隣どうしを交差させる）。
 * 戻り値の i 番目の辺は、元の i 番目の辺に対応する。
 */
/** d は内側へずらす距離（負なら外へ）。辺ごとに変えるときは関数で渡す（i は poly[i] → poly[i+1] の辺） */
export function insetPolygon(poly: Point[], dist0: number | ((i: number) => number)): Point[] {
  const ccw = signedArea(poly) > 0;
  const n = poly.length;
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n];
    const len = dist(a, b);
    const dx = (b[0] - a[0]) / len;
    const dy = (b[1] - a[1]) / len;
    // signedArea が正なら、内側は (−dy, dx) 側
    const nx = ccw ? -dy : dy;
    const ny = ccw ? dx : -dx;
    const d = typeof dist0 === 'number' ? dist0 : dist0(i);
    return { p: [a[0] + nx * d, a[1] + ny * d] as Point, dx, dy };
  });
  return lines.map((cur, i) => {
    const prev = lines[(i - 1 + n) % n];
    return intersect(prev.p, prev.dx, prev.dy, cur.p, cur.dx, cur.dy) ?? cur.p;
  });
}

function intersect(
  p: Point,
  dx1: number,
  dy1: number,
  q: Point,
  dx2: number,
  dy2: number,
): Point | null {
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * dy2 - (q[1] - p[1]) * dx2) / den;
  return [p[0] + dx1 * t, p[1] + dy1 * t];
}

/** 部屋の i 番目の辺が、部屋から見てどの方角の壁か。 */
export function edgeSide(poly: Point[], i: number): Side {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  const ccw = signedArea(poly) > 0;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  // 外向きの法線
  const nx = ccw ? dy : -dy;
  const ny = ccw ? -dx : dx;
  if (Math.abs(nx) > Math.abs(ny)) return nx > 0 ? 'east' : 'west';
  return ny > 0 ? 'south' : 'north';
}
