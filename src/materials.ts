// 素材カタログ。テクスチャはすべてキャンバスで生成し、実寸（mm）で貼る。
// 新しい素材はここの MATERIALS に追加する。

import * as THREE from 'three';

export type MaterialCategory = 'floor' | 'wall' | 'exterior';

export interface MaterialDef {
  id: string;
  name: string;
  categories: MaterialCategory[];
  /** テクスチャ1枚が表す実寸 [横, 縦] mm */
  tile: [number, number];
  roughness: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number) => void;
}

function rng(seed: number): () => number {
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

function shade(hex: string, amount: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amount)));
  return `#${c.getHexString()}`;
}

/** 細かいざらつき。壁紙の織物感・塗り壁感に使う。 */
function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number, strength: number, count: number) {
  for (let i = 0; i < count; i++) {
    const v = rand() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${v},${v},${v},${rand() * strength})`;
    ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
}

function plainCross(base: string, strength = 0.05): MaterialDef['draw'] {
  return (ctx, w, h, rand) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, rand, strength, 40000);
  };
}

function wovenCross(base: string): MaterialDef['draw'] {
  return (ctx, w, h, rand) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 4) {
      ctx.fillStyle = `rgba(0,0,0,${0.02 + rand() * 0.03})`;
      ctx.fillRect(0, y, w, 1);
    }
    for (let x = 0; x < w; x += 4) {
      ctx.fillStyle = `rgba(255,255,255,${0.02 + rand() * 0.04})`;
      ctx.fillRect(x, 0, 1, h);
    }
    speckle(ctx, w, h, rand, 0.04, 20000);
  };
}

/** フローリング。tile の縦方向に何枚並ぶかは plankWidth で決まる。 */
function flooring(colors: string[], plankWidthMm: number, tileMm: [number, number]): MaterialDef['draw'] {
  return (ctx, w, h, rand) => {
    const rows = Math.round(tileMm[1] / plankWidthMm);
    const rowH = h / rows;
    for (let r = 0; r < rows; r++) {
      const y0 = r * rowH;
      // 1列に2枚。継ぎ目の位置を列ごとにずらす（横方向に繋がるよう wrap して描く）
      const joint = rand() * w;
      const pieces = [joint, joint + w / 2];
      for (let p = 0; p < 2; p++) {
        const x0 = pieces[p];
        const color = shade(colors[Math.floor(rand() * colors.length)], (rand() - 0.5) * 0.06);
        for (const off of [-w, 0]) {
          ctx.fillStyle = color;
          ctx.fillRect(x0 + off, y0, w / 2, rowH);
        }
      }
      // 木目
      for (let g = 0; g < 14; g++) {
        const gy = y0 + rand() * rowH;
        const amp = 1 + rand() * 3;
        const freq = 0.003 + rand() * 0.01;
        const phase = rand() * 100;
        ctx.strokeStyle = `rgba(60,35,15,${0.05 + rand() * 0.1})`;
        ctx.lineWidth = 0.6 + rand() * 1.4;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const yy = gy + Math.sin(x * freq * Math.PI * 2 + phase) * amp;
          if (x === 0) ctx.moveTo(x, Math.min(y0 + rowH, Math.max(y0, yy)));
          else ctx.lineTo(x, Math.min(y0 + rowH, Math.max(y0, yy)));
        }
        ctx.stroke();
      }
      // 継ぎ目と目地
      ctx.fillStyle = 'rgba(30,18,8,0.35)';
      ctx.fillRect(0, y0, w, 1.5);
      for (const x0 of pieces) {
        const x = ((x0 % w) + w) % w;
        ctx.fillRect(x, y0, 1.5, rowH);
      }
    }
  };
}

function tiles(base: string, grout: string, countX: number, countY: number, variation: number): MaterialDef['draw'] {
  return (ctx, w, h, rand) => {
    const tw = w / countX;
    const th = h / countY;
    for (let y = 0; y < countY; y++) {
      for (let x = 0; x < countX; x++) {
        ctx.fillStyle = shade(base, (rand() - 0.5) * variation);
        ctx.fillRect(x * tw, y * th, tw, th);
      }
    }
    speckle(ctx, w, h, rand, 0.06, 30000);
    ctx.fillStyle = grout;
    for (let y = 0; y < countY; y++) ctx.fillRect(0, y * th, w, 3);
    for (let x = 0; x < countX; x++) ctx.fillRect(x * tw, 0, 3, h);
  };
}

function tatami(): MaterialDef['draw'] {
  return (ctx, w, h, rand) => {
    ctx.fillStyle = '#c9c48a';
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 3) {
      ctx.fillStyle = `rgba(80,90,30,${0.05 + rand() * 0.12})`;
      ctx.fillRect(x, 0, 1.5, h);
    }
    // 縁
    ctx.fillStyle = '#2f3a2c';
    ctx.fillRect(0, 0, w, 14);
    ctx.fillRect(0, h - 14, w, 14);
  };
}

function concrete(base: string): MaterialDef['draw'] {
  return (ctx, w, h, rand) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 300; i++) {
      const r = 10 + rand() * 80;
      const x = rand() * w;
      const y = rand() * h;
      const a = rand() * 0.05;
      const v = rand() < 0.5 ? 0 : 255;
      for (const ox of [-w, 0, w]) {
        for (const oy of [-h, 0, h]) {
          const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
          g.addColorStop(0, `rgba(${v},${v},${v},${a})`);
          g.addColorStop(1, `rgba(${v},${v},${v},0)`);
          ctx.fillStyle = g;
          ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
        }
      }
    }
    speckle(ctx, w, h, rand, 0.08, 30000);
  };
}

function siding(base: string, boardMm: number, tileMm: [number, number]): MaterialDef['draw'] {
  return (ctx, w, h, rand) => {
    const rows = Math.round(tileMm[1] / boardMm);
    const rowH = h / rows;
    for (let r = 0; r < rows; r++) {
      ctx.fillStyle = shade(base, (rand() - 0.5) * 0.03);
      ctx.fillRect(0, r * rowH, w, rowH);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, r * rowH, w, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(0, r * rowH + 3, w, 2);
    }
    speckle(ctx, w, h, rand, 0.05, 20000);
  };
}

function woodPanel(colors: string[]): MaterialDef['draw'] {
  return flooring(colors, 100, [900, 900]);
}

export const MATERIALS: MaterialDef[] = [
  // ---- 床 ----
  { id: 'floor-oak', name: 'オーク（ナチュラル）', categories: ['floor'], tile: [1820, 900], roughness: 0.55, draw: flooring(['#c9a26f', '#c19764', '#d1ad7c'], 150, [1820, 900]) },
  { id: 'floor-walnut', name: 'ウォールナット', categories: ['floor'], tile: [1820, 900], roughness: 0.5, draw: flooring(['#5e4030', '#6b4a36', '#533829'], 150, [1820, 900]) },
  { id: 'floor-white-ash', name: 'ホワイトアッシュ', categories: ['floor'], tile: [1820, 900], roughness: 0.55, draw: flooring(['#e3d6c2', '#dccdb6', '#e8dccb'], 150, [1820, 900]) },
  { id: 'floor-gray-oak', name: 'グレージュオーク', categories: ['floor'], tile: [1820, 900], roughness: 0.55, draw: flooring(['#a59a8c', '#9b9083', '#b0a596'], 150, [1820, 900]) },
  { id: 'floor-cherry', name: 'チェリー', categories: ['floor'], tile: [1820, 900], roughness: 0.5, draw: flooring(['#a5603c', '#9a5634', '#b06a45'], 150, [1820, 900]) },
  { id: 'floor-tile-white', name: 'タイル（ホワイト 300角）', categories: ['floor'], tile: [1200, 1200], roughness: 0.3, draw: tiles('#e9e6e0', '#c9c4bb', 4, 4, 0.03) },
  { id: 'floor-tile-stone', name: 'タイル（石目グレー 600角）', categories: ['floor'], tile: [1200, 1200], roughness: 0.4, draw: tiles('#8f8b85', '#6e6a65', 2, 2, 0.08) },
  { id: 'floor-cushion-white', name: 'クッションフロア（白）', categories: ['floor'], tile: [900, 900], roughness: 0.6, draw: plainCross('#ecebe6', 0.04) },
  { id: 'floor-tatami', name: '畳', categories: ['floor'], tile: [910, 1820], roughness: 0.8, draw: tatami() },

  // ---- 壁・天井クロス ----
  { id: 'cross-white', name: '白（スタンダード）', categories: ['wall'], tile: [900, 900], roughness: 0.9, draw: plainCross('#f4f3ef') },
  { id: 'cross-offwhite', name: 'オフホワイト（織物調）', categories: ['wall'], tile: [600, 600], roughness: 0.9, draw: wovenCross('#efebe2') },
  { id: 'cross-greige', name: 'グレージュ', categories: ['wall'], tile: [600, 600], roughness: 0.9, draw: wovenCross('#cbc3b7') },
  { id: 'cross-light-gray', name: 'ライトグレー', categories: ['wall'], tile: [900, 900], roughness: 0.9, draw: plainCross('#d8d8d6') },
  { id: 'cross-charcoal', name: 'チャコールグレー', categories: ['wall'], tile: [600, 600], roughness: 0.9, draw: wovenCross('#4a4b4d') },
  { id: 'cross-navy', name: 'ネイビー', categories: ['wall'], tile: [600, 600], roughness: 0.9, draw: wovenCross('#2d3a52') },
  { id: 'cross-sage', name: 'セージグリーン', categories: ['wall'], tile: [600, 600], roughness: 0.9, draw: wovenCross('#9aa68e') },
  { id: 'cross-terracotta', name: 'テラコッタ', categories: ['wall'], tile: [600, 600], roughness: 0.9, draw: wovenCross('#b97456') },
  { id: 'cross-dusty-pink', name: 'ダスティピンク', categories: ['wall'], tile: [600, 600], roughness: 0.9, draw: wovenCross('#d4b2aa') },
  { id: 'cross-concrete', name: 'コンクリート調', categories: ['wall', 'exterior'], tile: [1800, 900], roughness: 0.85, draw: concrete('#a9a7a2') },
  { id: 'cross-wood-oak', name: '木目調（オーク板張り）', categories: ['wall'], tile: [900, 900], roughness: 0.6, draw: woodPanel(['#c9a26f', '#bf9663', '#d1ad7c']) },
  { id: 'cross-wood-walnut', name: '木目調（ウォールナット板張り）', categories: ['wall'], tile: [900, 900], roughness: 0.6, draw: woodPanel(['#5e4030', '#6b4a36', '#533829']) },
  { id: 'wall-tile-white', name: 'タイル（白 100角・水回り）', categories: ['wall'], tile: [600, 600], roughness: 0.25, draw: tiles('#f2f1ec', '#d5d2ca', 6, 6, 0.02) },

  // ---- 外壁 ----
  { id: 'exterior-siding-white', name: 'サイディング（白）', categories: ['exterior'], tile: [1820, 910], roughness: 0.8, draw: siding('#ecebe6', 455, [1820, 910]) },
  { id: 'exterior-siding-black', name: 'サイディング（ブラック）', categories: ['exterior'], tile: [1820, 910], roughness: 0.8, draw: siding('#2f3032', 455, [1820, 910]) },
  { id: 'exterior-plaster-beige', name: '塗り壁（ベージュ）', categories: ['exterior'], tile: [900, 900], roughness: 0.95, draw: plainCross('#ddd2bd', 0.1) },
];

const byId = new Map(MATERIALS.map((m) => [m.id, m]));

export function getMaterialDef(id: string): MaterialDef | undefined {
  return byId.get(id);
}

export function materialsFor(category: MaterialCategory): MaterialDef[] {
  return MATERIALS.filter((m) => m.categories.includes(category));
}

const TEX_SIZE = 1024;
const textureCache = new Map<string, THREE.CanvasTexture>();
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

function textureFor(def: MaterialDef): THREE.CanvasTexture {
  const cached = textureCache.get(def.id);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  const aspect = def.tile[1] / def.tile[0];
  canvas.width = TEX_SIZE;
  canvas.height = Math.round(TEX_SIZE * aspect);
  const ctx = canvas.getContext('2d')!;
  def.draw(ctx, canvas.width, canvas.height, rng(hashString(def.id)));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  // UV は mm 単位で作るので、1/実寸 で繰り返す
  tex.repeat.set(1 / def.tile[0], 1 / def.tile[1]);
  textureCache.set(def.id, tex);
  return tex;
}

/** 素材IDから three.js のマテリアルを作る。clip を渡すと断面表示の対象になる。 */
export function getMaterial(id: string, opts: { clip?: THREE.Plane[] } = {}): THREE.MeshStandardMaterial {
  const cacheKey = `${id}|${opts.clip ? 'clip' : ''}`;
  const cached = materialCache.get(cacheKey);
  if (cached) return cached;
  const def = byId.get(id);
  const mat = def
    ? new THREE.MeshStandardMaterial({ map: textureFor(def), roughness: def.roughness, metalness: 0 })
    : new THREE.MeshStandardMaterial({ color: '#ff00ff', roughness: 0.9 }); // 不明なIDはマゼンタで目立たせる
  mat.userData.shared = true;
  if (opts.clip) {
    mat.clippingPlanes = opts.clip;
    mat.clipShadows = true;
  }
  materialCache.set(cacheKey, mat);
  return mat;
}

/** パネルに表示する見本画像（data URL）。 */
export function swatchUrl(id: string): string {
  const def = byId.get(id);
  if (!def) return '';
  return (textureFor(def).image as HTMLCanvasElement).toDataURL('image/jpeg', 0.6);
}
