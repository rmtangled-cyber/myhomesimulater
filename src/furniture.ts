// 家具の形。簡単な箱の組み合わせで作る。
// ローカル座標: 中心が原点、x = 幅、z = 奥行き（+z が正面）、y = 高さ（床が 0）。単位は mm。

import * as THREE from 'three';
import type { Furniture } from './types';

export interface FurnitureType {
  type: string;
  label: string;
  /** 新しく追加するときの初期値 */
  defaults: { w: number; d: number; h: number; color: string };
  build: (f: Furniture, mat: THREE.MeshStandardMaterial, sub: THREE.MeshStandardMaterial) => THREE.Object3D[];
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
  for (const o of getFurnitureType(f.type).build(f, mat, sub)) g.add(o);
  g.position.set(f.x, 0, f.y);
  // 平面図で時計回り = 上から見て時計回り = three.js の y 軸まわりで負の回転
  g.rotation.y = -THREE.MathUtils.degToRad(f.rotation);
  g.userData.furnitureId = f.id;
  return g;
}
