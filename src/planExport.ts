// 「図面出力」: 今の間取りデータから、各階の平面図を 1 枚の PNG にして保存する。
// 壁（開口部で抜いた所）・窓・部屋名と広さ・家具の外形・910 のグリッドを描く。

import { centroid, deriveWalls, dist, openingsOnSegment, signedArea } from './geometry';
import type { Floor, Plan, Point } from './types';

/** 図面に描かない家具（道路まわり） */
const SKIP = new Set(['road', 'sidewalk', 'crosswalk', 'utility-pole']);
/** 1mm を何ピクセルで描くか */
const PX = 0.1;
const MARGIN = 900;

export function exportPlan(plan: Plan, filename: string) {
  const bounds = plan.floors.map(floorBounds);
  const width = bounds.reduce((s, b) => s + (b.x1 - b.x0 + MARGIN * 2) * PX, 0);
  const height = Math.max(...bounds.map((b) => (b.y1 - b.y0 + MARGIN * 2) * PX)) + 60;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#222';
  g.font = 'bold 22px sans-serif';
  g.fillText(`${plan.name}　平面図（グリッド ${plan.grid}mm）`, 20, 32);
  let ox = 0;
  plan.floors.forEach((floor, i) => {
    const b = bounds[i];
    g.save();
    g.translate(ox + (MARGIN - b.x0) * PX, 60 + (MARGIN - b.y0) * PX);
    drawFloor(g, plan, floor, b);
    g.restore();
    ox += (b.x1 - b.x0 + MARGIN * 2) * PX;
  });
  // 縮尺の目安（1m）
  g.fillStyle = '#222';
  g.fillRect(20, canvas.height - 24, 1000 * PX, 4);
  g.font = '14px sans-serif';
  g.fillText('1m', 20 + 1000 * PX + 8, canvas.height - 18);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename;
  a.click();
}

function floorBounds(floor: Floor) {
  const pts = floor.rooms.flatMap((r) => r.polygon);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function drawFloor(g: CanvasRenderingContext2D, plan: Plan, floor: Floor, b: { x0: number; y0: number; x1: number; y1: number }) {
  const t = plan.wallThickness;
  const P = ([x, y]: Point) => [x * PX, y * PX] as const;
  g.font = 'bold 20px sans-serif';
  g.fillStyle = '#222';
  g.fillText(floor.name, b.x0 * PX, (b.y0 - 450) * PX);

  // グリッド
  g.strokeStyle = '#e4e8ee';
  g.lineWidth = 1;
  for (let x = Math.floor(b.x0 / plan.grid) * plan.grid; x <= b.x1; x += plan.grid) line(g, P([x, b.y0 - 300]), P([x, b.y1 + 300]));
  for (let y = Math.floor(b.y0 / plan.grid) * plan.grid; y <= b.y1; y += plan.grid) line(g, P([b.x0 - 300, y]), P([b.x1 + 300, y]));

  // 部屋の床（土間など床の低い所は少し濃く、吹き抜けは斜線）
  for (const r of floor.rooms) {
    g.beginPath();
    r.polygon.forEach((p, i) => (i ? g.lineTo(...P(p)) : g.moveTo(...P(p))));
    g.closePath();
    g.fillStyle = r.void ? '#ffffff' : (r.level ?? 0) < 0 ? '#e9e7e3' : '#f6f5f2';
    g.fill();
    if (r.void) {
      g.save();
      g.clip();
      g.strokeStyle = '#d5d5d5';
      for (let k = -10000; k < 20000; k += 200) line(g, P([b.x0 + k, b.y0]), P([b.x0 + k - 9000, b.y0 + 9000]));
      g.restore();
    }
  }

  // 家具・設備の外形
  g.strokeStyle = '#9aa0a6';
  g.lineWidth = 1;
  for (const f of floor.furniture) {
    if (SKIP.has(f.type)) continue;
    const a = (f.rotation * Math.PI) / 180;
    const ux: Point = [Math.cos(a), Math.sin(a)];
    const uz: Point = [-Math.sin(a), Math.cos(a)];
    const corner = (sx: number, sz: number): Point => [f.x + (ux[0] * sx * f.w + uz[0] * sz * f.d) / 2, f.y + (ux[1] * sx * f.w + uz[1] * sz * f.d) / 2];
    g.beginPath();
    [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].forEach((p, i) => (i ? g.lineTo(...P(p)) : g.moveTo(...P(p))));
    g.closePath();
    g.stroke();
  }

  // 壁（開口部の所は抜く）と窓
  const rooms = floor.rooms.map((r) => ({ ...r, polygon: signedArea(r.polygon) > 0 ? r.polygon : [...r.polygon].reverse() }));
  for (const w of deriveWalls(rooms)) {
    const len = dist(w.from, w.to);
    const d: Point = [(w.to[0] - w.from[0]) / len, (w.to[1] - w.from[1]) / len];
    const at = (u: number): Point => [w.from[0] + d[0] * u, w.from[1] + d[1] * u];
    const spans = openingsOnSegment(floor.openings, w.from, w.to, t / 2 + 1);
    let u = 0;
    g.strokeStyle = '#1e1e1e';
    g.lineWidth = t * PX;
    g.lineCap = 'butt';
    for (const s of [...spans, { u0: len, u1: len, opening: null }]) {
      if (s.u0 > u + 1) line(g, P(at(u)), P(at(s.u0)));
      u = Math.max(u, s.u1);
      // 窓は細い 2 本線、腰壁（下が壁の開口）は細い 1 本線
      if (s.opening?.type === 'window') {
        g.save();
        g.lineWidth = 1.5;
        const n: Point = [-d[1], d[0]];
        for (const k of [-t / 4, t / 4]) line(g, P([at(s.u0)[0] + n[0] * k, at(s.u0)[1] + n[1] * k]), P([at(s.u1)[0] + n[0] * k, at(s.u1)[1] + n[1] * k]));
        g.restore();
      } else if (s.opening && (s.opening.sill ?? 0) > 0) {
        g.save();
        g.lineWidth = 3;
        line(g, P(at(s.u0)), P(at(s.u1)));
        g.restore();
      }
    }
  }

  // 部屋名と広さ（帖）
  g.textAlign = 'center';
  for (const r of floor.rooms) {
    const [cx, cy] = centroid(r.polygon);
    const area = Math.abs(signedArea(r.polygon)) / 1e6;
    if (area < 0.6 || r.noLabel) continue;
    g.fillStyle = '#333';
    g.font = '13px sans-serif';
    g.fillText(r.name, cx * PX, cy * PX);
    g.font = '11px sans-serif';
    g.fillStyle = '#666';
    g.fillText(`${(area / 1.62).toFixed(1)}帖`, cx * PX, cy * PX + 15);
  }
  g.textAlign = 'left';
}

function line(g: CanvasRenderingContext2D, a: readonly [number, number], b: readonly [number, number]) {
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.stroke();
}
