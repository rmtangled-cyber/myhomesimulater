// 素材カタログ。
// 標準の素材はキャンバスで生成し（色と凹凸）、実寸（mm）で貼る。新しい素材は BUILTIN_MATERIALS に追加する。
// 間取りファイルの materials に画像を登録すると、その画像も素材として使える。

import * as THREE from 'three';
import { fbm, normalMapFromHeight, type Rand } from './noise';
import type { CustomMaterial, MaterialCategory } from './types';
import { WEB } from './env';

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

/**
 * 色見本の色（sRGB の 16 進）を、キャンバスに書く 0〜255 の値にする。
 * テクスチャは sRGB として読まれるので、ここも sRGB のまま書く（2026-10-21 まで線形に変換して書いていたため、
 * 模様付きの素材がすべて見本より暗く・茶色っぽく表示されていた）
 */
function rgb(hex: string): RGB {
  const c = new THREE.Color(hex);
  const out = { r: 0, g: 0, b: 0 };
  c.getRGB(out, THREE.SRGBColorSpace);
  return [out.r * 255, out.g * 255, out.b * 255];
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

/** 金属の縦葺き屋根（立平葺き）。屋根の流れの向き（テクスチャの縦）に pitch ごとのハゼ（細い立ち上がり） */
function standingSeam(base: string, pitch: number, tileMm: [number, number]) {
  const c = rgb(base);
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 600), octaves: 3 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const px = (w / tileMm[0]) * pitch;
    const seam = Math.max(2, (w / tileMm[0]) * 18);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const dx = Math.abs(((x + px / 2) % px) - px / 2);
        const ridge = dx < seam ? 1 - dx / seam : 0;
        height[i] = ridge;
        put(color.data, i, c, 1 + (m[i] - 0.5) * 0.06 + ridge * 0.35);
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
/** 横に流れる筋（トクラス グレーストーンの扉など）。縦方向に細かく、横方向にはほとんど変わらないノイズ。ところどころ明るい筋 */
function hStreak(base: string, tileMm: [number, number], opts: { contrast?: number; light?: number } = {}) {
  const c = rgb(base);
  const contrast = opts.contrast ?? 0.12;
  const light = opts.light ?? 0.25;
  return (w: number, h: number, rand: Rand): Generated => {
    const streak = fbm(w, h, rand, { cellsX: 3, cellsY: cellsFor(tileMm[1], 2.5), octaves: 3, persistence: 0.6 });
    const band = fbm(w, h, rand, { cellsX: 2, cellsY: cellsFor(tileMm[1], 40), octaves: 3 });
    const glint = fbm(w, h, rand, { cellsX: 4, cellsY: cellsFor(tileMm[1], 12), octaves: 2 });
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 300), octaves: 3 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const g = Math.max(0, glint[i] - 0.62) * light * 4;
      put(color.data, i, c, 1 + (streak[i] - 0.5) * contrast * 2 + (band[i] - 0.5) * contrast + g + (m[i] - 0.5) * 0.05);
      height[i] = streak[i];
    }
    return { color, height };
  };
}

/** 格子点のハッシュから作る値ノイズ（なめらかな 0〜1）。回転した座標でも使える */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** 木の削りくず・繊維を重ねて固めた柄（TH34788〜34790）。細長い繊維（長さ 5〜25mm・幅 1〜2.5mm）を向きと明るさを変えて密に重ねる */
function osb(base: string, tileMm: [number, number], opts: { contrast?: number } = {}) {
  const c = rgb(base);
  const contrast = opts.contrast ?? 0.25;
  return (w: number, h: number, rand: Rand): Generated => {
    const val = new Float32Array(w * h).fill(1);
    const sx = w / tileMm[0];
    const sy = h / tileMm[1];
    const n = Math.round((tileMm[0] * tileMm[1]) / 6);
    for (let k = 0; k < n; k++) {
      const len = (5 + rand() * 20) * sx;
      const wid = Math.max(1, (1 + rand() * 1.5) * sy);
      const ang = (rand() - 0.5) * Math.PI * 0.9;
      const cx = rand() * w;
      const cy = rand() * h;
      const tone = 1 + (rand() - 0.42) * 2 * contrast;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const r = Math.ceil(Math.max(len, wid) / 2) + 1;
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          const u = x * ca + y * sa;
          const v = -x * sa + y * ca;
          if (Math.abs(u) > len / 2 || Math.abs(v) > wid / 2) continue;
          const px = (((Math.round(cx + x) % w) + w) % w);
          const py = (((Math.round(cy + y) % h) + h) % h);
          // チップの縁は少し暗く、中に細い繊維の筋
          const edge = Math.abs(v) > wid / 2 - 0.6 ? 0.85 : 1;
          val[py * w + px] = tone * edge;
        }
      }
    }
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      put(color.data, i, c, val[i]);
      height[i] = val[i] - 0.6;
    }
    return { color, height };
  };
}

/** 板張りの木目（板の幅・長さ・向き）。angle は板の向き（0 で縦張り、45 で斜め）。板ごとに色が少し違い、継ぎ目は暗い線、knots で節 */
function planks(base: string, tileMm: [number, number], opts: { angle?: number; plankW?: number; minLen?: number; maxLen?: number; contrast?: number; vary?: number; knots?: number } = {}) {
  const c = rgb(base);
  const ang = ((opts.angle ?? 0) * Math.PI) / 180;
  const pw = opts.plankW ?? 120;
  const minL = opts.minLen ?? 400;
  const maxL = opts.maxLen ?? 1200;
  const contrast = opts.contrast ?? 0.12;
  const vary = opts.vary ?? 0.18;
  const knots = opts.knots ?? 0;
  return (w: number, h: number, rand: Rand): Generated => {
    const seed = Math.floor(rand() * 100000);
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const mmx = tileMm[0] / w;
    const mmy = tileMm[1] / h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const X = x * mmx;
        const Y = y * mmy;
        // 板の座標: u は板に沿って（縦張りなら上下）、v は板の幅の方向
        const u = -X * sa + Y * ca;
        const v = X * ca + Y * sa;
        const row = Math.floor(v / pw);
        const rv = v - row * pw;
        const len = minL + hash2(row, 7, seed) * (maxL - minL);
        const off = hash2(row, 3, seed) * len;
        const seg = Math.floor((u + off) / len);
        const ru = u + off - seg * len;
        const tone = 1 + (hash2(row, seg, seed) - 0.5) * 2 * vary;
        // 木目: 板に沿って流れる年輪の線（うねる）と、細い筋
        const grain = vnoise(u / 300, rv / 2.2 + row * 13.7, seed + 1) * 0.6 + vnoise(u / 900, rv / 9 + row * 5.1, seed + 2) * 0.4;
        const rr = (rv + (vnoise(u / 180, row * 3.3, seed + 5) - 0.5) * 14) / 7 + hash2(row, 21, seed) * 9;
        const fr = rr - Math.floor(rr);
        const ring = fr < 0.18 ? 1 - fr / 0.18 : 0;
        let k = tone * (1 + (grain - 0.5) * 2 * contrast - ring * contrast * 1.6);
        // 節
        if (knots > 0 && hash2(row, seg, seed + 9) < knots) {
          const ku = len * (0.25 + 0.5 * hash2(row, seg, seed + 10));
          const kv = pw * (0.3 + 0.4 * hash2(row, seg, seed + 11));
          const dd = ((ru - ku) / 26) ** 2 + ((rv - kv) / 12) ** 2;
          if (dd < 1) k *= 0.55 + 0.35 * dd;
        }
        // 継ぎ目（板の長辺と短辺）
        const joint = rv < 1.2 || rv > pw - 1.2 || ru < 1.2 ? 0.62 : 1;
        put(color.data, y * w + x, c, k * joint);
        height[y * w + x] = joint < 1 ? 0 : 0.5 + (grain - 0.5) * 0.3;
      }
    }
    return { color, height };
  };
}

/**
 * コテ塗りのスタッコ（Naturescape Shades of Air など）。コテでなでた扇形・三日月形の塗り跡（8〜15cm）が重なり、
 * 塗り跡の縁が少し明るく（パール）、中は少し暗い。細かい砂粒のざらつき。ムラは控えめ
 */
function trowel(base: string, tileMm: [number, number], opts: { contrast?: number; pearl?: number } = {}) {
  const c = rgb(base);
  const contrast = opts.contrast ?? 0.14;
  const pearl = opts.pearl ?? 0.12;
  return (w: number, h: number, rand: Rand): Generated => {
    const val = new Float32Array(w * h);
    const hgt = new Float32Array(w * h);
    const sx = w / tileMm[0];
    const n = Math.round((tileMm[0] * tileMm[1]) / 2200);
    for (let k = 0; k < n; k++) {
      const R = (35 + rand() * 60) * sx;
      const cx = rand() * w;
      const cy = rand() * h;
      const a0 = rand() * Math.PI * 2;
      const span = 0.9 + rand() * 1.2;
      const tone = (rand() - 0.5) * 2 * contrast;
      const r = Math.ceil(R) + 1;
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          const d = Math.hypot(x, y) / R;
          if (d > 1 || d < 0.25) continue;
          let a = Math.atan2(y, x) - a0;
          a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          if (a > span) continue;
          // 扇の外側の縁（コテの端）ほど明るく盛り上がる。端に向かってやわらかく消える
          const fade = Math.min(1, (span - a) / 0.6, a / 0.6, (d - 0.25) / 0.3, (1 - d) / 0.25);
          const rim = Math.max(0, (d - 0.45) / 0.55) ** 2;
          const i = (((Math.round(cy + y) % h) + h) % h) * w + (((Math.round(cx + x) % w) + w) % w);
          val[i] = val[i] * (1 - fade * 0.7) + (tone - 0.02 + rim * pearl) * fade * 0.7;
          hgt[i] = hgt[i] * (1 - fade * 0.7) + (0.3 + rim * 0.7) * fade * 0.7;
        }
      }
    }
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 2), octaves: 2 });
    const color = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) put(color.data, i, c, 1 + val[i] + (f[i] - 0.5) * 0.24);
    return { color, height: hgt };
  };
}

// ---------------------------------------------------------------- 品番ごとの柄（2026-10-19 公式の柄画像と 1 品番ずつ見比べて作り直した）

/** 高さから、左上から光が当たったときの陰影（−1〜1 くらい）を作る。凹凸の写真の見え方を色にも焼き込む */
function bakeLight(hgt: Float32Array, w: number, h: number, strength: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w;
    const yp = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      out[y * w + x] = (hgt[ym + xm] - hgt[yp + xp]) * strength;
    }
  }
  return out;
}

/** 0〜1 のノイズを、尾根が細く立つ形（しわ・クレープ）に変える */
const ridge = (v: number) => 1 - Math.abs(v * 2 - 1);

/**
 * しわ加工のエンボス（SP2540・SP2539・SP2541 の石目調）。紙をもんだような細かいしわの凹凸が全面にあり、
 * 色はほぼ無地で、陰影だけで柄が見える。size はしわの大きさ（mm）、shade は陰影の強さ
 */
function crinkle(base: string, tileMm: [number, number], opts: { size?: number; shade?: number; tone?: number } = {}) {
  const c = rgb(base);
  const size = opts.size ?? 6;
  const shade = opts.shade ?? 0.6;
  const tone = opts.tone ?? 0.03;
  return (w: number, h: number, rand: Rand): Generated => {
    const a = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], size * 1.0), cellsY: cellsFor(tileMm[1], size * 1.0), octaves: 4, persistence: 0.6 });
    const b = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], size * 0.45), cellsY: cellsFor(tileMm[1], size * 0.45), octaves: 2, persistence: 0.5 });
    const fold = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], size * 4), cellsY: cellsFor(tileMm[1], size * 4), octaves: 2 });
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 250), cellsY: cellsFor(tileMm[1], 250), octaves: 3 });
    const hgt = new Float32Array(w * h);
    // 細かいしわ＋大きく蛇行する折れ目
    for (let i = 0; i < w * h; i++) hgt[i] = ridge(a[i]) * 0.62 + ridge(b[i]) * 0.3 + ridge(fold[i]) * 0.08;
    const px = w / tileMm[0];
    const lit = bakeLight(hgt, w, h, shade * Math.min(1, 1.7 / px));
    const color = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) put(color.data, i, c, 1 + lit[i] + (m[i] - 0.5) * tone + (hgt[i] - 0.5) * 0.05);
    return { color, height: hgt };
  };
}

/**
 * 砂・粒の細かいざらつき（SP2563 のコンクリート調、TH34102 の石目調）。1〜2mm の粒が全面にあり、ゆるいムラ。pearl で明るい粒（パール）
 */
function sand(base: string, tileMm: [number, number], opts: { grain?: number; mottle?: number; mottleMm?: number; pearl?: number; size?: number; veins?: number } = {}) {
  const c = rgb(base);
  const grain = opts.grain ?? 0.12;
  const mottle = opts.mottle ?? 0.05;
  const pearl = opts.pearl ?? 0;
  return (w: number, h: number, rand: Rand): Generated => {
    const gs = opts.size ?? 1.6;
    const g1 = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], gs), cellsY: cellsFor(tileMm[1], gs), octaves: 2, persistence: 0.6 });
    const g2 = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 5), cellsY: cellsFor(tileMm[1], 5), octaves: 2 });
    const mm = opts.mottleMm ?? 160;
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], mm), cellsY: cellsFor(tileMm[1], mm), octaves: 4, persistence: 0.55 });
    // 細い筋（はけで描いたような曲線）
    const vein = opts.veins ? fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 45), cellsY: cellsFor(tileMm[1], 45), octaves: 3, persistence: 0.5 }) : null;
    const color = new ImageData(w, h);
    const hgt = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const gr = (g1[i] - 0.5) * 2 * grain + (g2[i] - 0.5) * grain * 0.6;
      const sp = pearl && g1[i] > 0.72 ? pearl : 0;
      // くっきりした粒（1 画素ごとの細かいざらつき）
      const wn = (rand() - 0.5) * grain * 0.9;
      const vn = vein ? Math.max(0, ridge(vein[i]) - 0.93) * opts.veins! * 14 : 0;
      put(color.data, i, c, 1 + gr + wn + (m[i] - 0.5) * 2 * mottle + sp + vn);
      hgt[i] = g1[i] * 0.7 + g2[i] * 0.3;
    }
    return { color, height: hgt };
  };
}

/**
 * 粗い織物（SP2562）。縦糸と横糸が 1.2mm くらいの目で交差し（平織り）、糸ごと・糸の途中（ネップ）で明るさが変わる。ところどころ明るい糸
 */
function linen(base: string, tileMm: [number, number], opts: { pitch?: number; contrast?: number; light?: number } = {}) {
  const c = rgb(base);
  const pitch = opts.pitch ?? 1.2;
  const contrast = opts.contrast ?? 0.28;
  const light = opts.light ?? 0.35;
  return (w: number, h: number, rand: Rand): Generated => {
    const px = w / tileMm[0];
    const pp = Math.max(1.6, pitch * px);
    const nx = Math.round(w / pp);
    const ny = Math.round(h / pp);
    const rowT = Array.from({ length: ny }, () => rand());
    const colT = Array.from({ length: nx }, () => rand());
    const slubH = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 7), cellsY: ny, octaves: 2 });
    const slubV = fbm(w, h, rand, { cellsX: nx, cellsY: cellsFor(tileMm[1], 7), octaves: 2 });
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 120), octaves: 3 });
    const color = new ImageData(w, h);
    const hgt = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const r = Math.floor((y / h) * ny) % ny;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const q = Math.floor((x / w) * nx) % nx;
        const over = (r + q) % 2 === 0;
        const t = over ? rowT[r] * 0.25 + slubH[i] * 0.75 : colT[q] * 0.25 + slubV[i] * 0.75;
        const bright = t > 0.62 ? light * (t - 0.62) * 2.5 : 0;
        put(color.data, i, c, 1 + (t - 0.5) * 2 * contrast + bright + (m[i] - 0.5) * 0.06);
        hgt[i] = 0.5 + (over ? 0.2 : -0.2) + (t - 0.5) * 0.2;
      }
    }
    return { color, height: hgt };
  };
}

/**
 * 不織布・マットな金属のような斜めの細い筋（TH34282・TH34283 Texture & Color）。±45° の短い細い傷のような筋が重なり、ゆるいムラ
 */
function crosshatch(base: string, tileMm: [number, number], opts: { contrast?: number; mottle?: number } = {}) {
  const c = rgb(base);
  const contrast = opts.contrast ?? 0.1;
  const mottle = opts.mottle ?? 0.05;
  return (w: number, h: number, rand: Rand): Generated => {
    const px = w / tileMm[0];
    const val = new Float32Array(w * h);
    const n = Math.round((tileMm[0] * tileMm[1]) / 12);
    for (let k = 0; k < n; k++) {
      const len = (4 + rand() * 12) * px;
      const dir = rand() < 0.5 ? 1 : -1;
      const x0 = rand() * w;
      const y0 = rand() * h;
      const v = (rand() - 0.5) * 2 * contrast;
      for (let s = 0; s < len; s++) {
        const x = Math.round(x0 + s * 0.7071);
        const y = Math.round(y0 + dir * s * 0.7071);
        val[(((y % h) + h) % h) * w + (((x % w) + w) % w)] += v;
      }
    }
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 140), cellsY: cellsFor(tileMm[1], 140), octaves: 4, persistence: 0.55 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 1.5), cellsY: cellsFor(tileMm[1], 1.5), octaves: 1 });
    const color = new ImageData(w, h);
    const hgt = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      put(color.data, i, c, 1 + Math.max(-0.25, Math.min(0.25, val[i])) + (m[i] - 0.5) * 2 * mottle + (f[i] - 0.5) * 0.05 + (rand() - 0.5) * 0.06);
      hgt[i] = 0.5 + val[i] + (f[i] - 0.5) * 0.2;
    }
    return { color, height: hgt };
  };
}

/**
 * 雲のようなムラのモルタル・塗り（HF3122・TH34606・FE78140）。cloudMm くらいの大きさの明暗のムラと、細かい粒。
 * scratch で、ムラの明るい所に細かいかすれ（金属っぽい塗りの擦れ）。crinkle で細かいしわの陰影
 */
function cloud(base: string, tileMm: [number, number], opts: { cloud?: number; cloudMm?: number; grain?: number; scratch?: number; crinkle?: number } = {}) {
  const c = rgb(base);
  const cl = opts.cloud ?? 0.12;
  const grain = opts.grain ?? 0.05;
  return (w: number, h: number, rand: Rand): Generated => {
    const cm = opts.cloudMm ?? 220;
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], cm), cellsY: cellsFor(tileMm[1], cm), octaves: 6, persistence: 0.6 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 1.8), cellsY: cellsFor(tileMm[1], 1.8), octaves: 2 });
    // 中くらい（1〜3cm）のまだら
    const mid = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 22), cellsY: cellsFor(tileMm[1], 22), octaves: 3, persistence: 0.6 });
    const s = opts.scratch ? fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 6), cellsY: cellsFor(tileMm[1], 6), octaves: 3, persistence: 0.65 }) : null;
    const cr = opts.crinkle ? fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 4.5), cellsY: cellsFor(tileMm[1], 4.5), octaves: 3 }) : null;
    const hgt = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) hgt[i] = (cr ? ridge(cr[i]) * 0.6 : 0) + f[i] * 0.4;
    const lit = cr ? bakeLight(hgt, w, h, opts.crinkle! * Math.min(1, 1.7 / (w / tileMm[0]))) : null;
    const color = new ImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      let k = 1 + (m[i] - 0.5) * 2 * cl + (mid[i] - 0.5) * cl * 1.0 + (f[i] - 0.5) * 2 * grain + (rand() - 0.5) * grain;
      if (s) k += Math.max(0, ridge(s[i]) - 0.8) * opts.scratch! * 8 * Math.max(0, m[i] - 0.45);
      if (lit) k += lit[i];
      put(color.data, i, c, k);
    }
    return { color, height: hgt };
  };
}

/**
 * 打ち放しコンクリート（TH34672）。縦に流れるムラと筋、細かい気泡の黒い点、P コンの穴（丸い凹み）
 */
function rawConcrete(base: string, tileMm: [number, number]) {
  const c = rgb(base);
  return (w: number, h: number, rand: Rand): Generated => {
    const px = w / tileMm[0];
    const v = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 14), cellsY: cellsFor(tileMm[1], 260), octaves: 4, persistence: 0.65 });
    const v2 = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 4), cellsY: cellsFor(tileMm[1], 90), octaves: 2 });
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 250), cellsY: cellsFor(tileMm[1], 250), octaves: 5, persistence: 0.6 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 2), cellsY: cellsFor(tileMm[1], 2), octaves: 2 });
    const color = new ImageData(w, h);
    const hgt = new Float32Array(w * h);
    // 型枠のパネル（公式の柄画像: 幅 465・高さ 625 が 2 列、横の継ぎ目は y 392 と 1017）。P コンは各パネルに 2 つ（パネルの幅の 0.6、高さの 0.17 と 0.71）
    const pw = 465 * px;
    const ph = 625 * (h / tileMm[1]);
    // 横の継ぎ目は画像の上から 392・1017 だが、床にそろえるため（ユーザー指定 2026-10-21）継ぎ目が床（模様の下端）と 625 ごとに来るようにずらす
    const oy = 0;
    const holeR = 12 * px;
    const holes: [number, number][] = [];
    for (let cx = 0; cx < 2; cx++) for (let cy = -1; cy < 2; cy++) for (const fy of [0.17, 0.71]) holes.push([(cx + 0.6) * pw, oy + (cy + fy) * ph]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let k = 1 + (v[i] - 0.5) * 0.55 + (v2[i] - 0.5) * 0.3 + (m[i] - 0.5) * 0.4 - Math.max(0, 0.45 - m[i]) * 1.3 + (f[i] - 0.5) * 0.3 + (rand() - 0.5) * 0.16;
        hgt[i] = 0.6 + (f[i] - 0.5) * 0.2;
        // 継ぎ目: 縦は細い暗い線、横はモルタルのはみ出し（明るい細い帯の下に暗い線）
        const ex = Math.min(x % pw, pw - (x % pw));
        const yy = (((y - oy) % ph) + ph) % ph;
        const sw = Math.max(1.3, 2.5 * px);
        if (ex < sw) k *= 0.72;
        if (yy < sw) k *= 0.7;
        else if (yy > ph - sw * 2.5) k *= 1.1;
        for (const [hx, hy0] of holes) {
          const hy = ((hy0 % h) + h) % h;
          const d = Math.hypot(x - hx, y - hy);
          if (d < holeR) {
            k *= 0.18 + 0.35 * (d / holeR) + (y < hy ? -0.05 : 0.12);
            hgt[i] = 0.1;
          } else if (d < holeR * 1.15) k *= 0.75;
        }
        put(color.data, i, c, k);
      }
    }
    // 気泡（小さな黒い点）
    const n = Math.round((w * h) / 2500);
    for (let k = 0; k < n; k++) {
      const x = Math.floor(rand() * w);
      const y = Math.floor(rand() * h);
      const r = rand() < 0.8 ? 1 : 2;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const i = ((y + dy + h) % h) * w + ((x + dx + w) % w);
          for (let ch = 0; ch < 3; ch++) color.data[i * 4 + ch] *= 0.45;
          hgt[i] = 0.2;
        }
    }
    return { color, height: hgt };
  };
}

/** 継ぎ目なく繰り返せる値ノイズ（格子を周期 px × py で折り返す） */
function pnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % px) + px) % px;
  const y0 = ((iy % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * 流れる木目（突板の柾目・板柾のプリント）。年輪の線がゆるく波打ちながら縦に流れ、線の間隔も揺らぐ。
 * 細い導管の筋は途中で切れて重なり、幅の広い色の帯がある。flame で炎のような大きなうねり（板目寄り）、knots で小さな節・割れ
 */
function grain(base: string, tileMm: [number, number], opts: { spacing?: number; warp?: number; line?: number; fine?: number; band?: number; bandMm?: number; streakMm?: number; lineW?: number; flame?: number; knots?: number; dark?: string } = {}) {
  const c = rgb(base);
  const dk = rgb(opts.dark ?? base);
  const spacing = opts.spacing ?? 9;
  const warp = opts.warp ?? 6;
  const line = opts.line ?? 0.18;
  const fine = opts.fine ?? 0.1;
  const band = opts.band ?? 0.1;
  const flame = opts.flame ?? 0;
  const knots = opts.knots ?? 0;
  return (w: number, h: number, rand: Rand): Generated => {
    const seed = Math.floor(rand() * 1e6);
    const color = new ImageData(w, h);
    const hgt = new Float32Array(w * h);
    const mx = tileMm[0] / w;
    const my = tileMm[1] / h;
    const P = (mm: number, axis: 0 | 1) => Math.max(1, Math.round(tileMm[axis] / mm));
    const wpx = P(220, 0), wpy = P(500, 1);
    const fpx = P(900, 0), fpy = P(700, 1);
    const jpx = P(25, 0), jpy = P(160, 1);
    const spx = P(0.7, 0), spy = P(opts.streakMm ?? 45, 1);
    const s2x = P(2.5, 0), s2y = P(120, 1);
    const bpx = P(opts.bandMm ?? 110, 0), bpy = P(1400, 1);
    // 節（タイルの中に数個）
    const kn: [number, number, number][] = [];
    for (let k = 0; k < Math.round(knots * 6); k++) kn.push([rand() * tileMm[0], rand() * tileMm[1], 4 + rand() * 7]);
    for (let y = 0; y < h; y++) {
      const Y = y * my;
      for (let x = 0; x < w; x++) {
        const X = x * mx;
        // 年輪の線をうねらせる
        let u = X + (pnoise((X / tileMm[0]) * wpx, (Y / tileMm[1]) * wpy, wpx, wpy, seed) - 0.5) * 2 * warp;
        if (flame) u += (pnoise((X / tileMm[0]) * fpx, (Y / tileMm[1]) * fpy, fpx, fpy, seed + 7) - 0.5) * 2 * flame;
        const jit = pnoise((X / tileMm[0]) * jpx, (Y / tileMm[1]) * jpy, jpx, jpy, seed + 3);
        const r = u / spacing + jit * 0.8;
        const fr = r - Math.floor(r);
        // 年輪の線（片側がくっきり、反対側はぼける）
        const lw = opts.lineW ?? 0.12;
        const ln = fr < lw ? 1 - fr / lw : fr > 1 - lw ? ((fr - (1 - lw)) / lw) * 0.4 : 0;
        const st = pnoise((X / tileMm[0]) * spx, (Y / tileMm[1]) * spy, spx, spy, seed + 11);
        const st2 = pnoise((X / tileMm[0]) * s2x, (Y / tileMm[1]) * s2y, s2x, s2y, seed + 13);
        const bd = pnoise((X / tileMm[0]) * bpx, (Y / tileMm[1]) * bpy, bpx, bpy, seed + 17);
        let k = 1 + (bd - 0.5) * 2 * band + (st - 0.5) * fine * 1.4 + (st2 - 0.5) * fine;
        let d = ln * line + Math.max(0, 0.35 - st) * fine * 1.5;
        for (const [kx, ky, kr] of kn) {
          const dd = ((X - kx) / kr) ** 2 + ((Y - ky) / (kr * 1.8)) ** 2;
          if (dd < 1) d += (1 - dd) * 0.5;
        }
        d = Math.min(0.8, d);
        const i = y * w + x;
        const col = mix(c, dk, d);
        put(color.data, i, col, k * (1 - d * 0.35));
        hgt[i] = 0.5 - d * 0.5 + (st - 0.5) * 0.2;
      }
    }
    return { color, height: hgt };
  };
}

/**
 * 流れる筋の石（AICA TJ-10235K の斜めのマーブル、FJ-901ZD のうねる御影石）。
 * 筋の向きは tile の中で a 本・b 本で一周する方向（継ぎ目なく繰り返す）。warp で筋をうねらせ、白い細い脈（veins）と粒（speckle）を足す
 */
function flowStone(base: string, tileMm: [number, number], opts: { a?: number; b?: number; warp?: number; band?: number; light?: string; vein?: number; speckle?: number } = {}) {
  const c = rgb(base);
  const lc = rgb(opts.light ?? base);
  const a = opts.a ?? 1;
  const b = opts.b ?? 1;
  const warp = opts.warp ?? 0.3;
  const band = opts.band ?? 0.25;
  const vein = opts.vein ?? 0;
  const speckle = opts.speckle ?? 0.05;
  return (w: number, h: number, rand: Rand): Generated => {
    const seed = Math.floor(rand() * 1e6);
    const color = new ImageData(w, h);
    const hgt = new Float32Array(w * h);
    const P = (mm: number, axis: 0 | 1) => Math.max(1, Math.round(tileMm[axis] / mm));
    const w1x = P(400, 0), w1y = P(400, 1);
    const w2x = P(120, 0), w2y = P(120, 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const v = y / h;
        const wp = (pnoise(u * w1x, v * w1y, w1x, w1y, seed) - 0.5) * warp + (pnoise(u * w2x, v * w2y, w2x, w2y, seed + 1) - 0.5) * warp * 0.35;
        // 筋の位置（1 周 = 1）。a・b が整数なので継ぎ目なく繰り返す
        const ph = a * u + b * v + wp;
        let s = 0;
        let amp = 1;
        let tot = 0;
        for (const f of [7, 17, 41, 97]) {
          s += pnoise(ph * f, 0.5, f, 4, seed + f) * amp;
          tot += amp;
          amp *= 0.6;
        }
        s /= tot;
        // 白い細い脈は筋の向きに沿って（ところどころで途切れる）
        // 筋はところどころで濃く、ところどころで消える（2D のまだら）
        const patch = 0.25 + 1.1 * pnoise(u * w2x * 0.6, v * w2y * 0.6, Math.max(1, Math.round(w2x * 0.6)), Math.max(1, Math.round(w2y * 0.6)), seed + 5);
        // 白い細い脈は筋の向きに沿って（ところどころで途切れる）
        const vn = vein ? Math.max(0, ridge(pnoise(ph * 61, 0.5, 61, 4, seed + 9)) - 0.95) * 20 * vein * Math.max(0, patch - 0.6) * 2.5 : 0;
        const sp = (rand() - 0.5) * speckle;
        const t = Math.min(1, Math.max(0, (s - 0.5) * 8 * band * patch + 0.5));
        const i = y * w + x;
        put(color.data, i, mix(c, lc, t), 1 + (t - 0.5) * band * 0.5 + vn + sp);
        hgt[i] = s;
      }
    }
    return { color, height: hgt };
  };
}

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
function boards(base: string, boardW: number, boardL: number, rows: number, opts: { mottle?: number; variation?: number; vein?: string } = {}) {
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
    // 大理石調: 板をまたいで流れる細い筋
    const vc = opts.vein ? rgb(opts.vein) : null;
    const warp = vc ? fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 400), cellsY: cellsFor(tileMm[1], 400), octaves: 6, persistence: 0.55 }) : null;
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
        if (vc && warp) {
          const t = (x / w) * 2 + y / h + warp[i] * 4;
          const v = Math.pow(1 - Math.abs(Math.sin(t * Math.PI)), 16);
          put(color.data, i, mix(c, vc, v * 0.6), k);
        } else put(color.data, i, c, k);
      }
    }
    return { color, height };
  };
}

/** コンクリート打ち放し調。型枠の継ぎ目と P コンの穴（holes: false で穴なし） */
/**
 * 大判のタイルを縦の列ごとにずらして貼った柄（TH34645 など）。cols は [列の左端 mm, 列の右端 mm, 横の目地の高さ mm（画像の上から）]。
 * タイルの面は細かいざらつきとゆるいムラ（錆びた金属のような）、目地は細い暗い線
 */
/**
 * 積石（TH34653）。高さのばらばらな薄い石を横に積み、石ごとに濃さが違い、横に流れる筋と影になる目地
 */
function ledgerStone(base: string, tileMm: [number, number], opts: { rowMin?: number; rowMax?: number; minLen?: number; maxLen?: number; contrast?: number } = {}) {
  const c = rgb(base);
  const ct = opts.contrast ?? 0.3;
  return (w: number, h: number, rand: Rand): Generated => {
    const px = w / tileMm[0];
    const py = h / tileMm[1];
    // 段の高さを繰り返しの高さに収める
    const rows: [number, number][] = [];
    let y0 = 0;
    while (y0 < tileMm[1]) {
      let rh = (opts.rowMin ?? 25) + rand() * ((opts.rowMax ?? 80) - (opts.rowMin ?? 25));
      if (tileMm[1] - y0 - rh < (opts.rowMin ?? 25)) rh = tileMm[1] - y0;
      rows.push([y0, y0 + rh]);
      y0 += rh;
    }
    // 段ごとに石の切れ目（横は繰り返しの幅で回り込む）
    const cuts = rows.map(() => {
      const out: number[] = [];
      let x = rand() * tileMm[0];
      const end = x + tileMm[0];
      while (x < end - (opts.minLen ?? 120)) {
        out.push(x % tileMm[0]);
        x += (opts.minLen ?? 120) + rand() * ((opts.maxLen ?? 420) - (opts.minLen ?? 120));
      }
      return out.sort((a, b) => a - b);
    });
    const tones = cuts.map((cs) => cs.map(() => 1 + (rand() - 0.5) * 2 * ct));
    const streak = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 60), cellsY: cellsFor(tileMm[1], 4), octaves: 4, persistence: 0.6 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 2), cellsY: cellsFor(tileMm[1], 2), octaves: 2 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const gap = 2.5;
    for (let y = 0; y < h; y++) {
      const Y = y / py;
      const ri = Math.max(0, rows.findIndex(([a, b]) => Y >= a && Y < b));
      const [ra, rb] = rows[ri];
      const cs = cuts[ri];
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const X = x / px;
        let si = cs.length - 1;
        for (let j = 0; j < cs.length; j++) if (X >= cs[j]) si = j;
        let dx = Infinity;
        for (const cx of cs) dx = Math.min(dx, Math.abs(X - cx), tileMm[0] - Math.abs(X - cx));
        const dy = Math.min(Y - ra, rb - Y);
        let k = tones[ri][si] * (1 + (streak[i] - 0.5) * ct * 1.4 + (f[i] - 0.5) * 0.12 + (rand() - 0.5) * 0.06);
        height[i] = 0.6 + (streak[i] - 0.5) * 0.3;
        const e = Math.min(dx, dy);
        if (e < gap) {
          k *= 0.35 + 0.4 * (e / gap);
          height[i] = 0.2;
        } else if (Y - ra < gap * 2.5) k *= 1.08; // 石の上の縁は光が当たって明るい
        put(color.data, i, c, k);
      }
    }
    return { color, height };
  };
}

function stepTiles(base: string, tileMm: [number, number], cols: [number, number, number][], opts: { mottle?: number; seam?: number } = {}) {
  const c = rgb(base);
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 260), cellsY: cellsFor(tileMm[1], 260), octaves: 5, persistence: 0.6 });
    const g = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 3), cellsY: cellsFor(tileMm[1], 3), octaves: 2 });
    const color = new ImageData(w, h);
    const height = new Float32Array(w * h);
    const px = w / tileMm[0];
    const py = h / tileMm[1];
    const sw = Math.max(1.2, 1.5 * px);
    const tone = cols.map(() => [1 + (rand() - 0.5) * 0.06, 1 + (rand() - 0.5) * 0.06]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const X = x / px;
        const ci = Math.max(0, cols.findIndex(([a, b]) => X >= a && X < b));
        const [a, b, sy] = cols[ci];
        const Y = y / py;
        const t = tone[ci][Y < sy ? 0 : 1];
        let k = t * (1 + (m[i] - 0.5) * (opts.mottle ?? 0.18) + (g[i] - 0.5) * 0.12 + (rand() - 0.5) * 0.05);
        height[i] = 0.7 + (g[i] - 0.5) * 0.15;
        const ex = Math.min(Math.abs(X - a), Math.abs(X - b)) * px;
        const ey = Math.min(Math.abs(Y - sy), Y, tileMm[1] - Y) * py;
        if (ex < sw || ey < sw) {
          k *= opts.seam ?? 0.7;
          height[i] = 0.45;
        }
        put(color.data, i, c, k);
      }
    }
    return { color, height };
  };
}

function concretePanels(base: string, tileMm: [number, number], panel: [number, number], opts: { holes?: boolean; toneVar?: number; seam?: number } = {}) {
  const c = rgb(base);
  return (w: number, h: number, rand: Rand): Generated => {
    const m = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 300), cellsY: cellsFor(tileMm[1], 300), octaves: 6, persistence: 0.6 });
    const f = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 4), cellsY: cellsFor(tileMm[1], 4), octaves: 2 });
    // 中くらいのしみ（2〜6cm）
    const mid = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 40), cellsY: cellsFor(tileMm[1], 60), octaves: 3, persistence: 0.6 });
    // 細いひび・かすれ
    const fine = fbm(w, h, rand, { cellsX: cellsFor(tileMm[0], 12), cellsY: cellsFor(tileMm[1], 12), octaves: 3, persistence: 0.55 });
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
        const crack = Math.max(0, ridge(fine[i]) - 0.9) * 2.5;
        let k = tone[(cx * 3 + cy * 5) % 16] * (1 + (m[i] - 0.5) * 0.4 + (mid[i] - 0.5) * 0.35 + (f[i] - 0.5) * 0.14 + (rand() - 0.5) * 0.06 - crack);
        height[i] = 0.7 + (f[i] - 0.5) * 0.1;
        // 型枠の継ぎ目
        const ex = Math.min(x % pw, pw - (x % pw));
        const ey = Math.min(y % ph, ph - (y % ph));
        if (Math.min(ex, ey) < Math.max(1.2, 1.5 * px)) {
          k *= opts.seam ?? 0.82;
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
/** ウォークスルーで試せる候補の床（ラシッサ Dフロア耐水UDわん） */
export const CANDIDATE_FLOORS = ['floor-lassissa-mortar', 'floor-lassissa-marblewhite', 'floor-lassissa-lightgray', 'floor-lassissa-sandblack', 'floor-lassissa-greigeelm'];

// 品番のアルファベット順（FE → HF → SP → TH）に並べて出す
export const CANDIDATE_WALLPAPERS = [
  'cross-sp2539', 'cross-sp2540', 'cross-sp2541', 'cross-th34082', 'cross-th34083', 'cross-th34084', 'cross-th34282', 'cross-th34283', 'cross-fe78140', 'cross-th34705', 'cross-th34706', 'cross-hf3068', 'cross-hf3005', 'cross-hf3045', 'cross-hf3004', 'cross-hf3113', 'cross-th34788', 'cross-th34789', 'cross-th34790', 'cross-th34776', 'cross-th34774', 'cross-th34736',
  'cross-sp2563', 'cross-sp2562', 'cross-sp2553', 'cross-sp2533', 'cross-hf3122', 'cross-th34102', 'cross-th34190', 'cross-th34606', 'cross-th34672', 'cross-fe76650', 'cross-fe76649',
  'cross-th34604', 'cross-th34191', 'cross-th34213', 'cross-th34645', 'cross-th34072', 'cross-th34081', 'cross-th34149', 'cross-th34150',
  'cross-hf3101', 'cross-hf3102', 'cross-hf3119', 'cross-hf3121', 'cross-hf3020', 'cross-re55622', 'cross-sp2549', 'cross-sp2565', 'cross-fe78165', 'cross-fe78138', 'cross-fe78152', 'cross-re55455', 'cross-th34464', 'cross-th34465', 'cross-th34466', 'cross-th34468', 'cross-th34523',
  'cross-th34187', 'cross-th34188', 'cross-th34193', 'cross-th34194', 'cross-th34141', 'cross-th34172', 'cross-th34554', 'cross-th34613', 'cross-th34634', 'cross-th34653', 'cross-th34654', 'cross-th34657', 'cross-th34658', 'cross-th34659', 'cross-th34660', 'cross-th34661', 'cross-th34662', 'cross-th34663', 'cross-th34664', 'cross-th34665', 'cross-th34668', 'cross-th34669', 'cross-th34671', 'cross-th34681', 'cross-th34725', 'cross-th34738', 'cross-th34740', 'cross-th34754', 'cross-th34773', 'cross-th34781',
].sort();

/**
 * 「クロスを試す」の候補の分け方（2026-10-22。notes/cross-candidates.md の 9 カテゴリ）。カテゴリの中は明るい色から暗い色の順。
 * funcs はサンゲツ公式の商品ページの機能のマーク（撥水・汚れ防止・表面強化・消臭。抗菌・防かびはほぼ全部にあるので省いた）
 */
export const WALLPAPER_CATEGORIES: { name: string; items: { id: string; funcs: string[] }[] }[] = [
  { name: 'SP（無料）', items: [{ id: 'cross-sp2539', funcs: ['撥水', '表面強化'] }, { id: 'cross-sp2540', funcs: ['撥水', '表面強化'] }, { id: 'cross-sp2549', funcs: ['撥水', '表面強化'] }, { id: 'cross-sp2563', funcs: ['撥水', '表面強化'] }, { id: 'cross-sp2541', funcs: ['撥水', '表面強化'] }, { id: 'cross-sp2565', funcs: ['撥水', '表面強化'] }, { id: 'cross-sp2562', funcs: ['撥水', '表面強化'] }, { id: 'cross-sp2553', funcs: [] }, { id: 'cross-sp2533', funcs: [] }] },
  { name: '石目・ストーン', items: [{ id: 'cross-th34193', funcs: ['消臭'] }, { id: 'cross-hf3119', funcs: ['表面強化'] }, { id: 'cross-th34102', funcs: ['撥水', '表面強化'] }, { id: 'cross-hf3101', funcs: ['表面強化'] }, { id: 'cross-hf3102', funcs: ['表面強化'] }, { id: 'cross-th34669', funcs: [] }, { id: 'cross-th34554', funcs: ['汚れ防止', '表面強化'] }, { id: 'cross-fe78165', funcs: [] }, { id: 'cross-th34194', funcs: ['消臭'] }, { id: 'cross-hf3121', funcs: ['表面強化'] }, { id: 'cross-th34191', funcs: ['撥水'] }, { id: 'cross-th34634', funcs: [] }] },
  { name: '塗り壁（コテ跡・スタッコ）', items: [{ id: 'cross-th34213', funcs: ['撥水'] }, { id: 'cross-th34188', funcs: ['表面強化', '消臭'] }, { id: 'cross-th34072', funcs: ['撥水', '表面強化', '消臭'] }, { id: 'cross-th34187', funcs: ['表面強化', '消臭'] }, { id: 'cross-th34082', funcs: ['撥水', '表面強化', '消臭'] }, { id: 'cross-th34081', funcs: ['撥水', '表面強化', '消臭'] }, { id: 'cross-th34083', funcs: ['撥水', '表面強化', '消臭'] }, { id: 'cross-hf3122', funcs: ['表面強化'] }, { id: 'cross-th34084', funcs: ['撥水', '表面強化', '消臭'] }] },
  { name: '漆喰・無地', items: [{ id: 'cross-th34660', funcs: ['消臭'] }, { id: 'cross-th34657', funcs: ['消臭'] }, { id: 'cross-th34464', funcs: ['汚れ防止', '表面強化'] }, { id: 'cross-th34661', funcs: ['消臭'] }, { id: 'cross-th34658', funcs: ['消臭'] }, { id: 'cross-th34465', funcs: ['汚れ防止', '表面強化'] }, { id: 'cross-re55455', funcs: ['汚れ防止', '表面強化'] }, { id: 'cross-th34662', funcs: ['消臭'] }, { id: 'cross-th34466', funcs: ['汚れ防止', '表面強化'] }, { id: 'cross-th34659', funcs: ['消臭'] }, { id: 'cross-th34523', funcs: ['汚れ防止', '表面強化'] }] },
  { name: 'コンクリート・モルタル', items: [{ id: 'cross-th34654', funcs: [] }, { id: 'cross-fe76649', funcs: ['撥水'] }, { id: 'cross-th34671', funcs: [] }, { id: 'cross-th34668', funcs: [] }, { id: 'cross-fe78138', funcs: ['撥水', '表面強化'] }, { id: 'cross-th34663', funcs: [] }, { id: 'cross-th34672', funcs: [] }, { id: 'cross-fe78152', funcs: [] }, { id: 'cross-th34664', funcs: [] }, { id: 'cross-fe76650', funcs: ['撥水'] }, { id: 'cross-fe78140', funcs: ['撥水', '表面強化'] }, { id: 'cross-th34665', funcs: [] }] },
  { name: 'メタル・タイル・レザー', items: [{ id: 'cross-th34468', funcs: ['汚れ防止'] }, { id: 'cross-th34645', funcs: ['撥水'] }, { id: 'cross-th34604', funcs: ['撥水'] }, { id: 'cross-th34653', funcs: [] }, { id: 'cross-re55622', funcs: ['撥水'] }, { id: 'cross-th34681', funcs: [] }, { id: 'cross-th34606', funcs: ['撥水'] }, { id: 'cross-th34613', funcs: [] }] },
  { name: '織物・布', items: [{ id: 'cross-th34150', funcs: ['撥水', '表面強化'] }, { id: 'cross-th34282', funcs: ['撥水', '表面強化', '消臭'] }, { id: 'cross-th34149', funcs: ['撥水', '表面強化'] }, { id: 'cross-th34283', funcs: ['撥水', '表面強化', '消臭'] }, { id: 'cross-th34141', funcs: [] }, { id: 'cross-th34172', funcs: [] }] },
  { name: '木目', items: [{ id: 'cross-th34725', funcs: ['汚れ防止', '表面強化'] }, { id: 'cross-hf3005', funcs: ['表面強化'] }, { id: 'cross-hf3068', funcs: ['表面強化'] }, { id: 'cross-th34705', funcs: [] }, { id: 'cross-hf3004', funcs: ['表面強化'] }, { id: 'cross-hf3113', funcs: ['表面強化'] }, { id: 'cross-hf3045', funcs: ['表面強化'] }, { id: 'cross-th34738', funcs: ['汚れ防止', '表面強化'] }, { id: 'cross-th34773', funcs: [] }, { id: 'cross-th34736', funcs: ['汚れ防止', '表面強化'] }, { id: 'cross-th34754', funcs: [] }, { id: 'cross-th34190', funcs: ['撥水'] }, { id: 'cross-th34706', funcs: [] }, { id: 'cross-th34740', funcs: ['汚れ防止', '表面強化'] }, { id: 'cross-hf3020', funcs: ['表面強化'] }] },
  { name: '板張り・OSB', items: [{ id: 'cross-th34788', funcs: [] }, { id: 'cross-th34789', funcs: [] }, { id: 'cross-th34776', funcs: [] }, { id: 'cross-th34774', funcs: ['表面強化'] }, { id: 'cross-th34781', funcs: [] }, { id: 'cross-th34790', funcs: [] }] },
];

/** 室内ドア LIXIL ラフィスの色柄（ウォークスルーで扉をクリックして試す）。色は施工例の写真からの推定 */
export const RAFFIS_COLORS = ['raffis-preciouswhite', 'raffis-gray', 'raffis-taupe', 'raffis-black', 'raffis-faboak', 'raffis-tellwalnut', 'raffis-purewhite'];

/** 神谷コーポレーション（KAMIYA）フルハイトドア CALM の色（CH-1 型は木目なしの単色、NH-1 型は木目）。色は 2026 セレクトカタログ vol.2 p.233 の色見本から */
/** CALM の色の代表の色（枠の色を扉に合わせるため） */
export const CALM_HEX: Record<string, string> = {
  'calm-tb': '#1f1d1e', 'calm-fg': '#969698', 'calm-dg': '#867e71', 'calm-ih': '#cfcabe', 'calm-sh': '#f3f3f1',
  'calm-uw': '#5b4745', 'calm-ew': '#7f644c', 'calm-mo': '#bb9770', 'calm-uo': '#d7cdb4', 'calm-uh': '#efe8d8',
};
export const CALM_COLORS = ['calm-tb', 'calm-fg', 'calm-dg', 'calm-ih', 'calm-sh', 'calm-uw', 'calm-ew', 'calm-mo', 'calm-uo', 'calm-uh'];

const door = (id: string, name: string, draw: MaterialDef['draw'], tile: [number, number], roughness: number): MaterialDef => ({ id, name, categories: [], tile, roughness, bump: 0.2, draw });

export const BUILTIN_MATERIALS: MaterialDef[] = [
  // ---- 室内ドア（LIXIL ラフィス） ----
  door('raffis-preciouswhite', 'ラフィス プレシャスホワイト', plaster('#ecebe6', 900, { mottle: 0.01 }), [900, 900], 0.6),
  door('raffis-gray', 'ラフィス グレー', plaster('#9b9a96', 900, { mottle: 0.015 }), [900, 900], 0.6),
  door('raffis-taupe', 'ラフィス トープ', plaster('#8b8178', 900, { mottle: 0.015 }), [900, 900], 0.6),
  door('raffis-black', 'ラフィス ブラック', plaster('#2b2b2b', 900, { mottle: 0.01 }), [900, 900], 0.55),
  door('raffis-faboak', 'ラフィス ファブオーク（木目）', woodPaper('#b99c78', [900, 900], { contrast: 0.14 }), [900, 900], 0.6),
  door('raffis-tellwalnut', 'ラフィス テルウォルナット（木目）', woodPaper('#6a5241', [900, 900], { contrast: 0.2 }), [900, 900], 0.6),
  door('calm-tb', 'CALM CH-1 サタンブラック（TB）', plaster('#1f1d1e', 900, { mottle: 0.01 }), [900, 900], 0.6),
  door('calm-fg', 'CALM CH-1 フラットグレー（FG）', plaster('#969698', 900, { mottle: 0.01 }), [900, 900], 0.6),
  door('calm-dg', 'CALM CH-1 ディープグレー（DG）', plaster('#867e71', 900, { mottle: 0.01 }), [900, 900], 0.6),
  door('calm-ih', 'CALM CH-1 ストーンホワイト（IH）', plaster('#cfcabe', 900, { mottle: 0.01 }), [900, 900], 0.6),
  door('calm-sh', 'CALM CH-1 シェルホワイト（SH）', plaster('#f3f3f1', 900, { mottle: 0.005 }), [900, 900], 0.55),
  door('calm-uw', 'CALM NH-1 トラッドウォルナット（UW・木目）', woodPaper('#5b4745', [900, 900], { contrast: 0.2 }), [900, 900], 0.6),
  door('calm-ew', 'CALM NH-1 ヨーロピアンウォルナット（EW・木目）', woodPaper('#7f644c', [900, 900], { contrast: 0.16 }), [900, 900], 0.6),
  door('calm-mo', 'CALM NH-1 モルトオーク（MO・木目）', woodPaper('#bb9770', [900, 900], { contrast: 0.14 }), [900, 900], 0.6),
  door('calm-uo', 'CALM NH-1 スカンジナビアオーク（UO・木目）', woodPaper('#d7cdb4', [900, 900], { contrast: 0.12 }), [900, 900], 0.6),
  door('calm-uh', 'CALM NH-1 ニュアンスホワイト（UH・木目）', woodPaper('#efe8d8', [900, 900], { contrast: 0.06 }), [900, 900], 0.6),
  door('raffis-purewhite', 'ラフィス ピュアホワイト（鏡面）', plaster('#f3f3f1', 900, { mottle: 0.005 }), [900, 900], 0.12),
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
  // LIXIL ラシッサ Dフロア耐水UDわん（素材柄）。板は 幅455（幅広）× 長さ1818、継ぎ目は V 溝
  floor('floor-lassissa-mortar', 'LIXIL ラシッサ Dフロア耐水UDわん ラフモルタル調', boards('#8e8b87', 455, 1818, 4, { mottle: 0.2 }), [1818, 1820], 0.55, 1.2),
  floor('floor-lassissa-sandblack', 'LIXIL ラシッサ Dフロア耐水UDわん サンドブラック調', boards('#5b5957', 455, 1818, 4, { mottle: 0.15 }), [1818, 1820], 0.55, 1.2),
  floor('floor-lassissa-marblewhite', 'LIXIL ラシッサ Dフロア耐水UDわん マーブルホワイト調', boards('#e6e5e2', 455, 1818, 4, { mottle: 0.06, variation: 0.03, vein: '#a9aaac' }), [1818, 1820], 0.35, 1.0),
  // 木目柄（グレージュエルムF）。施工例では灰みのあるグレージュの板で、木目と節がはっきり出る
  floor('floor-lassissa-greigeelm', 'LIXIL ラシッサ Dフロア耐水UDわん グレージュエルムF', flooring(['#aaa49b', '#9f998f', '#b4ada4', '#958f86'], 150, FLOOR_TILE, { grainContrast: 0.18 }), FLOOR_TILE, 0.55, 1.4),
  floor('floor-lassissa-lightgray', 'LIXIL ラシッサ Dフロア耐水UDわん ライトクレイ調', boards('#b8b6b1', 455, 1818, 4, { mottle: 0.12 }), [1818, 1820], 0.55, 1.2),

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
  wall('cross-sp2540', 'SP2540 石目調ライトグレー', crinkle('#d3d2ce', [600, 600], { size: 4, shade: 1.1 }), [600, 600], 0.92, 1.4),
  wall('cross-sp2539', 'SP2539 石目調ホワイト', crinkle('#dcdbd7', [600, 600], { size: 3.5, shade: 0.4 }), [600, 600], 0.92, 0.9),
  wall('cross-sp2541', 'SP2541 石目調グレー', crinkle('#b1b0ac', [600, 600], { size: 3.5, shade: 0.95 }), [600, 600], 0.92, 1.1),
  // SP2563 は目地のない、細かい粒が散ったコンクリート柄（リピート 32×46cm）
  // 商品名は「コンクリート調 ライトグレー」。茶色みのない明るいグレー（SP2565 の色違い）
  wall('cross-sp2563', 'SP2563 コンクリート調ライトグレー', sand('#c5c5c2', [460, 320], { grain: 0.18, mottle: 0.02, mottleMm: 120, size: 2 }), [460, 320], 0.9, 1.2),
  wall('cross-sp2562', 'SP2562 織物調ダークグレージュ', linen('#5f5b58', [300, 300], { pitch: 1.3, contrast: 0.6, light: 1.2 }), [300, 300], 0.7, 1.0),
  // SP2562 の別色（こだわりシリーズ・無地・92cm 巾）。色は施工例の壁（#c1b7a9）と見本（#c3bbb5）の間
  wall('cross-sp2553', 'SP2553 織物調ライトグレージュ（SP2562 の別色）', linen('#bfb7ae', [300, 300], { pitch: 1.3, contrast: 0.45, light: 1.15 }), [300, 300], 0.7, 1.0),
  // こだわりシリーズ・無地（SP2530〜2532 の別色）。吹き付けのような細かい凹凸。色は見本（#d0cac1）と施工例の壁（#b9b5a9）の間
  wall('cross-sp2533', 'SP2533 塗り調グレージュ（吹き付け風の凹凸）', crinkle('#c8c1b6', [600, 600], { size: 4, shade: 1.2 }), [600, 600], 0.92, 1.4),
  wall('cross-hf3122', 'HF3122 モルタル調グレー（ハードウォール）', cloud('#78787a', [920, 640], { cloud: 0.2, cloudMm: 120, grain: 0.11 }), [920, 640], 0.85, 0.9),
  wall('cross-th34102', 'TH34102 石目調ライトグレー（パール）', sand('#cacccc', [462, 320], { grain: 0.07, mottle: 0.03, mottleMm: 140, pearl: 0.04, veins: 0.06 }), [462, 320], 0.8, 0.9),
  // 公式の柄画像（2026-10-22 に見比べ）: 神代杉の柾目。暖かみのあるスモーキーなグレーブラウン（平均 RGB 96・86・83）に、細い縦の筋が密に並ぶ。むらは少なく、ゆるい濃淡の縦の帯
  wall('cross-th34190', 'TH34190 process#100 CAVIERA（木目調・神代杉 柾目・スモーキーなグレーブラウン）', grain('#625855', [920, 641], { spacing: 2.2, warp: 1.2, line: 0.04, lineW: 0.2, fine: 0.13, band: 0.07, bandMm: 60, streakMm: 70, dark: '#4d4441' }), [920, 641], 0.75, 0.6),
  // TOTO サザナ HT シリーズの見積もりの色。施工例の写真に合わせた
  // FAITH の織物調（施工例では落ち着いた中間のグレー）
  wall('cross-th34282', 'TH34282 織物調ライトグレー', crosshatch('#bdbdbb', [925, 641], { contrast: 0.06, mottle: 0.03 }), [925, 641], 0.8, 0.7),
  wall('cross-th34283', 'TH34283 織物調グレー', crosshatch('#828387', [925, 641], { contrast: 0.16, mottle: 0.05 }), [925, 641], 0.8, 0.7),
  // 2026-10-19 追加（サンゲツ 25-28 フェイス・ハードウォール／ウッド。色は公式の柄画像の平均、柄・リピートも公式から）
  wall('cross-hf3068', 'HF3068 木目調（ハードウォール・ウォルナット 板柾・ナチュラル）', grain('#c7b299', [920, 930], { spacing: 24, warp: 12, flame: 30, line: 0.3, fine: 0.14, band: 0.24, bandMm: 45, dark: '#94785a' }), [920, 930], 0.8, 0.7),
  wall('cross-hf3005', 'HF3005 木目調（ハードウォール・ゼブラウッド 柾目・ライト）', grain('#d8c3b0', [920, 930], { spacing: 6, warp: 5, line: 0.7, lineW: 0.3, fine: 0.12, band: 0.16, bandMm: 12, dark: '#9c7a64' }), [920, 930], 0.8, 0.7),
  wall('cross-hf3045', 'HF3045 木目調（ハードウォール・ゼブラウッド 柾目・ミディアム）', grain('#b68e64', [920, 930], { spacing: 6, warp: 5, line: 0.7, lineW: 0.3, fine: 0.12, band: 0.16, bandMm: 12, dark: '#6e4a28' }), [920, 930], 0.8, 0.7),
  wall('cross-hf3004', 'HF3004 木目調（ハードウォール・プリマベラ 柾目・グレージュ）', grain('#b1a39b', [920, 930], { spacing: 3.5, warp: 4, line: 0.18, lineW: 0.25, fine: 0.22, band: 0.06, streakMm: 25, dark: '#8a7c74' }), [920, 930], 0.8, 0.7),
  wall('cross-hf3113', 'HF3113 木目調（ハードウォール・アッシュ 柾目・グレー）', grain('#9e948a', [920, 930], { spacing: 3, warp: 2, line: 0.12, lineW: 0.25, fine: 0.2, band: 0.05, streakMm: 30, dark: '#7f756c' }), [920, 930], 0.8, 0.7),
  wall('cross-th34736', 'TH34736 木目調（スーパー耐久性 オーク 柾目・ダークグレーブラウン）', grain('#70685d', [920, 930], { spacing: 6, warp: 5, line: 0.3, lineW: 0.3, fine: 0.22, band: 0.2, bandMm: 28, streakMm: 30, dark: '#4c453d' }), [920, 930], 0.8, 0.7),
  wall('cross-th34788', 'TH34788 OSB 調（ホワイト）', osb('#d8d7d5', [463, 230], { contrast: 0.2 }), [463, 230], 0.9, 1.0),
  wall('cross-th34789', 'TH34789 OSB 調（ナチュラル）', osb('#b89a74', [463, 230], { contrast: 0.42 }), [463, 230], 0.9, 1.0),
  wall('cross-th34790', 'TH34790 OSB 調（ダークグレー）', osb('#53504e', [463, 230], { contrast: 0.6 }), [463, 230], 0.9, 1.0),
  wall('cross-th34776', 'TH34776 木目調（斜めの板張り・ラスティック）', planks('#b08a66', [920, 1238], { angle: 45, plankW: 108.4, minLen: 500, maxLen: 1300, contrast: 0.45, vary: 0.32, knots: 0.7 }), [920, 1238], 0.85, 0.8),
  wall('cross-th34774', 'TH34774 木目調（細い板の縦張り・ウォルナット系）', planks('#866348', [920, 1240], { angle: 0, plankW: 920 / 30, minLen: 413, maxLen: 1240, contrast: 0.32, vary: 0.4, knots: 0.15 }), [920, 1240], 0.8, 0.8),
  // TH34705（25-28 フェイス・PROGRESS WOOD チェリー 柾目）: グレージュの柾目（まっすぐな縦の木目）、全体にマット。リピート タテ 92.9・ヨコ 92cm。色は公式の柄画像・見本（#aea498・#bbada0）から
  wall('cross-th34706', 'TH34706 木目調（PROGRESS WOOD エルム 板柾・ダークグレー）', grain('#4c4844', [925, 1240], { spacing: 26, warp: 14, flame: 45, line: 0.4, fine: 0.25, band: 0.22, bandMm: 70, knots: 0.3, dark: '#2c2a28' }), [925, 1240], 0.9, 0.7),
  wall('cross-th34705', 'TH34705 木目調（チェリー 柾目・グレージュ）', grain('#b2a89c', [920, 929], { spacing: 22, warp: 10, flame: 25, line: 0.35, fine: 0.2, band: 0.26, bandMm: 55, knots: 0.5, dark: '#6e6255' }), [920, 929], 0.85, 0.7),
  // 塗り壁調（施工例ではムラのあるやわらかいグレー）
  // 2026-10-22 追加（サンゲツ公式の柄画像と見比べ、色は柄画像の平均。機能は公式の商品ページの機能のマーク）
  wall('cross-th34604', 'TH34604 MATERIA FODINA（金属光沢の塗り調・ライトグレー）', cloud('#b9b5aa', [920, 641], { cloud: 0.05, cloudMm: 260, grain: 0.05, scratch: 0.35, crinkle: 0.05 }), [920, 641], 0.5, 0.6),
  wall('cross-th34191', 'TH34191 process#100 DROITE（石目にまっすぐな縦のストライプ・グレー）', grain('#747471', [920, 641], { spacing: 7, warp: 0.4, line: 0.05, lineW: 0.3, fine: 0.18, band: 0.12, bandMm: 30, streakMm: 400, dark: '#5c5c59' }), [920, 641], 0.85, 0.5),
  wall('cross-th34213', 'TH34213 biocloth Serene Stucco（大きなコテ跡の塗り壁・シャドーホワイト）', cloud('#dfe1df', [925, 641], { cloud: 0.035, cloudMm: 320, grain: 0.02 }), [925, 641], 0.9, 0.5),
  wall('cross-th34645', 'TH34645 マテリアル（大判の金属タイル・ずらし貼り・ライトグレー）', stepTiles('#c2bbb1', [920, 900], [[0, 160, 342], [160, 490, 595], [490, 920, 220]]), [920, 900], 0.75, 0.8),
  wall('cross-th34072', 'TH34072 塗り壁調（Naturescape Shades of Air・ナチュラル）', trowel('#d2d0cb', [925, 641]), [925, 641], 0.9, 1.0),
  wall('cross-th34081', 'TH34081 塗り壁調（Naturescape Shades of Air・グレージュ）', trowel('#b3aca9', [925, 641]), [925, 641], 0.9, 1.0),
  wall('cross-th34149', 'TH34149 process#100 SMOKY CHIC（煙ったような濃淡の織物調・グレー）', crosshatch('#9a9c98', [920, 628], { contrast: 0.14, mottle: 0.06 }), [920, 628], 0.8, 0.7),
  wall('cross-th34150', 'TH34150 process#100 SMOKY CHIC（煙ったような濃淡の織物調・ライトグレー）', crosshatch('#d9d8d7', [920, 628], { contrast: 0.06, mottle: 0.04 }), [920, 628], 0.8, 0.7),
  // 2026-10-23 追加（2 回目・30 品番。サンゲツ公式の柄画像と見比べ、色は柄画像の平均）
  wall('cross-th34187', 'TH34187 process#100 SHIMMER RIVER（縦に流れる塗り壁調・グレージュ）', grain('#c5c0b7', [925, 640], { spacing: 10, warp: 3, line: 0.01, fine: 0.02, band: 0.018, bandMm: 50, streakMm: 90 }), [925, 640], 0.95, 0.6),
  wall('cross-th34188', 'TH34188 process#100 SHIMMER RIVER（縦に流れる塗り壁調・シャドーホワイト）', grain('#e1e0dd', [925, 640], { spacing: 10, warp: 3, line: 0.008, fine: 0.015, band: 0.015, bandMm: 50, streakMm: 90 }), [925, 640], 0.95, 0.6),
  wall('cross-th34193', 'TH34193 process#100 PETRICHOR（ほのかなテラゾー・ホワイト）', sand('#e7e5e2', [920, 641], { grain: 0.04, mottle: 0.015, mottleMm: 60, size: 3 }), [920, 641], 0.9, 0.8),
  wall('cross-th34194', 'TH34194 process#100 PETRICHOR（ほのかなテラゾー・グレー）', sand('#9e9b9a', [920, 641], { grain: 0.1, mottle: 0.03, mottleMm: 60, size: 3 }), [920, 641], 0.9, 0.8),
  wall('cross-th34141', 'TH34141 process#100 SLOW AND MELLOW（パールの織物調・グレー）', linen('#827f80', [462, 321], { pitch: 0.7, contrast: 0.22, light: 0.15 }), [462, 321], 0.75, 1.0),
  wall('cross-th34172', 'TH34172 process#100 WAVING SHADOW（揺らぐ影の織物調・グレージュ）', crosshatch('#77716f', [300, 300], { contrast: 0.14, mottle: 0.08 }), [300, 300], 0.8, 0.8),
  wall('cross-th34554', 'TH34554 スーパー耐久性（穏やかな抑揚のストーン調・グレー）', cloud('#aeada9', [925, 641], { cloud: 0.05, cloudMm: 300, grain: 0.05 }), [925, 641], 0.9, 0.6),
  wall('cross-th34613', 'TH34613 MATERIA CODILS（アニマルレザー調・スモークブラック）', cloud('#383630', [920, 641], { cloud: 0.25, cloudMm: 90, grain: 0.18, crinkle: 0.25 }), [920, 641], 0.7, 1.0),
  wall('cross-th34634', 'TH34634 マテリアル（割肌の石・ブラック）', sand('#40403c', [920, 940], { grain: 0.3, mottle: 0.12, mottleMm: 150, size: 3 }), [920, 940], 0.9, 1.4),
  wall('cross-th34653', 'TH34653 マテリアル（積石タイル・石英の光沢・グレー）', ledgerStone('#807c76', [920, 642], { rowMin: 20, rowMax: 90, minLen: 120, maxLen: 600, contrast: 0.3 }), [920, 642], 0.7, 1.4),
  wall('cross-th34654', 'TH34654 マテリアル（さりげない光沢と塗りムラのモルタル調・ライト）', cloud('#e2ddd8', [920, 1240], { cloud: 0.025, cloudMm: 220, grain: 0.03 }), [920, 1240], 0.85, 0.6),
  wall('cross-th34657', 'TH34657 マテリアル（漆喰調・ホワイト）', plaster('#e9e7df', 925, { mottle: 0.012, grain: 0.02 }), [925, 925], 0.9, 0.5),
  wall('cross-th34658', 'TH34658 マテリアル（漆喰調・グレー）', plaster('#c1bdb9', 925, { mottle: 0.015, grain: 0.025 }), [925, 925], 0.9, 0.5),
  wall('cross-th34659', 'TH34659 マテリアル（漆喰調・ダークグレー）', plaster('#5d5b5b', 925, { mottle: 0.02, grain: 0.03 }), [925, 925], 0.9, 0.5),
  wall('cross-th34660', 'TH34660 マテリアル（粒の見える塗り壁・ホワイト）', sand('#ecece9', [925, 613], { grain: 0.08, mottle: 0.02, mottleMm: 150, size: 2 }), [925, 613], 0.9, 1.0),
  wall('cross-th34661', 'TH34661 マテリアル（粒の見える塗り壁・グレージュ）', sand('#c5c0bd', [925, 613], { grain: 0.2, mottle: 0.03, mottleMm: 150, size: 2 }), [925, 613], 0.9, 1.0),
  wall('cross-th34662', 'TH34662 マテリアル（粒の見える塗り壁・グレー）', sand('#787574', [925, 613], { grain: 0.24, mottle: 0.04, mottleMm: 150, size: 2 }), [925, 613], 0.9, 1.0),
  wall('cross-th34663', 'TH34663 マテリアル（コンクリート調・ライトグレージュ）', cloud('#a7a195', [930, 940], { cloud: 0.12, cloudMm: 160, grain: 0.08 }), [930, 940], 0.85, 0.9),
  wall('cross-th34664', 'TH34664 マテリアル（コンクリート調・グレー）', cloud('#787772', [930, 940], { cloud: 0.1, cloudMm: 160, grain: 0.07 }), [930, 940], 0.85, 0.9),
  wall('cross-th34665', 'TH34665 マテリアル（コンクリート調・ダークグレー）', cloud('#4d4f50', [930, 940], { cloud: 0.12, cloudMm: 160, grain: 0.07 }), [930, 940], 0.85, 0.9),
  wall('cross-th34668', 'TH34668 マテリアル（金属質の塗りあとのモルタル調・グレー）', cloud('#ada9a6', [930, 1250], { cloud: 0.13, cloudMm: 200, grain: 0.04, scratch: 0.12 }), [930, 1250], 0.7, 0.8),
  wall('cross-th34669', 'TH34669 マテリアル（細かい粒の石目・ライトグレー）', grain('#b6b3b1', [463, 642], { spacing: 1.5, warp: 0.5, line: 0.03, lineW: 0.2, fine: 0.1, band: 0.03, bandMm: 20, streakMm: 30 }), [463, 642], 0.9, 1.0),
  wall('cross-th34671', 'TH34671 マテリアル（重厚なコンクリート調・グレー）', cloud('#b3b1b0', [920, 930], { cloud: 0.14, cloudMm: 200, grain: 0.08 }), [920, 930], 0.85, 1.0),
  wall('cross-th34681', 'TH34681 マテリアル（レザー調・スモークブラック）', cloud('#4a4c49', [930, 940], { cloud: 0.22, cloudMm: 220, grain: 0.08, crinkle: 0.15 }), [930, 940], 0.7, 0.8),
  wall('cross-th34725', 'TH34725 木目調（スーパー耐久性 ラインウッド 柾目・シャドーホワイト）', grain('#e1e1e1', [461, 930], { spacing: 3, warp: 1, line: 0.04, lineW: 0.3, fine: 0.05, band: 0.03, bandMm: 25, streakMm: 300, dark: '#d0d0d0' }), [461, 930], 0.8, 0.6),
  wall('cross-th34738', 'TH34738 木目調（スーパー耐久性 ウォルナット 柾目・ミディアムブラウン）', grain('#937557', [920, 930], { spacing: 3, warp: 1.5, line: 0.12, lineW: 0.3, fine: 0.12, band: 0.08, bandMm: 30, streakMm: 40, dark: '#7a5f45' }), [920, 930], 0.8, 0.7),
  wall('cross-th34740', 'TH34740 木目調（スーパー耐久性 ウォルナット 柾目・ダークブラウン）', grain('#4c382e', [920, 930], { spacing: 3, warp: 1.5, line: 0.12, lineW: 0.3, fine: 0.12, band: 0.08, bandMm: 30, streakMm: 40, dark: '#3a2a22' }), [920, 930], 0.8, 0.7),
  wall('cross-th34754', 'TH34754 木目調（eセコウ ウォルナット 板柾・ダークブラウン）', grain('#71604f', [930, 1250], { spacing: 20, warp: 12, flame: 35, line: 0.35, fine: 0.15, band: 0.2, bandMm: 45, dark: '#4a3c30' }), [930, 1250], 0.8, 0.9),
  wall('cross-th34773', 'TH34773 木目調（節とひび割れのアンティークパイン）', grain('#957346', [930, 1250], { spacing: 22, warp: 14, flame: 40, line: 0.45, fine: 0.18, band: 0.25, bandMm: 50, knots: 0.8, dark: '#5e4426' }), [930, 1250], 0.8, 1.0),
  wall('cross-th34781', 'TH34781 木目調（古木の板を並べたヴィンテージ・ダークブラウン）', grain('#6f5e53', [920, 1240], { spacing: 9, warp: 6, line: 0.3, fine: 0.16, band: 0.18, bandMm: 115, streakMm: 60, knots: 0.5, dark: '#4a3e36' }), [920, 1240], 0.85, 1.0),
  // 2026-10-23 追加（3 回目・17 品番。旧ファインは今の品番で。サンゲツ公式の柄画像と見比べ、色は柄画像の平均）
  wall('cross-hf3101', 'HF3101 ストーン（ハードウォール・ライトグレー）', cloud('#c7c3c1', [920, 640], { cloud: 0.06, cloudMm: 150, grain: 0.05 }), [920, 640], 0.85, 0.7),
  wall('cross-hf3102', 'HF3102 ストーン（ハードウォール・グレー）', cloud('#b6b5b3', [920, 640], { cloud: 0.06, cloudMm: 150, grain: 0.05 }), [920, 640], 0.85, 0.7),
  wall('cross-hf3119', 'HF3119 ストーン（ハードウォール・縦に流れるムラのオフホワイト）', cloud('#d9d4cc', [461, 641], { cloud: 0.06, cloudMm: 90, grain: 0.04 }), [461, 641], 0.85, 0.6),
  wall('cross-hf3121', 'HF3121 ストーン（ハードウォール・ほぼ無地のグレー）', cloud('#9c9b9a', [920, 640], { cloud: 0.05, cloudMm: 150, grain: 0.05 }), [920, 640], 0.85, 0.6),
  wall('cross-hf3020', 'HF3020 木目調（ハードウォール ラインウッド 柾目・ブラック）', grain('#373638', [460, 930], { spacing: 1.6, warp: 0.6, line: 0.25, lineW: 0.25, fine: 0.15, band: 0.1, bandMm: 15, streakMm: 200, dark: '#262527' }), [460, 930], 0.8, 0.7),
  wall('cross-re55622', 'RE55622 リザーブ MOTTLED RUST（錆のまだら・グレー）', cloud('#62605d', [920, 638], { cloud: 0.18, cloudMm: 110, grain: 0.07, crinkle: 0.3 }), [920, 638], 0.8, 1.0),
  wall('cross-sp2549', 'SP2549 塗り調ライトグレー', sand('#d2cec9', [463, 314], { grain: 0.03, mottle: 0.015, mottleMm: 100, size: 2 }), [463, 314], 0.9, 1.0),
  wall('cross-sp2565', 'SP2565 コンクリート調ブラック（SP2563 の別色）', sand('#7a7875', [460, 320], { grain: 0.24, mottle: 0.05, mottleMm: 120, size: 2 }), [460, 320], 0.9, 1.2),
  wall('cross-fe78165', 'FE78165 ストーン（透明感のある大理石調・グレージュ。旧 FE76668）', sand('#b2a89b', [930, 1250], { grain: 0.03, mottle: 0.07, mottleMm: 220, size: 3, veins: 0.1 }), [930, 1250], 0.6, 0.3),
  wall('cross-fe78138', 'FE78138 コンクリート（ウレタンコート・グレー。旧 FE76660）', cloud('#a7a39c', [920, 640], { cloud: 0.07, cloudMm: 160, grain: 0.05 }), [920, 640], 0.75, 0.7),
  wall('cross-fe78152', 'FE78152 コンクリート（大きなムラ・グレー。旧 FE76655）', cloud('#8f8984', [925, 928], { cloud: 0.3, cloudMm: 140, grain: 0.07 }), [925, 928], 0.85, 1.0),
  wall('cross-re55455', 'RE55455 リザーブ スーパー耐久性（塗り壁調・グレージュ。旧 FE76410）', cloud('#8e887d', [920, 641], { cloud: 0.08, cloudMm: 150, grain: 0.05 }), [920, 641], 0.85, 0.7),
  wall('cross-th34464', 'TH34464 フィルム汚れ防止 バリアタイプ（塗り壁調・ライトグレー）', cloud('#ded9d3', [925, 321], { cloud: 0.04, cloudMm: 120, grain: 0.05, crinkle: 0.2 }), [925, 321], 0.7, 0.8),
  wall('cross-th34465', 'TH34465 フィルム汚れ防止 バリアタイプ（塗り壁調・グレージュ）', cloud('#b4a89e', [925, 321], { cloud: 0.05, cloudMm: 120, grain: 0.06, crinkle: 0.2 }), [925, 321], 0.7, 0.8),
  wall('cross-th34466', 'TH34466 フィルム汚れ防止 バリアタイプ（塗り壁調・ダークブラウングレー）', cloud('#6b615b', [925, 321], { cloud: 0.06, cloudMm: 120, grain: 0.07, crinkle: 0.2 }), [925, 321], 0.7, 0.8),
  wall('cross-th34468', 'TH34468 フィルム汚れ防止 バリアタイプ（タイルのエンボス・ライトグレー）', stepTiles('#c2bfb9', [308, 314], [[0, 125, 200], [125, 308, 95]], { mottle: 0.04, seam: 0.9 }), [308, 314], 0.7, 1.0),
  wall('cross-th34523', 'TH34523 フィルム汚れ防止 バリアタイプ（塗り壁調・ブラック）', sand('#303136', [462, 310], { grain: 0.18, mottle: 0.04, mottleMm: 100, size: 2.5 }), [462, 310], 0.7, 1.0),
  wall('cross-th34082', 'TH34082 塗り壁調ライトグレー', trowel('#b9b8b4', [925, 641]), [925, 641], 0.9, 1.0),
  wall('cross-th34083', 'TH34083 塗り壁調グレー', trowel('#8e8d8a', [925, 641]), [925, 641], 0.9, 1.0),
  // TH34084（25-28 フェイス・Naturescape Shades of Air、TH34082・TH34083 と同じスタッコ柄のダークグレー。プリントとパールの濃淡）。リピート タテ 64.1・ヨコ 92.5cm、色は公式の柄画像・見本（#6b6767・#6f6a67）から
  wall('cross-th34084', 'TH34084 塗り壁調ダークグレー', trowel('#6c6868', [925, 641]), [925, 641], 0.9, 1.0),
  wall('cross-th32208', 'TH34307 マット（ニュアンスカラー・ベージュ。旧 TH32208）', plaster('#dad0c7', 600, { mottle: 0.012, grain: 0.02 }), [600, 600], 0.9, 0.3),
  // FINE コンクリート・ストーン。施工例ではざらっとしたダークブラウングレーのアクセント
  // FE78140（旧 FE76661 の後継・26-29 ファイン）: 目地や P コンのない無地のコンクリート調、ウレタンコート。リピート タテ 64・ヨコ 92cm。色は公式の柄画像・見本（#5c5952・#504f4b）と施工例の写真から
  wall('cross-fe78140', 'FE78140 コンクリート（無地・ダーク。リザーブ RE55616 も同じ柄）', cloud('#55534e', [920, 640], { cloud: 0.3, cloudMm: 140, grain: 0.08, crinkle: 0.9 }), [920, 640], 0.75, 1.0),
  wall('cross-th34606', 'TH34606 MATERIA FODINA（金属光沢の塗り調・ネイビーグレー）', cloud('#3c3e44', [920, 641], { cloud: 0.5, cloudMm: 200, grain: 0.07, scratch: 2.2, crinkle: 0.15 }), [920, 641], 0.5, 0.8),
  wall('cross-th34672', 'TH34672 コンクリート打ち放し調（P コン付き）', rawConcrete('#a59d96', [930, 1250]), [930, 1250], 0.85, 1.2),
  // FINE コンクリート・ストーン。30cm 角の型枠跡のダークグレーのコンクリート（施工例の写真に合わせた）
  // FE76650 の色違い（サンゲツ FINE コンクリート・ストーン）。販売店では「ライトグレー」。型枠跡の四角い目地は FE76650 と同じ
  wall('cross-fe76649', 'FE78149 コンクリート調（30cm 角の型枠跡・ライトグレー。旧 FE76649）', concretePanels('#b5b5b2', [925, 613], [925 / 3, 613 / 2], { holes: false, toneVar: 0.2, seam: 0.94 }), [925, 613], 0.85, 1.2),
  wall('cross-fe76650', 'FE78150 コンクリート調（30cm 角の型枠跡・ダークグレー。旧 FE76650。リザーブ RE55636 も同じ柄）', concretePanels('#6b6b69', [925, 613], [925 / 3, 613 / 2], { holes: false, toneVar: 0.3, seam: 0.9 }), [925, 613], 0.85, 1.2),
  wall('panel-sazana-greyishwalnut', 'TOTO サザナ 壁パネル グレイッシュウォルナット', woodPaper('#b8ada3', [900, 900], { contrast: 0.1, seam: true }), [900, 900], 0.4, 0.6),
  wall('panel-bath-woodgray', 'ユニットバス壁パネル（グレー木目）', woodPaper('#9b938c', [900, 900], { contrast: 0.08 }), [900, 900], 0.35, 0.6),

  // ---- 家具・造作の面材（家具の material で指定） ----
  // AICA。セルサス（指紋レスのマット）・セラール。色柄は商品画像と施工例に合わせた
  // AICA の化粧板（2026-10-19 アイカ公式の柄画像（4×8 版の全体）と見比べて作り直した。tile は版の大きさ）
  { id: 'aica-tj10235k', name: 'AICA TJ-10235K セルサス アールグレイマーブル／グレー（版の長手をカウンターの長さの方向に）', categories: [], tile: [2450, 1230], roughness: 0.75, bump: 0.1, draw: flowStone('#77746f', [2450, 1230], { a: 1, b: 1, warp: 0.05, band: 0.3, light: '#a7a49e', vein: 0.9, speckle: 0.16 }) },
  { id: 'aica-tj10240k', name: 'AICA TJ-10240K セルサス アンジェロプレーン／ダーク', categories: [], tile: [1230, 2450], roughness: 0.8, bump: 0.3, draw: cloud('#444545', [1230, 2450], { cloud: 0.85, cloudMm: 380, grain: 0.04 }) },
  { id: 'aica-fj901zd', name: 'AICA セラール FJGA901ZD（FJ-901ZD）パラディソ／ダーク ソフトマット 935×2455', categories: [], tile: [935, 2455], roughness: 0.55, bump: 0.4, draw: sand('#56534f', [935, 2455], { grain: 0.3, size: 6, mottle: 0.22, mottleMm: 200 }) },
  { id: 'aica-ji10346k', name: 'AICA JI-10346K アイカラビアン プレインセメント／ディープグレー', categories: [], tile: [1230, 2450], roughness: 0.7, bump: 0.2, draw: cloud('#9a9693', [1230, 2450], { cloud: 0.14, cloudMm: 260, grain: 0.03 }) },
  { id: 'aica-tj10237k', name: 'AICA TJ-10237K セルサス メタルオキシサビ／ダーク', categories: [], tile: [1230, 2450], roughness: 0.8, bump: 0.3, draw: cloud('#3a3c3b', [1230, 2450], { cloud: 0.38, cloudMm: 180, grain: 0.05, scratch: 0.6 }) },
  // トクラス コラージア（見積もりで選んだ色）
  { id: 'toclas-z-greystone', name: 'トクラス コラージア 扉 Zシリーズ グレーストーン', categories: [], tile: [900, 900], roughness: 0.7, bump: 0.4, draw: hStreak('#696868', [900, 900], { contrast: 0.14, light: 0.3 }) },
  { id: 'toclas-tenor-ironblack', name: 'トクラス テノール（人造大理石）アイアンブラック', categories: [], tile: [900, 900], roughness: 0.45, bump: 0.2, draw: stone('#2e2f31', 900, { contrast: 0.05, pores: 30, tint: '#2a2b2d' }) },
  { id: 'wood-darkbrown', name: '木目調（ダークブラウン・造作家具）', categories: [], tile: [900, 900], roughness: 0.6, bump: 0.5, draw: woodPaper('#4a3a30', [900, 900], { contrast: 0.14 }) },
  { id: 'wood-rosewood-dark', name: '木目調（ダークローズウッド・ピアノ）', categories: [], tile: [900, 900], roughness: 0.45, bump: 0.3, draw: woodPaper('#3b2620', [900, 900], { contrast: 0.12 }) },
  { id: 'marble-lightgray', name: '大理石調（ライトグレー・セラミック天板）', categories: [], tile: [1200, 1200], roughness: 0.35, bump: 0, draw: marble('#c3c0bb', '#dedbd6', 1200, { veins: 3, strength: 0.35 }) },
  { id: 'wood-oak-light', name: '木目調（ナチュラルオーク・今のベッド）', categories: [], tile: [900, 900], roughness: 0.6, bump: 0.4, draw: woodPaper('#dccab0', [900, 900], { contrast: 0.08 }) },
  { id: 'baseboard-gray', name: '巾木（ダークグレー）', categories: [], tile: [900, 900], roughness: 0.6, bump: 0, draw: plaster('#6b6a67', 900, { mottle: 0.02 }) },
  // LIXIL ライン幅木（クッション付）ブラック（仕様書の巾木「ブラック」）
  { id: 'baseboard-white', name: '巾木（LIXIL ライン幅木 ホワイト）', categories: [], tile: [900, 900], roughness: 0.55, bump: 0, draw: plaster('#eeede9', 900, { mottle: 0.01 }) },
  { id: 'baseboard-black', name: '巾木（LIXIL ライン幅木 ブラック）', categories: [], tile: [900, 900], roughness: 0.55, bump: 0, draw: plaster('#262625', 900, { mottle: 0.015 }) },
  { id: 'concrete-counter', name: 'コンクリート調（カウンター）', categories: [], tile: [1200, 1200], roughness: 0.7, bump: 0.8, draw: stone('#b4b1ac', 1200, { contrast: 0.08, pores: 6 }) },

  // ---- 外壁 ----
  { id: 'exterior-siding-white', name: 'サイディング（白）', categories: ['exterior'], tile: [1820, 910], roughness: 0.8, bump: 2, draw: siding('#ecebe6', 455, [1820, 910]) },
  { id: 'exterior-siding-black', name: 'サイディング（ブラック）', categories: ['exterior'], tile: [1820, 910], roughness: 0.8, bump: 2, draw: siding('#2f3032', 455, [1820, 910]) },
  // ニチハ。色は施工写真に合わせた
  { id: 'exterior-charmrock', name: 'ニチハ モエンエクセラード60 シャルムロック プレミアム', categories: ['exterior'], tile: [1820, 910], roughness: 0.85, bump: 3, draw: siding('#58595d', 455, [1820, 910], { rough: 0.3 }) },
  { id: 'exterior-ekg103fk', name: 'ニチハ EKG103FK エピMGライトグレーV', categories: ['exterior'], tile: [1820, 910], roughness: 0.85, bump: 2, draw: tiles('#b9bbbb', '#a4a6a6', 2, 2, [1820, 910], { mottle: 0.1, variation: 0.08, groutMm: 6 }) },
  // JFE 鋼板 極み-MAX（ガルバリウム鋼板の縦葺き）ジェットブラック。ハゼの間隔 約 455
  { id: 'roof-kiwami-jetblack', name: 'JFE鋼板 極み-MAX ジェットブラック（屋根）', categories: ['exterior'], tile: [910, 910], roughness: 0.45, bump: 1.5, draw: standingSeam('#1d1e20', 455, [910, 910]) },
  { id: 'foundation-concrete', name: '基礎（コンクリート・刷毛引き）', categories: ['exterior'], tile: [1200, 1200], roughness: 0.95, bump: 1.5, draw: stone('#9b9b97', 1200, { contrast: 0.06, pores: 10 }) },
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

// Web 版（スマホ・iPad）はメモリが少ないので、模様の画像を縦横半分にする（メモリは 4 分の 1）
const TEX_SIZE = WEB ? 512 : 1024;
const textureCache = new Map<string, { map: THREE.Texture; normal?: THREE.Texture; swatch: string }>();
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

function setupTexture(tex: THREE.Texture, def: MaterialDef, color: boolean) {
  // 画像の素材は1枚の見本写真なので、鏡写しで繰り返して継ぎ目を目立たなくする
  tex.wrapS = tex.wrapT = def.image ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = WEB ? 2 : 8;
  // UV は mm 単位で作るので、1/実寸 で繰り返す
  tex.repeat.set(1 / def.tile[0], 1 / def.tile[1]);
}

function imageTextures(def: MaterialDef) {
  const url = `/${def.image!.replace(/^\//, '')}`;
  const normal = new THREE.CanvasTexture(document.createElement('canvas'));
  const map = new THREE.TextureLoader().load(url, (t) => {
    // 画像の明るさを高さとみなして凹凸を付ける
    const img = t.image as HTMLImageElement;
    const w = Math.min(TEX_SIZE, img.naturalWidth);
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
