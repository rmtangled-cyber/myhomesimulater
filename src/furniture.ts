// 家具の形。簡単な箱の組み合わせで作る。
// ローカル座標: 中心が原点、x = 幅、z = 奥行き（+z が正面）、y = 高さ（床が 0）。単位は mm。
// 照明器具は光源も持つ。光源には userData.fixture、光る部分の材質には userData.glow を付ける。

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { Furniture } from './types';

RectAreaLightUniformsLib.init();

const WARM = '#ffcf94';

export interface FurnitureType {
  type: string;
  label: string;
  /** 新しく追加するときの初期値 */
  defaults: { w: number; d: number; h: number; color: string };
  build: (f: Furniture, mat: THREE.MeshStandardMaterial, sub: THREE.MeshStandardMaterial) => THREE.Object3D[];
  /** 照明器具の光源（ローカル座標、mm） */
  lights?: (f: Furniture) => THREE.Object3D[];
  /** 正面の向きを気にしなくてよい物、壁に付ける物などの説明（パネルに出す） */
  hint?: string;
}

/** 光る部分の材質。照明を消すと光らなくなる */
function glow(color = WARM, intensity = 2): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#fff8ee', emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
  m.userData.glow = intensity;
  return m;
}

const black = new THREE.MeshStandardMaterial({ color: '#1c1c1d', roughness: 0.45, metalness: 0.6 });
black.userData.shared = true;

/** 下向き（dir）のスポットライト。intensity はカンデラ、angle は度 */
function spot(x: number, y: number, z: number, dir: [number, number, number], intensity: number, angle: number, shadow: boolean): THREE.Object3D[] {
  const l = new THREE.SpotLight(WARM, intensity, 8, THREE.MathUtils.degToRad(angle / 2), 0.6, 2);
  l.position.set(x, y, z);
  l.target.position.set(x + dir[0] * 1000, y + dir[1] * 1000, z + dir[2] * 1000);
  l.castShadow = shadow;
  l.shadow.mapSize.set(1024, 1024);
  l.shadow.bias = -0.0002;
  l.shadow.camera.near = 0.05;
  l.userData.fixture = true;
  return [l, l.target];
}


function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function legs(w: number, d: number, h: number, size: number, inset: number, mat: THREE.Material): THREE.Mesh[] {
  const xs = [-w / 2 + inset + size / 2, w / 2 - inset - size / 2];
  const zs = [-d / 2 + inset + size / 2, d / 2 - inset - size / 2];
  return xs.flatMap((x) => zs.map((z) => box(size, h, size, x, 0, z, mat)));
}

export const FURNITURE_TYPES: FurnitureType[] = [
  {
    type: 'sofa',
    label: 'ソファ',
    defaults: { w: 2000, d: 850, h: 800, color: '#8c8478' },
    build: ({ w, d, h }, mat) => {
      const arm = 180;
      const seatH = 420;
      return [
        box(w, seatH, d, 0, 0, 0, mat),
        box(w, h - seatH, 200, 0, seatH, -d / 2 + 100, mat),
        box(arm, 600 - seatH, d, -w / 2 + arm / 2, seatH, 0, mat),
        box(arm, 600 - seatH, d, w / 2 - arm / 2, seatH, 0, mat),
      ];
    },
  },
  {
    type: 'dining-table',
    label: 'ダイニングテーブル',
    defaults: { w: 1600, d: 850, h: 720, color: '#a77d52' },
    build: ({ w, d, h }, mat) => [box(w, 30, d, 0, h - 30, 0, mat), ...legs(w, d, h - 30, 50, 60, mat)],
  },
  {
    type: 'low-table',
    label: 'ローテーブル',
    defaults: { w: 1000, d: 500, h: 380, color: '#a77d52' },
    build: ({ w, d, h }, mat) => [box(w, 30, d, 0, h - 30, 0, mat), ...legs(w, d, h - 30, 40, 40, mat)],
  },
  {
    type: 'chair',
    label: 'チェア',
    defaults: { w: 450, d: 500, h: 800, color: '#a77d52' },
    build: ({ w, d, h }, mat) => [
      box(w, 30, d, 0, 420, 0, mat),
      ...legs(w, d, 420, 35, 20, mat),
      box(w, h - 450, 25, 0, 450, -d / 2 + 12, mat),
    ],
  },
  {
    type: 'bed',
    label: 'ベッド',
    defaults: { w: 1400, d: 2000, h: 450, color: '#e8e4dc' },
    build: ({ w, d, h }, mat, sub) => [
      box(w, 250, d, 0, 0, 0, sub),
      box(w - 20, h - 250, d - 20, 0, 250, 0, mat),
      box(w, 900, 60, 0, 0, -d / 2 + 30, sub),
    ],
  },
  {
    type: 'tv-board',
    label: 'テレビボード',
    defaults: { w: 1800, d: 400, h: 400, color: '#5e4030' },
    build: ({ w, d, h }, mat, sub) => [
      box(w, h, d, 0, 0, 0, mat),
      box(1230, 720, 60, 0, h + 30, -d / 2 + 100, sub), // 55型テレビ
      box(300, 30, 200, 0, h, -d / 2 + 100, sub),
    ],
  },
  {
    type: 'storage',
    label: '収納・棚',
    defaults: { w: 900, d: 400, h: 1800, color: '#d9cdb8' },
    build: ({ w, d, h }, mat) => [box(w, h, d, 0, 0, 0, mat)],
  },
  {
    type: 'kitchen',
    label: 'キッチン',
    defaults: { w: 2550, d: 650, h: 850, color: '#f0eeea' },
    build: ({ w, d, h }, mat, sub) => [
      box(w, h - 30, d, 0, 0, 0, mat),
      box(w, 30, d, 0, h - 30, 0, sub),
      box(750, 5, d - 150, -w / 2 + 600, h, 0, sub), // シンク
    ],
  },
  {
    type: 'island-kitchen',
    label: 'アイランドキッチン',
    defaults: { w: 2550, d: 1000, h: 850, color: '#f0eeea' },
    build: ({ w, d, h }, mat, sub) => [box(w, h - 30, d - 100, 0, 0, -50, mat), box(w, 30, d, 0, h - 30, 0, sub)],
  },
  {
    type: 'desk',
    label: 'デスク',
    defaults: { w: 1200, d: 600, h: 720, color: '#c9a26f' },
    build: ({ w, d, h }, mat) => [box(w, 30, d, 0, h - 30, 0, mat), box(30, h - 30, d, -w / 2 + 15, 0, 0, mat), box(30, h - 30, d, w / 2 - 15, 0, 0, mat)],
  },
  {
    type: 'rug',
    label: 'ラグ',
    defaults: { w: 2000, d: 1400, h: 10, color: '#c8bba6' },
    build: ({ w, d, h }, mat) => {
      const m = box(w, h, d, 0, 0, 0, mat);
      m.castShadow = false;
      return [m];
    },
  },
  {
    type: 'plant',
    label: '観葉植物',
    defaults: { w: 450, d: 450, h: 1400, color: '#4f6b3a' },
    build: ({ w, h }, mat, sub) => {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.35, w * 0.28, 350, 20), sub);
      pot.position.y = 175;
      const leaves = new THREE.Mesh(new THREE.SphereGeometry(w / 2, 16, 12), mat);
      leaves.scale.y = (h - 350) / w;
      leaves.position.y = 350 + (h - 350) / 2;
      for (const m of [pot, leaves]) m.castShadow = m.receiveShadow = true;
      return [pot, leaves];
    },
  },
  {
    type: 'stairs',
    label: '階段（踏板のみ・ストリップ）',
    hint: '幅 w、奥行き d（上る方向の長さ）、高さ h（上の階までの高さ）。正面が上り口',
    defaults: { w: 800, d: 3640, h: 2990, color: '#c9a26f' },
    build: ({ w, d, h }, mat) => {
      const steps = Math.max(2, Math.round(h / 200));
      const rise = h / steps;
      const tread = d / steps;
      // 踏板の下に隠れた細い鉄骨のささら桁
      const len = Math.hypot(d, h);
      const stringer = new THREE.Mesh(new THREE.BoxGeometry(12, 120, len), black);
      stringer.position.set(0, h / 2 - 80, 0);
      stringer.rotation.x = Math.atan2(h, d);
      stringer.castShadow = true;
      const treads = Array.from({ length: steps - 1 }, (_, i) => box(w, 40, tread + 30, 0, rise * (i + 1) - 40, d / 2 - tread * (i + 0.5), mat));
      return [stringer, ...treads];
    },
  },
  {
    type: 'stairs-box',
    label: '階段（箱型）',
    hint: '幅 w、奥行き d（上る方向の長さ）、高さ h（上の階までの高さ）。正面が上り口',
    defaults: { w: 800, d: 3640, h: 2990, color: '#c9a26f' },
    build: ({ w, d, h }, mat) => {
      const steps = Math.max(2, Math.round(h / 200));
      const rise = h / steps;
      const tread = d / steps;
      return Array.from({ length: steps }, (_, i) => box(w, rise * (i + 1), tread, 0, 0, d / 2 - tread * (i + 0.5), mat));
    },
  },
  {
    type: 'car',
    label: '車',
    defaults: { w: 1800, d: 4700, h: 1500, color: '#e9e9ea' },
    build: ({ w, d, h }, mat, sub) => {
      const r = 330;
      const body = box(w, h * 0.42, d, 0, r * 0.6, 0, mat);
      const cabin = box(w * 0.86, h - h * 0.42 - r * 0.6, d * 0.48, 0, r * 0.6 + h * 0.42, -d * 0.04, sub);
      const wheels = [-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 220, 20), sub);
          m.rotation.z = Math.PI / 2;
          m.position.set(sx * (w / 2 - 120), r, sz * (d / 2 - 750));
          m.castShadow = true;
          return m;
        }),
      );
      return [body, cabin, ...wheels];
    },
  },
  {
    type: 'rod-screen',
    label: 'ロッド手すり・格子',
    hint: '幅に沿って細い棒が並ぶ。奥行きは棒の太さ',
    defaults: { w: 2700, d: 25, h: 2400, color: '#1c1c1d' },
    build: ({ w, d, h }, mat) => {
      const n = Math.max(2, Math.round(w / 300) + 1);
      return Array.from({ length: n }, (_, i) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, h, 12), mat);
        m.position.set(-w / 2 + (w * i) / (n - 1), h / 2, 0);
        m.castShadow = true;
        return m;
      });
    },
  },
  {
    type: 'bracket-light',
    label: 'ブラケットライト',
    hint: '壁付け。背面（奥）を壁に付け、「床からの高さ」で取付高さを決める',
    defaults: { w: 200, d: 300, h: 300, color: '#1c1c1d' },
    build: ({ w, d, h }, mat) => {
      const arm = box(20, 20, d, 0, h - 40, 0, mat);
      mat.side = THREE.DoubleSide;
      const shade = new THREE.Mesh(new THREE.ConeGeometry(w / 2, h * 0.6, 24, 1, true), mat);
      shade.position.set(0, h - h * 0.3, d / 2 - w / 2);
      shade.castShadow = true;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(w * 0.18, 12, 8), glow());
      bulb.position.set(0, h * 0.42, d / 2 - w / 2);
      const plate = box(80, 120, 15, 0, h - 100, -d / 2 + 8, mat);
      return [arm, shade, bulb, plate];
    },
    lights: ({ d, h, w }) => spot(0, h * 0.4, d / 2 - w / 2, [0, -1, 0.15], 40, 100, true),
  },
  {
    type: 'wall-light',
    label: 'ウォールライト（上下配光）',
    hint: '壁付け。背面を壁に付け、「床からの高さ」で取付高さを決める',
    defaults: { w: 100, d: 100, h: 100, color: '#1c1c1d' },
    build: ({ w, d, h }, mat) => [box(w, h, d, 0, 0, 0, mat), box(w * 0.8, 4, d * 0.8, 0, h, 0, glow()), box(w * 0.8, 4, d * 0.8, 0, -4, 0, glow())],
    lights: ({ h }) => [...spot(0, h + 10, 20, [0, 1, 0.12], 30, 40, false), ...spot(0, -10, 20, [0, -1, 0.12], 30, 40, false)],
  },
  {
    type: 'downlight',
    label: 'ダウンライト',
    hint: '天井付け。「床からの高さ」を天井高（2400 など）にする',
    defaults: { w: 100, d: 100, h: 20, color: '#f4f4f4' },
    build: ({ w }) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 6, 24), glow(WARM, 3));
      m.position.y = -4;
      return [m];
    },
    lights: () => spot(0, -15, 0, [0, -1, 0], 80, 70, true),
  },
  {
    type: 'line-light',
    label: '間接照明（ライン）',
    hint: '幅の長さで光る。天井や壁際に置き、「床からの高さ」で取付高さを決める',
    defaults: { w: 1800, d: 60, h: 40, color: '#f4f4f4' },
    build: ({ w, d, h }) => [box(w, h, d, 0, 0, 0, glow(WARM, 2.5))],
    lights: ({ w, d }) => {
      const l = new THREE.RectAreaLight(WARM, 6, w, Math.max(d, 60));
      l.position.set(0, -5, 0);
      l.lookAt(0, -1000, 0);
      l.userData.fixture = true;
      return [l];
    },
  },
  {
    type: 'pendant-light',
    label: 'ペンダントライト',
    hint: '「床からの高さ」はシェードの下端の高さ。h はコードを含む長さ',
    defaults: { w: 300, d: 300, h: 900, color: '#1c1c1d' },
    build: ({ w, h }, mat) => {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, h, 6), mat);
      cord.position.y = h / 2;
      mat.side = THREE.DoubleSide;
      const shade = new THREE.Mesh(new THREE.ConeGeometry(w / 2, w * 0.6, 32, 1, true), mat);
      shade.position.y = w * 0.3;
      shade.castShadow = true;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(w * 0.15, 12, 8), glow());
      bulb.position.y = w * 0.15;
      return [cord, shade, bulb];
    },
    lights: ({ w }) => {
      const l = new THREE.PointLight(WARM, 20, 6, 2);
      l.position.set(0, w * 0.05, 0);
      l.userData.fixture = true;
      return [l];
    },
  },
  {
    type: 'art',
    label: 'アート・額縁',
    hint: '壁掛け。背面を壁に付け、「床からの高さ」で下端の高さを決める',
    defaults: { w: 600, d: 30, h: 800, color: '#111111' },
    build: ({ w, d, h, id }, mat) => {
      const frame = box(w, h, d, 0, 0, 0, mat);
      const art = new THREE.Mesh(new THREE.PlaneGeometry(w - 40, h - 40), new THREE.MeshStandardMaterial({ map: artTexture(id), roughness: 0.7 }));
      art.position.set(0, h / 2, d / 2 + 1);
      return [frame, art];
    },
  },
  {
    type: 'mirror',
    label: 'ミラー（鏡・ミラー扉）',
    hint: '背面を壁に付ける。ミラー扉なら高さを天井まで',
    defaults: { w: 800, d: 20, h: 2400, color: '#c8ccd0' },
    build: ({ w, d, h }, mat) => {
      const frame = box(w, h, d, 0, 0, 0, mat);
      // 周りが実際に映り込む鏡（解像度は控えめ）
      const mirror = new Reflector(new THREE.PlaneGeometry(w - 20, h - 20), {
        textureWidth: 512,
        textureHeight: Math.round((512 * h) / w),
        color: 0xb8bcc0,
        clipBias: 0.003,
      });
      mirror.position.set(0, h / 2, d / 2 + 1);
      // 断面表示で切れないので、俯瞰で壁を低く切るときは隠す
      mirror.userData.hideWhenCut = true;
      return [frame, mirror];
    },
  },
  {
    type: 'box',
    label: 'その他（箱）',
    defaults: { w: 600, d: 600, h: 600, color: '#b5b0a8' },
    build: ({ w, d, h }, mat) => [box(w, h, d, 0, 0, 0, mat)],
  },
];

const byType = new Map(FURNITURE_TYPES.map((t) => [t.type, t]));

export function getFurnitureType(type: string): FurnitureType {
  return byType.get(type) ?? byType.get('box')!;
}

/** 家具を1つ組み立てる。戻り値は平面図の位置・回転を反映済み（mm 単位）。 */
export function buildFurniture(f: Furniture): THREE.Group {
  const mat = new THREE.MeshStandardMaterial({ color: f.color, roughness: 0.75 });
  const subColor = new THREE.Color(f.color).offsetHSL(0, -0.1, -0.25);
  const sub = new THREE.MeshStandardMaterial({ color: subColor, roughness: 0.6 });
  const g = new THREE.Group();
  const t = getFurnitureType(f.type);
  for (const o of t.build(f, mat, sub)) g.add(o);
  for (const o of t.lights?.(f) ?? []) g.add(o);
  g.position.set(f.x, f.z ?? 0, f.y);
  // 平面図で時計回り = 上から見て時計回り = three.js の y 軸まわりで負の回転
  g.rotation.y = -THREE.MathUtils.degToRad(f.rotation);
  g.userData.furnitureId = f.id;
  return g;
}

/** 抽象画っぽい模様（家具の ID ごとに決まった絵になる） */
function artTexture(seed: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 384;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#f2f0ea';
  ctx.lineCap = 'square';
  for (let i = 0; i < 22; i++) {
    ctx.lineWidth = 10 + rand() * 14;
    const x = rand() * c.width;
    const y = rand() * c.height;
    const a = rand() * Math.PI;
    const len = 50 + rand() * 140;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
