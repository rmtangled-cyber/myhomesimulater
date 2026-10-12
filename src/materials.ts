// 素材カタログ。
// 標準の素材はキャンバスで生成し（色と凹凸）、実寸（mm）で貼る。新しい素材は BUILTIN_MATERIALS に追加する。
// 間取りファイルの materials に画像を登録すると、その画像も素材として使える。

import * as THREE from 'three';
import { fbm, normalMapFromHeight, type Rand } from './noise';
import type { CustomMaterial, MaterialCategory } from './types';

export type { MaterialCategory };

interface Generated {
  color: ImageData;
  /** 0〜1 の高さ。凹凸（法線マップ）を作るのに使う */
  height?: Float32Array;
}

export interface MaterialDef {
  id: string;
  name: string;
  categories: MaterialCategory[];
  /** テクスチャ1枚が表す実寸 [横, 縦] mm */
  tile: [number, number];
  roughness: number;
  /** 凹凸の強さ（0 で平ら） */
  bump: number;
  draw?: (w: number, h: number, rand: Rand) => Generated;
  /** 画像の素材（public/ からの相対パス） */
  image?: string;
}

function rng(seed: number): Rand {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type RGB = [number, number, number];

function rgb(hex: string): RGB {
  const c = new THREE.Color(hex);
  return [c.r * 255, c.g * 255, c.b * 255];
}

/** 色 c の明るさを k 倍して書き込む */
function put(d: Uint8ClampedArray, i: number, c: RGB, k: number) {
  d[i * 4] = c[0] * k;
  d[i * 4 + 1] = c[1] * k;
  d[i * 4 + 2] = c[2] * k;
  d[i * 4 + 3] = 255;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** ノイズの格子の数を「何 mm ごとの模様か」で指定するための換算 */
const cellsFor = (tileMm: number, featureMm: number) => Math.max(1, Math.round(tileMm / featureMm));

// ---------------------------------------------------------------- 壁紙・塗り壁

/** 量産クロス・塗り壁調。ゆるいムラと細かいエンボス */
function plaster(base: string, tileMm: number, opts: { mottle?: number; grain?: number; embossMm?: number } = {}) {
  const c = rgb(base);
  const mottle = opts.mottle ?? 0.035;
  const grain = opts.grain ?? 0.05;
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm, 300), octaves: 4 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm, opts.embossMm ?? 6), octaves: 3, persistence: 0.6 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      put(color.data, i, c, 1 + (m[i] - 0.5) * mottle * 2 + (f[i] - 0.5) * grain);
      height[i] = f[i];
    }
    return { color, height };
  };
}

/** 織物調クロス。細かい縦横の織り目 */
function woven(base: string, tileMm: number) {
  const c = rgb(base);
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm, 250), octaves: 4 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm, 8), octaves: 2 });
    const pitch = Math.max(3, Math.round((w / tileMm) * 1.6)); // 約 1.6mm ピッチ
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const weave = (Math.floor(x / pitch) + Math.floor(y / pitch)) % 2 === 0;
        const ridge = weave ? Math.sin(((x % pitch) / pitch) * Math.PI) : Math.sin(((y % pitch) / pitch) * Math.PI);
        height[i] = ridge * 0.5 + f[i] * 0.5;
        put(color.data, i, c, 1 + (m[i] - 0.5) * 0.05 + (ridge - 0.5) * 0.05 + (f[i] - 0.5) * 0.03);
      }
    }
    return { color, height };
  };
}

/** 石目・コンクリート調。大きなムラ、細かい粒、小さな気泡 */
function stone(base: string, tileMm: number, opts: { contrast?: number; pores?: number; tint?: string } = {}) {
  const c = rgb(base);
  const tint = rgb(opts.tint ?? base);
  const contrast = opts.contrast ?? 0.14;
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm, 600), octaves: 6, persistence: 0.58 });
    const v = fbm(w, h, rand, { cellsX: cellsFor(tileMm, 120), octaves: 4, persistence: 0.55 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm, 3), octaves: 2 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const tone = (m[i] - 0.5) * 2 * contrast + (v[i] - 0.5) * contrast * 0.8 + (f[i] - 0.5) * 0.08;
      put(color.data, i, mix(c, tint, v[i]), 1 + tone);
      height[i] = f[i] * 0.6 + v[i] * 0.4;
    }
    // 気泡・粒（1万ピクセルあたりの数）
    const pores = Math.round(((opts.pores ?? 0) * (w * h)) / 1e4);
    for (let n = 0; n < pores; n++) {
      const px = Math.floor(rand() * w);
      const py = Math.floor(rand() * h);
      const r = rand() < 0.85 ? 1 : 2;
      const dark = rand() < 0.75;
      const k = dark ? 0.72 : 1.12;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const i = ((py + dy + h) % h) * w + ((px + dx + w) % w);
          color.data[i * 4] *= k;
          color.data[i * 4 + 1] *= k;
          color.data[i * 4 + 2] *= k;
          if (dark) height[i] -= 0.5;
        }
      }
    }
    return { color, height };
  };
}

/** 木目調の壁紙・パネル（継ぎ目なし）。縦に流れる細い木目 */
function woodPaper(base: string, tileMm: [number, number], opts: { contrast?: number; seam?: boolean } = {}) {
  const c = rgb(base);
  const contrast = opts.contrast ?? 0.1;
  return (w: number, h: number, rand: Rand): Generated => {
    // 横方向に細かく、縦方向にはほとんど変わらないノイズ = 縦の木目
    const streak = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 2.5), cellsY: 3, octaves: 3, persistence: 0.6 });
    const band = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 45), cellsY: 2, octaves: 3 });
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 300), octaves: 3 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      put(color.data, i, c, 1 + (streak[i] - 0.5) * contrast * 2 + (band[i] - 0.5) * contrast + (m[i] - 0.5) * 0.05);
      height[i] = streak[i];
    }
    // パネルの継ぎ目（テクスチャの左端に縦の細い溝）
    if (opts.seam) {
      const sw = Math.max(1, Math.round(w / tileMm[0]));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < sw; x++) {
          const i = y * w + x;
          color.data[i * 4] *= 0.7;
          color.data[i * 4 + 1] *= 0.7;
          color.data[i * 4 + 2] *= 0.7;
          height[i] = 0;
        }
      }
    }
    return { color, height };
  };
}

/** 大理石調（メラミン化粧板など）。ゆらいだ筋模様 */
function marble(base: string, vein: string, tileMm: number, opts: { veins?: number; strength?: number } = {}) {
  const c = rgb(base);
  const vc = rgb(vein);
  const veins = opts.veins ?? 2;
  const strength = opts.strength ?? 0.75;
  return (w: number, h: number, rand: Rand): Generated => {
    const warp = fbm(w, h, rand, { cellsX: cellsFor(tileMm, 300), octaves: 6, persistence: 0.55 });
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm, 150), octaves: 4 });
    const color = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        // 周期が整数なので継ぎ目なく繰り返せる
        const t = (x / w) * veins + (y / h) + warp[i] * 4;
        const v = Math.pow(1 - Math.abs(Math.sin(t * Math.PI)), 14);
        put(color.data, i, mix(c, vc, v * strength), 1 + (m[i] - 0.5) * 0.14);
      }
    }
    return { color };
  };
}

// ---------------------------------------------------------------- 床

/** フローリング。板ごとの色ムラ、ノイズで揺らした木目、継ぎ目の溝 */
function flooring(colors: string[], plankWidthMm: number, tileMm: [number, number], opts: { grainContrast?: number } = {}) {
  const palette = colors.map(rgb);
  const grainContrast = opts.grainContrast ?? 0.22;
  return (w: number, h: number, rand: Rand): Generated => {
    const rows = Math.round(tileMm[1] / plankWidthMm);
    const rowH = h / rows;
    const pxPerMm = w / tileMm[0];
    // 板の長さ方向（x）に長く伸びた木目
    const grain = fbm(w, h, rand, { cellsX: 4, cellsY: rows * 14, octaves: 5, persistence: 0.55 });
    const warp = fbm(w, h, rand, { cellsX: 6, cellsY: rows * 2, octaves: 3 });
    const fine = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 4), cellsY: cellsFor(tileMm[1], 1.2), octaves: 2 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const groove = Math.max(1.2, pxPerMm * 1.5);
    for (let r = 0; r < rows; r++) {
      const y0 = Math.round(r * rowH);
      const y1 = Math.round((r + 1) * rowH);
      // 1列に2枚。継ぎ目の位置を列ごとにずらす
      const j0 = rand() * w;
      const j1 = (j0 + w / 2 + (rand() - 0.5) * w * 0.2) % w;
      const joints = [Math.min(j0, j1), Math.max(j0, j1)];
      const planks = [0, 1].map(() => ({
        base: mix(palette[Math.floor(rand() * palette.length)], palette[Math.floor(rand() * palette.length)], rand()),
        tone: 1 + (rand() - 0.5) * 0.12,
        shift: Math.floor(rand() * w),
        rings: 2 + rand() * 5,
        phase: rand() * 10,
      }));
      for (let y = y0; y < y1; y++) {
        const ly = (y - y0) / rowH;
        const dy = Math.min(y - y0, y1 - 1 - y);
        for (let x = 0; x < w; x++) {
          const pl = planks[x >= joints[0] && x < joints[1] ? 0 : 1];
          const i = y * w + x;
          const si = y * w + ((x + pl.shift) % w);
          // 板目: ノイズで揺らした縞
          const figure = Math.sin((ly * pl.rings + warp[si] * 3 + pl.phase) * Math.PI * 2);
          const g = grain[si] - 0.5;
          let k = pl.tone * (1 + g * grainContrast * 2 + figure * grainContrast * 0.25 + (fine[i] - 0.5) * 0.06);
          height[i] = 0.85 + g * 0.1 + (fine[i] - 0.5) * 0.05;
          // 継ぎ目（長手・短手）
          const dx = Math.min(Math.abs(x - joints[0]), Math.abs(x - joints[1]), w - Math.abs(x - joints[0]), w - Math.abs(x - joints[1]));
          const edge = Math.min(dy, dx);
          if (edge < groove) {
            k *= 0.55 + 0.45 * (edge / groove);
            height[i] = 0.3 + 0.5 * (edge / groove);
          }
          put(color.data, i, pl.base, k);
        }
      }
    }
    return { color, height };
  };
}

/** タイル。1枚ごとの色ムラ、石のようなムラ、目地の溝 */
function tiles(
  base: string,
  grout: string,
  countX: number,
  countY: number,
  tileMm: [number, number],
  opts: { variation?: number; mottle?: number; groutMm?: number } = {},
) {
  const c = rgb(base);
  const g = rgb(grout);
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: countX * 3, cellsY: countY * 3, octaves: 5, persistence: 0.55 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 2.5), cellsY: cellsFor(tileMm[1], 2.5), octaves: 2 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const tw = w / countX;
    const th = h / countY;
    const groutPx = Math.max(1.5, (w / tileMm[0]) * (opts.groutMm ?? 3));
    const tone = Array.from({ length: countX * countY }, () => 1 + (rand() - 0.5) * (opts.variation ?? 0.06));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const tx = Math.floor(x / tw);
        const ty = Math.floor(y / th);
        const edge = Math.min(x - tx * tw, (tx + 1) * tw - x, y - ty * th, (ty + 1) * th - y);
        if (edge < groutPx / 2) {
          put(color.data, i, g, 0.95 + (f[i] - 0.5) * 0.1);
          height[i] = 0.2;
        } else {
          put(color.data, i, c, tone[ty * countX + tx] * (1 + (m[i] - 0.5) * (opts.mottle ?? 0.12) * 2 + (f[i] - 0.5) * 0.05));
          // 角を少し丸める
          height[i] = Math.min(1, 0.6 + (edge - groutPx / 2) / (groutPx * 1.5)) + (f[i] - 0.5) * 0.05;
        }
      }
    }
    return { color, height };
  };
}

/**
 * 素材柄のフロア材（ラシッサ Dフロア耐水UDわん など）。幅 boardW・長さ boardL の板を、列ごとに継ぎ目をずらして張る。
 * 板の継ぎ目は床面より下がった V 溝。
 */
function boards(base: string, boardW: number, boardL: number, rows: number, opts: { mottle?: number; variation?: number } = {}) {
  const c = rgb(base);
  const tileMm: [number, number] = [boardL, boardW * rows];
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 250), cellsY: cellsFor(tileMm[1], 250), octaves: 5, persistence: 0.55 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 2.5), cellsY: cellsFor(tileMm[1], 2.5), octaves: 2 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const pxPerMm = w / tileMm[0];
    const rowH = h / rows;
    const groove = Math.max(1.5, pxPerMm * 2.5);
    // 継ぎ目は 1 列ごとに板の半分ずらす（れんが張り）。板ごとに色を少し変える
    const rowInfo = Array.from({ length: rows }, (_, r) => ({ joint: r % 2 === 0 ? 0 : Math.floor(w / 2), tones: [1 + (rand() - 0.5) * (opts.variation ?? 0.06), 1 + (rand() - 0.5) * (opts.variation ?? 0.06)] }));
    for (let y = 0; y < h; y++) {
      const r = Math.min(rows - 1, Math.floor(y / rowH));
      const ly = y - r * rowH;
      const info = rowInfo[r];
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const lx = (x - info.joint + w) % w;
        const edge = Math.min(ly, rowH - ly, lx, w - lx);
        let k = info.tones[lx < w / 2 ? 0 : 1] * (1 + (m[i] - 0.5) * (opts.mottle ?? 0.18) * 2 + (f[i] - 0.5) * 0.05);
        height[i] = 0.8 + (f[i] - 0.5) * 0.05;
        if (edge < groove) {
          // 床面より下がった V 溝。底ほど暗い
          const t = edge / groove;
          k *= 0.5 + 0.5 * t;
          height[i] = 0.8 * t;
        }
        put(color.data, i, c, k);
      }
    }
    return { color, height };
  };
}

/** コンクリート打ち放し調。型枠の継ぎ目と P コンの穴（holes: false で穴なし） */
function concretePanels(base: string, tileMm: [number, number], panel: [number, number], opts: { holes?: boolean; toneVar?: number } = {}) {
  const c = rgb(base);
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 300), cellsY: cellsFor(tileMm[1], 300), octaves: 6, persistence: 0.6 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 4), cellsY: cellsFor(tileMm[1], 4), octaves: 2 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const px = w / tileMm[0];
    const pw = panel[0] * px;
    const ph = panel[1] * px;
    const tone = Array.from({ length: 16 }, () => 1 + (rand() - 0.5) * (opts.toneVar ?? 0.08));
    const holeR = 12 * px;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const cx = Math.floor(x / pw);
        const cy = Math.floor(y / ph);
        let k = tone[(cx * 3 + cy * 5) % 16] * (1 + (m[i] - 0.5) * 0.3 + (f[i] - 0.5) * 0.08);
        height[i] = 0.7 + (f[i] - 0.5) * 0.1;
        // 型枠の継ぎ目
        const ex = Math.min(x % pw, pw - (x % pw));
        const ey = Math.min(y % ph, ph - (y % ph));
        if (Math.min(ex, ey) < 1.2) {
          k *= 0.82;
          height[i] = 0.5;
        }
        // P コンの穴（パネルごとに左右 2 つ）
        const lx = x % pw;
        const ly = y % ph;
        for (const hx of opts.holes === false ? [] : [pw * 0.25, pw * 0.75]) {
          const d = Math.hypot(lx - hx, ly - ph / 2);
          if (d < holeR) {
            k *= 0.55 + 0.3 * (d / holeR);
            height[i] = 0.2;
          } else if (d < holeR * 1.6) k *= 1.04;
        }
        put(color.data, i, c, k);
      }
    }
    return { color, height };
  };
}

function tatami(tileMm: [number, number]) {
  const c = rgb('#c9c48a');
  const border = rgb('#2f3a2c');
  return (w: number, h: number, rand: Rand): Generated => {
    const reeds = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 3), cellsY: 3, octaves: 3 });
    const m = fbm(w, h, rand, { cellsX: 3, octaves: 4 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const borderPx = Math.round((h / tileMm[1]) * 30);
    const stitch = Math.max(2, Math.round((h / tileMm[1]) * 15));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (y < borderPx || y >= h - borderPx) {
          put(color.data, i, border, 0.9 + (reeds[i] - 0.5) * 0.1);
          height[i] = 0.8;
          continue;
        }
        const ridge = Math.sin(((x % 3) / 3) * Math.PI);
        const seam = y % stitch === 0 ? 0.92 : 1;
        put(color.data, i, c, (0.88 + (reeds[i] - 0.5) * 0.3 + ridge * 0.06 + (m[i] - 0.5) * 0.08) * seam);
        height[i] = ridge * 0.6 + reeds[i] * 0.4;
      }
    }
    return { color, height };
  };
}

/** サイディング。rough を付けると石を割ったようなざらざらした表情（ロック調）になる */
function siding(base: string, boardMm: number, tileMm: [number, number], opts: { rough?: number } = {}) {
  const c = rgb(base);
  const rough = opts.rough ?? 0;
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: 4, octaves: 5 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 5), cellsY: cellsFor(tileMm[1], 5), octaves: 2 });
    const r = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 60), cellsY: cellsFor(tileMm[1], 25), octaves: 4, persistence: 0.6 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const rowH = h / Math.round(tileMm[1] / boardMm);
    const groove = Math.max(2, (h / tileMm[1]) * 8);
    for (let y = 0; y < h; y++) {
      const ly = y % rowH;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let k = 1 + (m[i] - 0.5) * 0.06 + (f[i] - 0.5) * 0.05 + (r[i] - 0.5) * rough;
        height[i] = 0.8 + f[i] * 0.2 * (1 - rough) + (r[i] - 0.5) * rough;
        if (ly < groove) {
          k *= 0.6 + 0.4 * (ly / groove);
          height[i] = (ly / groove) * 0.6;
        }
        put(color.data, i, c, k);
      }
    }
    return { color, height };
  };
}

// ---------------------------------------------------------------- カタログ

const wall = (id: string, name: string, draw: MaterialDef['draw'], tile: [number, number], roughness = 0.9, bump = 0.8): MaterialDef => ({
  id,
  name,
  categories: ['wall'],
  tile,
  roughness,
  bump,
  draw,
});

const floor = (id: string, name: string, draw: MaterialDef['draw'], tile: [number, number], roughness: number, bump: number): MaterialDef => ({
  id,
  name,
  categories: ['floor'],
  tile,
  roughness,
  bump,
  draw,
});

const FLOOR_TILE: [number, number] = [1820, 900];

/** ウォークスルーで試せる候補のクロス（これまでに出てきた品番） */
export const CANDIDATE_WALLPAPERS = ['cross-sp2540', 'cross-sp2563', 'cross-sp2562', 'cross-hf3122', 'cross-th34102', 'cross-th34190', 'cross-th34606', 'cross-th34672', 'cross-fe76650'];

export const BUILTIN_MATERIALS: MaterialDef[] = [
  // ---- 床 ----
  floor('floor-oak', 'オーク（ナチュラル）', flooring(['#c79f6c', '#bd935f', '#d0ab79', '#b88c5a'], 150, FLOOR_TILE), FLOOR_TILE, 0.5, 1.5),
  floor('floor-walnut', 'ウォールナット', flooring(['#5e4030', '#6b4a36', '#4f3527', '#74503a'], 150, FLOOR_TILE, { grainContrast: 0.28 }), FLOOR_TILE, 0.45, 1.5),
  floor('floor-white-ash', 'ホワイトアッシュ', flooring(['#e3d6c2', '#dccdb6', '#e8dccb'], 150, FLOOR_TILE, { grainContrast: 0.12 }), FLOOR_TILE, 0.55, 1.5),
  floor('floor-gray-oak', 'グレージュオーク', flooring(['#a59a8c', '#9b9083', '#b0a596', '#8f8578'], 150, FLOOR_TILE, { grainContrast: 0.18 }), FLOOR_TILE, 0.55, 1.5),
  floor('floor-cherry', 'チェリー', flooring(['#a5603c', '#9a5634', '#b06a45'], 150, FLOOR_TILE), FLOOR_TILE, 0.45, 1.5),
  floor('floor-tile-white', 'タイル（ホワイト 300角）', tiles('#e9e6e0', '#c9c4bb', 4, 4, [1200, 1200], { mottle: 0.04 }), [1200, 1200], 0.3, 2),
  floor('floor-tile-stone', 'タイル（石目グレー 600角）', tiles('#8f8b85', '#6e6a65', 2, 2, [1200, 1200]), [1200, 1200], 0.45, 2),
  floor('floor-tile-charcoal', 'タイル（石目チャコール 600角）', tiles('#55534f', '#3f3d3a', 2, 2, [1200, 1200], { mottle: 0.16 }), [1200, 1200], 0.45, 2),
  floor('floor-tile-concrete-300', 'タイル（コンクリート調 300角）', tiles('#aeaca7', '#959390', 4, 4, [1200, 1200], { mottle: 0.16, variation: 0.08 }), [1200, 1200], 0.6, 2),
  floor('floor-tile-mortar', 'タイル（ラフモルタル柄 600角）', tiles('#8d8b87', '#7a7874', 2, 2, [1200, 1200], { mottle: 0.24, variation: 0.05 }), [1200, 1200], 0.7, 2.2),
  floor('floor-cushion-white', 'クッションフロア（白）', plaster('#ecebe6', 900, { mottle: 0.02, grain: 0.03 }), [900, 900], 0.5, 0.6),
  floor('floor-concrete', 'コンクリート（土間・車庫）', stone('#a8a6a1', 1800, { contrast: 0.12, pores: 6 }), [1800, 1800], 0.85, 1.5),
  floor('floor-tatami', '畳', tatami([910, 1820]), [910, 1820], 0.8, 2),
  // 実際に使う品番。色は見本チップより施工例の写真に寄せている
  floor('floor-sazana-raggray', 'TOTO サザナ ほっカラリ床 ライトグレー（ラグ調）', tiles('#bab9b5', '#a6a5a1', 40, 40, [800, 800], { mottle: 0.1, variation: 0.08, groutMm: 2 }), [800, 800], 0.7, 1.5),
  floor('floor-ipf300-con2', 'LIXIL コンテⅡ IPF-300/CON-2（300角）', tiles('#7e7c79', '#6a6865', 4, 4, [1200, 1200], { mottle: 0.15, variation: 0.07 }), [1200, 1200], 0.6, 2),
  // LIXIL ラシッサ Dフロア耐水UDわん（素材タイプ）。板は 幅303 × 長さ1818、継ぎ目は V 溝
  floor('floor-lassissa-mortar', 'LIXIL ラシッサ Dフロア耐水UDわん ラフモルタル調', boards('#8e8b87', 303, 1818, 4, { mottle: 0.2 }), [1818, 1212], 0.55, 1.2),
  floor('floor-lassissa-sandblack', 'LIXIL ラシッサ Dフロア耐水UDわん サンドブラック調', boards('#5b5957', 303, 1818, 4, { mottle: 0.15 }), [1818, 1212], 0.55, 1.2),
  floor('floor-lassissa-lightgray', 'LIXIL ラシッサ Dフロア耐水UDわん ライトクレイ調', boards('#b8b6b1', 303, 1818, 4, { mottle: 0.12 }), [1818, 1212], 0.55, 1.2),

  // ---- 壁・天井クロス ----
  wall('cross-white', '白（スタンダード）', plaster('#f4f3ef', 900), [900, 900], 0.9, 0.25),
  wall('cross-offwhite', 'オフホワイト（織物調）', woven('#efebe2', 450), [450, 450]),
  wall('cross-greige', 'グレージュ', woven('#cbc3b7', 450), [450, 450]),
  wall('cross-light-gray', 'ライトグレー', plaster('#d8d8d6', 900), [900, 900], 0.9, 0.25),
  wall('cross-charcoal', 'チャコールグレー', woven('#4a4b4d', 450), [450, 450]),
  wall('cross-navy', 'ネイビー', woven('#2d3a52', 450), [450, 450]),
  wall('cross-sage', 'セージグリーン', woven('#9aa68e', 450), [450, 450]),
  wall('cross-terracotta', 'テラコッタ', woven('#b97456', 450), [450, 450]),
  wall('cross-dusty-pink', 'ダスティピンク', woven('#d4b2aa', 450), [450, 450]),
  wall('cross-plaster-white', '塗り壁調ホワイト', stone('#ecebe6', 1200, { contrast: 0.05, pores: 4, tint: '#e4e1da' }), [1200, 1200], 0.95, 1.2),
  wall('cross-stone-lightgray', '石目調ライトグレー', stone('#c9c8c4', 1200, { contrast: 0.09, pores: 5, tint: '#bdbcb7' }), [1200, 1200], 0.9, 1.2),
  wall('cross-stone-charcoal', '石目調チャコール', stone('#6c6c6a', 1200, { contrast: 0.18, pores: 3, tint: '#5c5d5e' }), [1200, 1200], 0.85, 1.4),
  { ...wall('cross-concrete', 'コンクリート調', stone('#a9a7a2', 1800, { contrast: 0.14, pores: 8 }), [1800, 1800], 0.85, 1.6), categories: ['wall', 'exterior'] },
  wall('cross-wood-oak', '木目調（オーク板張り）', flooring(['#c79f6c', '#bd935f', '#d0ab79'], 100, [900, 900]), [900, 900], 0.55, 1.5),
  wall('cross-wood-walnut', '木目調（ウォールナット板張り）', flooring(['#5e4030', '#6b4a36', '#533829'], 100, [900, 900]), [900, 900], 0.55, 1.5),
  wall('wall-tile-white', 'タイル（白 100角・水回り）', tiles('#f2f1ec', '#d5d2ca', 6, 6, [600, 600], { mottle: 0.03, variation: 0.03 }), [600, 600], 0.25, 2),
  wall('cross-black', 'ブラック（天井・軒天）', plaster('#2b2b2c', 900, { mottle: 0.05 }), [900, 900], 0.85, 0.3),
  // ---- 実際に使う品番（サンゲツ）。色は見本チップと施工例の写真の中間に合わせている ----
  wall('cross-sp2540', 'SP2540 石目調ライトグレー', stone('#cbc8c2', 900, { contrast: 0.05, pores: 14, tint: '#c3c0ba' }), [900, 900], 0.92, 1.1),
  wall('cross-sp2563', 'SP2563 コンクリート柄（淡色）', stone('#c0b9b0', 920, { contrast: 0.08, pores: 9, tint: '#b6aea4' }), [920, 640], 0.9, 1.2),
  wall('cross-sp2562', 'SP2562 織物調ダークブラウン（パール）', woven('#5c5653', 450), [450, 450], 0.7, 0.9),
  wall('cross-hf3122', 'HF3122 モルタル調グレー（ハードウォール）', stone('#87878a', 920, { contrast: 0.1, pores: 4, tint: '#7d7e81' }), [920, 640], 0.85, 1.3),
  wall('cross-th34102', 'TH34102 石目調ライトグレー（パール）', stone('#cfcecb', 920, { contrast: 0.03, pores: 6, tint: '#c8c8c4' }), [920, 640], 0.8, 1),
  wall('cross-th34190', 'TH34190 木目調（神代杉）', woodPaper('#7a706a', [920, 641], { contrast: 0.12 }), [920, 641], 0.75, 0.8),
  // TOTO サザナ HT シリーズの見積もりの色。施工例の写真に合わせた
  wall('cross-th34606', 'TH34606 MATERIA FODINA（金属光沢の塗り調・ダークグレー）', stone('#45454a', 920, { contrast: 0.06, pores: 6, tint: '#3d3d42' }), [920, 641], 0.5, 0.8),
  wall('cross-th34672', 'TH34672 コンクリート打ち放し調（P コン付き）', concretePanels('#a8a099', [930, 1250], [465, 625]), [930, 1250], 0.85, 1.2),
  // FINE コンクリート・ストーン。30cm 角の型枠跡のダークグレーのコンクリート（施工例の写真に合わせた）
  wall('cross-fe76650', 'FE76650 コンクリート調（30cm 角の型枠跡・ダークグレー）', concretePanels('#6b6b69', [900, 900], [300, 300], { holes: false, toneVar: 0.14 }), [900, 900], 0.85, 1.2),
  wall('panel-sazana-greyishwalnut', 'TOTO サザナ 壁パネル グレイッシュウォルナット', woodPaper('#b8ada3', [900, 900], { contrast: 0.1, seam: true }), [900, 900], 0.4, 0.6),
  wall('panel-bath-woodgray', 'ユニットバス壁パネル（グレー木目）', woodPaper('#9b938c', [900, 900], { contrast: 0.08 }), [900, 900], 0.35, 0.6),

  // ---- 家具・造作の面材（家具の material で指定） ----
  // AICA。セルサス（指紋レスのマット）・セラール。色柄は商品画像と施工例に合わせた
  { id: 'aica-tj10235k', name: 'AICA TJ-10235K セルサス アールグレイマーブル（グレー）', categories: [], tile: [1200, 1200], roughness: 0.75, bump: 0, draw: marble('#68696b', '#9c9d9f', 1200, { veins: 2, strength: 0.5 }) },
  { id: 'aica-tj10240k', name: 'AICA TJ-10240K セルサス（ダークグレー）', categories: [], tile: [600, 600], roughness: 0.8, bump: 0.4, draw: stone('#3f3f40', 600, { contrast: 0.05, pores: 10, tint: '#3a3a3c' }) },
  { id: 'aica-fj901zd', name: 'AICA FJ-901ZD セラール グラニット パラディソ／ダーク', categories: [], tile: [600, 600], roughness: 0.55, bump: 0.4, draw: stone('#565350', 600, { contrast: 0.12, pores: 40, tint: '#4b4846' }) },
  { id: 'aica-ji10346k', name: 'AICA JI-10346K アイカラビアン（コンクリート柄）', categories: [], tile: [1200, 1200], roughness: 0.7, bump: 0.3, draw: stone('#8f8a85', 1200, { contrast: 0.07, pores: 5, tint: '#88837e' }) },
  { id: 'aica-tj10237k', name: 'AICA TJ-10237K セルサス メタルオキシサビ（ダーク）', categories: [], tile: [600, 600], roughness: 0.8, bump: 0.3, draw: stone('#2f3032', 600, { contrast: 0.09, pores: 12, tint: '#33302d' }) },
  // トクラス コラージア（見積もりで選んだ色）
  { id: 'toclas-z-greystone', name: 'トクラス コラージア 扉 Zシリーズ グレーストーン', categories: [], tile: [900, 900], roughness: 0.7, bump: 0.4, draw: stone('#4c4b4a', 900, { contrast: 0.08, pores: 14, tint: '#454443' }) },
  { id: 'toclas-tenor-ironblack', name: 'トクラス テノール（人造大理石）アイアンブラック', categories: [], tile: [900, 900], roughness: 0.45, bump: 0.2, draw: stone('#2e2f31', 900, { contrast: 0.05, pores: 30, tint: '#2a2b2d' }) },
  { id: 'concrete-counter', name: 'コンクリート調（カウンター）', categories: [], tile: [1200, 1200], roughness: 0.7, bump: 0.8, draw: stone('#b4b1ac', 1200, { contrast: 0.08, pores: 6 }) },

  // ---- 外壁 ----
  { id: 'exterior-siding-white', name: 'サイディング（白）', categories: ['exterior'], tile: [1820, 910], roughness: 0.8, bump: 2, draw: siding('#ecebe6', 455, [1820, 910]) },
  { id: 'exterior-siding-black', name: 'サイディング（ブラック）', categories: ['exterior'], tile: [1820, 910], roughness: 0.8, bump: 2, draw: siding('#2f3032', 455, [1820, 910]) },
  // ニチハ。色は施工写真に合わせた
  { id: 'exterior-charmrock', name: 'ニチハ モエンエクセラード60 シャルムロック プレミアム', categories: ['exterior'], tile: [1820, 910], roughness: 0.85, bump: 3, draw: siding('#58595d', 455, [1820, 910], { rough: 0.3 }) },
  { id: 'exterior-ekg103fk', name: 'ニチハ EKG103FK エピMGライトグレーV', categories: ['exterior'], tile: [1820, 910], roughness: 0.85, bump: 2, draw: tiles('#b9bbbb', '#a4a6a6', 2, 2, [1820, 910], { mottle: 0.1, variation: 0.08, groutMm: 6 }) },
  { id: 'exterior-lightgray', name: '外壁（ライトグレー）', categories: ['exterior'], tile: [1200, 1200], roughness: 0.85, bump: 1, draw: stone('#b6b9b9', 1200, { contrast: 0.04, pores: 3 }) },
  { id: 'exterior-plaster-beige', name: '塗り壁（ベージュ）', categories: ['exterior'], tile: [1200, 1200], roughness: 0.95, bump: 2.5, draw: stone('#ddd2bd', 1200, { contrast: 0.06, pores: 4 }) },
];

let materials: MaterialDef[] = [...BUILTIN_MATERIALS];
let byId = new Map(materials.map((m) => [m.id, m]));

/** 間取りファイルに登録された画像の素材を使えるようにする */
export function setCustomMaterials(list: CustomMaterial[] = []) {
  const custom: MaterialDef[] = list.map((m) => ({
    id: m.id,
    name: m.name,
    categories: m.categories,
    tile: m.tile,
    roughness: m.roughness ?? 0.9,
    bump: m.bump ?? 1.5,
    image: m.image,
  }));
  materials = [...BUILTIN_MATERIALS, ...custom];
  byId = new Map(materials.map((m) => [m.id, m]));
}

export function getMaterialDef(id: string): MaterialDef | undefined {
  return byId.get(id);
}

export function materialsFor(category: MaterialCategory): MaterialDef[] {
  return materials.filter((m) => m.categories.includes(category));
}

/** 定義が変わったら作り直すためのキー */
const defKey = (d: MaterialDef) => `${d.id}|${d.image ?? ''}|${d.tile.join('x')}|${d.roughness}|${d.bump}`;

const TEX_SIZE = 1024;
const textureCache = new Map<string, { map: THREE.Texture; normal?: THREE.Texture; swatch: string }>();
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

function setupTexture(tex: THREE.Texture, def: MaterialDef, color: boolean) {
  // 画像の素材は1枚の見本写真なので、鏡写しで繰り返して継ぎ目を目立たなくする
  tex.wrapS = tex.wrapT = def.image ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  // UV は mm 単位で作るので、1/実寸 で繰り返す
  tex.repeat.set(1 / def.tile[0], 1 / def.tile[1]);
}

function imageTextures(def: MaterialDef) {
  const url = `/${def.image!.replace(/^\//, '')}`;
  const normal = new THREE.CanvasTexture(document.createElement('canvas'));
  const map = new THREE.TextureLoader().load(url, (t) => {
    // 画像の明るさを高さとみなして凹凸を付ける
    const img = t.image as HTMLImageElement;
    const w = Math.min(1024, img.naturalWidth);
    const h = Math.round((w * img.naturalHeight) / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) height[i] = (data[i * 4] * 0.3 + data[i * 4 + 1] * 0.59 + data[i * 4 + 2] * 0.11) / 255;
    ctx.putImageData(normalMapFromHeight(height, w, h, def.bump), 0, 0);
    normal.image = canvas;
    normal.needsUpdate = true;
  });
  setupTexture(map, def, true);
  setupTexture(normal, def, false);
  return { map, normal: def.bump > 0 ? normal : undefined, swatch: url };
}

function generatedTextures(def: MaterialDef) {
  const w = TEX_SIZE;
  const h = Math.round((TEX_SIZE * def.tile[1]) / def.tile[0]);
  const gen = def.draw!(w, h, rng(hashString(def.id)));
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = w;
  colorCanvas.height = h;
  colorCanvas.getContext('2d')!.putImageData(gen.color, 0, 0);
  const map = new THREE.CanvasTexture(colorCanvas);
  setupTexture(map, def, true);
  let normal: THREE.Texture | undefined;
  if (gen.height && def.bump > 0) {
    const nc = document.createElement('canvas');
    nc.width = w;
    nc.height = h;
    nc.getContext('2d')!.putImageData(normalMapFromHeight(gen.height, w, h, def.bump), 0, 0);
    normal = new THREE.CanvasTexture(nc);
    setupTexture(normal, def, false);
  }
  // パネルの見本は 60cm 角の範囲を切り出す
  const sw = document.createElement('canvas');
  sw.width = sw.height = 96;
  const sx = Math.min(w, (w * 600) / def.tile[0]);
  const sy = Math.min(h, (h * 600) / def.tile[1]);
  sw.getContext('2d')!.drawImage(colorCanvas, 0, 0, sx, sy, 0, 0, 96, 96);
  return { map, normal, swatch: sw.toDataURL('image/jpeg', 0.8) };
}

function texturesFor(def: MaterialDef) {
  const key = defKey(def);
  let entry = textureCache.get(key);
  if (!entry) {
    entry = def.image ? imageTextures(def) : generatedTextures(def);
    textureCache.set(key, entry);
  }
  return entry;
}

/** 素材IDから three.js のマテリアルを作る。clip を渡すと断面表示の対象になる。 */
export function getMaterial(id: string, opts: { clip?: THREE.Plane[] } = {}): THREE.MeshStandardMaterial {
  const def = byId.get(id);
  const cacheKey = `${def ? defKey(def) : id}|${opts.clip ? 'clip' : ''}`;
  const cached = materialCache.get(cacheKey);
  if (cached) return cached;
  let mat: THREE.MeshStandardMaterial;
  if (def) {
    const tex = texturesFor(def);
    mat = new THREE.MeshStandardMaterial({ map: tex.map, normalMap: tex.normal ?? null, roughness: def.roughness, metalness: 0 });
  } else {
    mat = new THREE.MeshStandardMaterial({ color: '#ff00ff', roughness: 0.9 }); // 不明なIDはマゼンタで目立たせる
  }
  mat.userData.shared = true;
  if (opts.clip) {
    mat.clippingPlanes = opts.clip;
    mat.clipShadows = true;
  }
  materialCache.set(cacheKey, mat);
  return mat;
}

/** パネルに表示する見本画像の URL */
export function swatchUrl(id: string): string {
  const def = byId.get(id);
  return def ? texturesFor(def).swatch : '';
}
