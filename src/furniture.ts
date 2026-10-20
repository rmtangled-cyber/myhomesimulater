// 家具の形。簡単な箱の組み合わせで作る。
// ローカル座標: 中心が原点、x = 幅、z = 奥行き（+z が正面）、y = 高さ（床が 0）。単位は mm。
// 照明器具は光源も持つ。光源には userData.fixture、光る部分の材質には userData.glow を付ける。

import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

// 線の光（テープライト・間接照明）に使う面光源の準備
RectAreaLightUniformsLib.init();
import { getMaterial, getMaterialDef } from './materials';
import type { Furniture } from './types';

const WARM = '#ffcf94';

/** 色温度（K）から光の色。電球色 2700K・温白色 3500K・昼白色 5000K などの間を補う */
function kelvinColor(k?: number): string {
  if (!k) return WARM;
  const table: [number, string][] = [[2700, '#ffc489'], [3000, '#ffcd9c'], [3500, '#ffd9b4'], [4000, '#ffe3c8'], [5000, '#fff0e2'], [6500, '#f6f4ff']];
  for (const [t, c] of table) if (k <= t) return c;
  return table[table.length - 1][1];
}

/**
 * 全光束（lm）と光の広がり（度）から、真下の光度（cd）を出す。広がりの中に光が均一に出るとみなす。
 * 画面の明るさは実物の明るさを測ったものではないので、CAL で全体を合わせる（60W 相当のダウンライトが自然に見える値）
 */
const CAL = 0.75;
function candela(lm: number, beam: number): number {
  const sr = 2 * Math.PI * (1 - Math.cos(THREE.MathUtils.degToRad(Math.min(beam, 179) / 2)));
  return (lm / sr) * CAL;
}
/** 面光源の幅・高さは m で指定する */
const MM_LIGHT = 0.001;

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
/** LIXIL ラフィスのドアストッパーの色（商品コードの頭 2 文字 → 名前・3D の色）。カタログ p.192 の写真から */
export const STOPPER_COLORS: Record<string, [string, string]> = {
  YY: ['プレシャスホワイト／クリエアイボリー', '#e6e3dc'],
  AC: ['クリエオーク', '#c49c6e'],
  AD: ['クリエチェリー', '#b98b6b'],
  MM: ['クリエモカ', '#6b4632'],
  DD: ['クリエダーク', '#3d2a21'],
  RA: ['コージーライトグレー', '#c8c8c6'],
  BD: ['シャインニッケル', '#b6a88f'],
  BE: ['アイアンブラック', '#1f1f1f'],
};
const nickel = new THREE.MeshStandardMaterial({ color: '#c3c5c7', roughness: 0.25, metalness: 0.9 });
const whiteHandle = new THREE.MeshStandardMaterial({ color: '#eeede9', roughness: 0.4, metalness: 0.2 });
/** 扉の取手・引手の色（家具の handle。省略時はアイアンブラック） */
const handleMat = (h: Furniture['handle']) => (h === 'nickel' ? nickel : h === 'white' ? whiteHandle : black);
black.userData.shared = true;

/** 下向き（dir）のスポットライト。intensity はカンデラ、angle は度、distance は光が届く距離（m） */
function spot(x: number, y: number, z: number, dir: [number, number, number], intensity: number, angle: number, shadow: boolean, distance = 8, color = WARM): THREE.Object3D[] {
  const l = new THREE.SpotLight(color, intensity, distance, THREE.MathUtils.degToRad(angle / 2), 0.6, 2);
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
  // クリックを受けるだけの見えない板（opacity 0）は影を落とさない（ロールスクリーンを上げると床に黒い帯が出ていた）
  const hidden = (mat as THREE.MeshBasicMaterial).transparent && (mat as THREE.MeshBasicMaterial).opacity === 0;
  m.castShadow = !hidden;
  m.receiveShadow = !hidden;
  return m;
}

/**
 * 角の丸い長方形の平面形（中心が原点）。rBack は奥（−z）の角、rFront は手前（+z）の角の丸み。
 * prism() で立ち上げる（shape の y は −z になる）
 */
function roundRect(w: number, d: number, rBack: number, rFront = rBack): THREE.Shape {
  const s = new THREE.Shape();
  const [x0, x1] = [-w / 2, w / 2];
  // shape の y = −z。手前（+z）は y = −d/2
  const [yf, yb] = [-d / 2, d / 2];
  s.moveTo(x0 + rFront, yf);
  s.lineTo(x1 - rFront, yf);
  s.quadraticCurveTo(x1, yf, x1, yf + rFront);
  s.lineTo(x1, yb - rBack);
  s.quadraticCurveTo(x1, yb, x1 - rBack, yb);
  s.lineTo(x0 + rBack, yb);
  s.quadraticCurveTo(x0, yb, x0, yb - rBack);
  s.lineTo(x0, yf + rFront);
  s.quadraticCurveTo(x0, yf, x0 + rFront, yf);
  return s;
}

/** 平面形を y0 から高さ h だけ立ち上げる。bevel で上下の角を丸める。z は前後の位置 */
function prism(shape: THREE.Shape, h: number, y0: number, mat: THREE.Material, bevel = 0, z = 0): THREE.Mesh {
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(1, h - bevel * 2), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 16 });
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(0, y0 + bevel, z);
  m.castShadow = m.receiveShadow = true;
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
    type: 'silk-jasmine',
    label: '観葉植物（シルクジャスミン・グレーのストーン調の鉢・土）',
    hint: '床に置く。w は葉の広がり、h は鉢の下から葉の上まで。1 本の幹から細い枝が上へ広がり、小さなつやのある葉がたくさん付く（てっぺんに白いつぼみ）。鉢は上が広いグレーのストーン調、上は土',
    defaults: { w: 750, d: 750, h: 1650, color: '#2f5a2a' },
    build: ({ w, h }, mat) => {
      mat.roughness = 0.35;
      mat.side = THREE.DoubleSide;
      const potMat = new THREE.MeshStandardMaterial({ color: '#7d7d79', roughness: 0.9 });
      const coco = new THREE.MeshStandardMaterial({ color: '#3b2e24', roughness: 1 });
      const bark = new THREE.MeshStandardMaterial({ color: '#c9b48a', roughness: 0.8 });
      const bud = new THREE.MeshStandardMaterial({ color: '#f4f2ea', roughness: 0.6 });
      const potH = 420;
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(200, 155, potH, 32), potMat);
      pot.position.y = potH / 2;
      const mulch = new THREE.Mesh(new THREE.CylinderGeometry(192, 192, 40, 32), coco);
      mulch.position.y = potH - 10;
      const out: THREE.Object3D[] = [pot, mulch];
      let seed = 11;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      // 幹（土から 250 上で枝分かれ）
      const fork: [number, number, number] = [0, potH + 230, 0];
      out.push(rod([0, potH, 0], fork, 26, bark));
      const crownH = h - fork[1];
      const leafPos: number[] = [];
      const buds: THREE.Object3D[] = [];
      // 葉 1 枚 = 細長いひし形（先がとがる）。枝のまわりにまとめて 1 つの形にする
      const addLeaf = (p: THREE.Vector3) => {
        const len = 42 + 20 * rnd();
        const wid = len * 0.45;
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI * 2));
        const v = [new THREE.Vector3(0, 0, len), new THREE.Vector3(wid / 2, 0, len * 0.35), new THREE.Vector3(0, 0, 0), new THREE.Vector3(-wid / 2, 0, len * 0.35)].map((a) => a.applyQuaternion(q).add(p));
        for (const i of [0, 1, 2, 0, 2, 3]) leafPos.push(v[i].x, v[i].y, v[i].z);
      };
      const branch = (from: THREE.Vector3, dir: THREE.Vector3, len: number, thick: number, depth: number) => {
        const to = from.clone().addScaledVector(dir, len);
        out.push(rod([from.x, from.y, from.z], [to.x, to.y, to.z], thick, bark));
        // 葉は枝の先 6 割に
        const n = Math.round(len / (depth ? 3 : 4.5));
        for (let i = 0; i < n; i++) {
          const t = 0.22 + 0.78 * Math.sqrt(rnd());
          const p = from.clone().addScaledVector(dir, len * t);
          // 枝の先ほど葉の房を大きく（丸い樹冠になるように）
          const r = 90 + 150 * t;
          p.x += (rnd() - 0.5) * r;
          p.y += (rnd() - 0.5) * r * 1.2;
          p.z += (rnd() - 0.5) * r;
          addLeaf(p);
        }
        if (to.y > h - 140 && rnd() < 0.7) {
          const b = new THREE.Mesh(new THREE.SphereGeometry(7, 6, 4), bud);
          b.position.set(to.x + (rnd() - 0.5) * 40, to.y + 20, to.z + (rnd() - 0.5) * 40);
          buds.push(b);
        }
        if (depth) return;
        // 枝の途中から小枝を 2 本
        for (const t of [0.45, 0.7]) {
          const p = from.clone().addScaledVector(dir, len * t);
          const a = rnd() * Math.PI * 2;
          const d2 = new THREE.Vector3(Math.cos(a) * 0.8, 0.7, Math.sin(a) * 0.8).normalize();
          branch(p, d2, len * (0.35 + 0.15 * rnd()), thick * 0.6, 1);
        }
      };
      // 主な枝 8 本（花瓶のように上へ広がる。外側ほど傾く）
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + rnd() * 0.5;
        const tilt = 0.2 + 0.3 * rnd();
        const dir = new THREE.Vector3(Math.sin(tilt) * Math.cos(a) * (w / 750), Math.cos(tilt), Math.sin(tilt) * Math.sin(a) * (w / 750)).normalize();
        branch(new THREE.Vector3(...fork), dir, crownH * (0.85 + 0.12 * rnd()), 8, 0);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(leafPos, 3));
      geo.computeVertexNormals();
      const leaves = new THREE.Mesh(geo, mat);
      leaves.castShadow = true;
      out.push(leaves, ...buds);
      for (const m of [pot, mulch]) m.castShadow = m.receiveShadow = true;
      return out;
    },
  },
  {
    type: 'umbellata',
    label: '観葉植物（フィカス・ウンベラータ・背の高い鉢）',
    hint: '床に置く。w は葉の広がり、h は鉢の下から葉の上まで。鉢はチャコールの背の高い円筒（色は sub）。大きなハート形の葉が細い幹の上に広がる',
    defaults: { w: 800, d: 800, h: 1700, color: '#4e7a3a' },
    build: ({ w, h }, mat) => {
      mat.roughness = 0.55;
      mat.side = THREE.DoubleSide;
      const potMat = new THREE.MeshStandardMaterial({ color: '#3b3b3c', roughness: 0.85 });
      const soil = new THREE.MeshStandardMaterial({ color: '#3a2d22', roughness: 1 });
      const bark = new THREE.MeshStandardMaterial({ color: '#8a7a66', roughness: 0.9 });
      const potH = 480;
      const potR = 190;
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(potR, potR * 0.9, potH, 28), potMat);
      pot.position.y = potH / 2;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(potR - 15, potR - 15, 6, 28), soil);
      top.position.y = potH - 30;
      const out: THREE.Object3D[] = [pot, top];
      // 決まった並びの乱数（毎回同じ形になる）
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      // 幹 3 本（少し傾けて、上で葉を広げる）
      const trunks: [number, number, number][] = [[0.0, 0.08, 1], [0.28, -0.15, 0.82], [-0.3, -0.05, 0.7]];
      for (const [ax, az, hk] of trunks) {
        const len = (h - potH - 150) * hk;
        const t = new THREE.Mesh(new THREE.CylinderGeometry(9, 14, len, 8), bark);
        const g = new THREE.Group();
        g.position.y = potH - 30;
        g.rotation.z = ax;
        g.rotation.x = az;
        t.position.y = len / 2;
        g.add(t);
        // 葉: 幹の上 45% に、大きなハート形（平たい楕円）を向きを変えて付ける
        const n = Math.round(9 * hk + 4);
        for (let i = 0; i < n; i++) {
          const y = len * (0.55 + 0.45 * rnd());
          const ang = rnd() * Math.PI * 2;
          const size = (w / 2) * (0.32 + 0.18 * rnd());
          const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), mat);
          leaf.scale.set(size * 0.95, size, size * 0.06);
          const stem = size * 0.9;
          leaf.position.set(Math.cos(ang) * stem, y + size * 0.1, Math.sin(ang) * stem);
          leaf.rotation.y = -ang + Math.PI / 2;
          leaf.rotation.x = -0.5 - 0.4 * rnd();
          leaf.castShadow = true;
          g.add(leaf);
        }
        out.push(g);
      }
      for (const m of out) m.castShadow = true;
      return out;
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
    hint: '正面が車の前。コンパクトなハッチバック（トヨタ アクアなど）の形。w 全幅・d 全長・h 全高',
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.3;
      mat.metalness = 0.4;
      const L = d;
      const b = 70; // 角の丸み
      // 横から見た形（z = 前後、y = 高さ）を、幅方向に押し出す。+z が前
      const side = (pts: [number, number][], width: number, material: THREE.Material, bevel: number) => {
        const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3 });
        geo.rotateY(-Math.PI / 2);
        geo.translate((width - bevel * 2) / 2, 0, 0);
        const m = new THREE.Mesh(geo, material);
        m.castShadow = m.receiveShadow = true;
        return m;
      };
      const belt = h * 0.64; // 窓の下端の高さ
      // 下半分（ボンネット・ドア・バンパー）
      const lower = side(
        [
          [-L / 2 + 140, 240], [L / 2 - 140, 240], [L / 2 - b, 380], [L / 2 - b, 600], [L / 2 - 200, 800],
          [L / 2 - 950, belt - 10], [-L / 2 + 200, belt + 60], [-L / 2 + b, 860], [-L / 2 + b, 460],
        ],
        w, mat, b,
      );
      // 窓（キャビン）。屋根に向かって少しすぼめる
      // 窓は少し青みのある濃いガラス。映り込みで車体の黒と見分けられるようにする
      const glassMat = new THREE.MeshStandardMaterial({ color: '#3a4652', roughness: 0.12, metalness: 0.35 });
      const cabin = side(
        [
          [L / 2 - 950, belt - 20], [L / 2 - 1900, h - 45], [-L / 2 + 650, h - 65], [-L / 2 + 210, h - 330], [-L / 2 + 210, belt + 50],
        ],
        w * 0.88, glassMat, 0,
      );
      // 屋根
      const roof = box(w * 0.82, 40, L - 2600, 0, h - 60, -L / 2 + 680 + (L - 2600) / 2, mat);
      // タイヤとホイール（前輪は前から 760、後輪は後ろから 690）
      const tire = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.9 });
      const rim = new THREE.MeshStandardMaterial({ color: '#b9bcc0', roughness: 0.3, metalness: 0.8 });
      const wheels = [L / 2 - 760, -L / 2 + 690].flatMap((z) =>
        [-1, 1].flatMap((sx) => {
          const t = new THREE.Mesh(new THREE.CylinderGeometry(310, 310, 190, 28), tire);
          t.rotation.z = Math.PI / 2;
          t.position.set(sx * (w / 2 - 105), 310, z);
          t.castShadow = true;
          const r = new THREE.Mesh(new THREE.CylinderGeometry(200, 200, 196, 20), rim);
          r.rotation.z = Math.PI / 2;
          r.position.copy(t.position);
          return [t, r];
        }),
      );
      // ライト・グリル
      const head = new THREE.MeshStandardMaterial({ color: '#d9dde2', roughness: 0.1, metalness: 0.3 });
      const tail = new THREE.MeshStandardMaterial({ color: '#7a0e12', roughness: 0.2 });
      const lamps = [-1, 1].flatMap((s) => [box(380, 70, 60, s * (w / 2 - 270), 700, L / 2 - 150, head), box(300, 90, 40, s * (w / 2 - 210), 860, -L / 2 + 120, tail)]);
      const grille = box(w * 0.55, 160, 30, 0, 330, L / 2 - 40, new THREE.MeshStandardMaterial({ color: '#0b0b0c', roughness: 0.5 }));
      return [lower, cabin, roof, ...wheels, ...lamps, grille];
    },
  },
  {
    type: 'rod-screen',
    label: 'ロッド手すり・格子',
    hint: '幅に沿って細い棒が並ぶ。奥行きは棒の太さ',
    defaults: { w: 2700, d: 25, h: 2400, color: '#1c1c1d' },
    build: ({ w, d, h, count }, mat) => {
      const n = Math.max(2, count ?? Math.round(w / 300) + 1);
      return Array.from({ length: n }, (_, i) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, h, 12), mat);
        m.position.set(-w / 2 + (w * i) / (n - 1), h / 2, 0);
        m.castShadow = true;
        return m;
      });
    },
  },
  {
    type: 'open-shelf',
    label: '可動棚（オープン棚）',
    hint: '背面を壁に付ける。「棚板の枚数」で段数を決める。一番上の棚板が高さ h',
    defaults: { w: 1200, d: 450, h: 1800, color: '#4a4b4d' },
    build: ({ w, d, h, count }, mat) => {
      const n = Math.max(1, count ?? Math.round(h / 300));
      const boards = Array.from({ length: n }, (_, i) => box(w, 21, d, 0, (h * (i + 1)) / n - 21, 0, mat));
      // 前側の黒い支柱と、壁側の棚柱
      const poles = [-1, 1].flatMap((sx) => [
        box(20, h, 20, sx * (w / 2 - 15), 0, d / 2 - 15, black),
        box(15, h, 15, sx * (w / 2 - 15), 0, -d / 2 + 10, black),
      ]);
      return [...boards, ...poles];
    },
  },
  {
    type: 'wall-shelf',
    label: '可動棚（壁付けレール・支柱なし）',
    hint: '背面を壁に付ける。壁の棚柱（レール）に棚受けで載せる棚で、前の支柱はない。「棚板の枚数」で段数を決める',
    defaults: { w: 900, d: 300, h: 1800, color: '#4a4b4d' },
    build: ({ w, d, h, count }, mat) => {
      const n = Math.max(1, count ?? Math.round(h / 300));
      const boards = Array.from({ length: n }, (_, i) => box(w, 20, d, 0, (h * (i + 1)) / n - 20, 0, mat));
      // 壁の棚柱。幅が広いときは真ん中にも入れる
      const rails = w > 1000 ? [-1, 0, 1] : [-1, 1];
      const out = rails.map((s) => box(16, h + 60, 12, s * (w / 2 - 60), 0, -d / 2 + 6, black));
      // 棚受け（棚板の下、壁から前へ）
      for (let i = 0; i < n; i++) for (const s of rails) out.push(box(6, 30, d * 0.8, s * (w / 2 - 60), (h * (i + 1)) / n - 50, -d / 2 + d * 0.4, black));
      return [...boards, ...out];
    },
  },
  {
    type: 'resin-shelf',
    label: '樹脂棚板（南海プライウッド アームハング棚柱SS）',
    hint: '背面を壁に付ける。壁の棚柱に黒いアーム（棚受）を掛け、厚さ 12mm の樹脂棚板（前に小さな立ち上がり、両端にエンドキャップ）を載せる。幅 800 ごとに板と棚柱が分かれる',
    defaults: { w: 800, d: 290, h: 1800, color: '#3d3e40' },
    build: ({ w, d, h, count, boards }, mat) => {
      const n = Math.max(1, count ?? Math.round(h / 300));
      const pieces = Math.max(1, boards ?? Math.ceil(w / 800));
      const pw = w / pieces;
      const cap = new THREE.MeshStandardMaterial({ color: '#5d5e61', roughness: 0.6 });
      // 棚柱は板の継ぎ目と両端の少し内側
      const railX = Array.from({ length: pieces + 1 }, (_, k) => -w / 2 + pw * k + (k === 0 ? 60 : k === pieces ? -60 : 0));
      const out: THREE.Object3D[] = railX.map((x) => box(18, h + 80, 14, x, -20, -d / 2 + 7, black));
      for (let i = 0; i < n; i++) {
        const y = (h * (i + 1)) / n - 12;
        for (let p = 0; p < pieces; p++) {
          const xc = -w / 2 + pw * (p + 0.5);
          const bw = pw - 20;
          out.push(box(bw, 12, d - 10, xc, y, 5, mat)); // 棚板
          out.push(box(bw, 16, 6, xc, y + 12, d / 2 - 3, mat)); // 前の立ち上がり
          for (const s of [-1, 1]) out.push(box(8, 30, d, xc + s * (bw / 2 + 4), y - 4, 0, cap)); // エンドキャップ
        }
        for (const x of railX) out.push(box(8, 34, d * 0.85, x, y - 34, -d / 2 + d * 0.425, black)); // アーム（棚受）
      }
      return out;
    },
  },
  {
    type: 'winder-stairs',
    label: '回り階段（三角の段）',
    hint: '幅 w の正方形の中で 90° 曲がる段。正面（南）から上り始めて右（東）へ曲がる。h は回り部分の高さの合計、「段数」は回り部分の段の数',
    defaults: { w: 850, d: 850, h: 598, color: '#3a3b3d' },
    build: ({ w, h, count }, mat) => {
      const n = Math.max(1, count ?? 3);
      const rise = h / n;
      const s = w / 2;
      // 回る中心は正面右の角。正面の辺（−x 向き）から右の辺（−z 向き）へ 90° を n 等分する
      const P: [number, number] = [s, s];
      const hit = (deg: number): [number, number] => {
        const a = (deg * Math.PI) / 180;
        const dx = -Math.cos(a);
        const dz = -Math.sin(a);
        const t = Math.min(dx < -1e-6 ? w / -dx : Infinity, dz < -1e-6 ? w / -dz : Infinity);
        return [P[0] + dx * t, P[1] + dz * t];
      };
      const out: THREE.Object3D[] = [];
      for (let k = 0; k < n; k++) {
        const a0 = (90 * k) / n;
        const a1 = (90 * (k + 1)) / n;
        const pts: [number, number][] = [P, hit(a0)];
        if (a0 < 45 && a1 > 45) pts.push([-s, -s]);
        pts.push(hit(a1));
        const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: 40, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const tread = new THREE.Mesh(geo, mat);
        tread.position.y = rise * (k + 1) - 40;
        tread.castShadow = tread.receiveShadow = true;
        out.push(tread);
      }
      return out;
    },
  },
  {
    type: 'toilet',
    label: 'トイレ（タンクレス・一体形）',
    hint: '背面を壁に付ける。正面が便座の前。TOTO ネオレスト NJ1/NJ2（CES9210）の形: 上から見ると前が丸い卵形の一体の本体で、足元に向かって少しすぼまる。ふたは本体の上面いっぱいに載り、閉めると上面がほぼ平ら（奥 515・前へ少し下がる）。便座の高さは約 380',
    defaults: { w: 400, d: 700, h: 515, color: '#f7f7f5' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.1;
      const plan = (sw: number, sd: number) => roundRect(sw, sd, 120, sw / 2);
      const seat = 375;
      // 本体: 卵形の平面を立ち上げ、足元で 0.8 倍まですぼめる
      const body = prism(plan(w, d), seat, 0, mat, 0);
      const pos = body.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        // 回転の誤差で y がわずかに負になると、べき乗が NaN になる（クリックの判定がすべてこの形に当たる）ので 0 で止める
        const k = 0.8 + 0.2 * Math.min(1, Math.max(0, pos.getY(i) / seat)) ** 0.6;
        pos.setXYZ(i, pos.getX(i) * k, pos.getY(i), pos.getZ(i) * (0.92 + 0.08 * (k - 0.8) / 0.2));
      }
      body.geometry.computeVertexNormals();
      // 便座の縁（本体とふたの間の細い線）
      const line = prism(plan(w * 0.985, d * 0.985), 10, seat, new THREE.MeshStandardMaterial({ color: '#d4d5d3', roughness: 0.4 }), 0);
      // ふた: 本体の上面いっぱい。角を丸め、前へ 25 下がる
      const lidH = h - seat - 10;
      const lid = prism(plan(w * 0.97, d * 0.97), lidH, seat + 10, mat, 22);
      const lp = lid.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < lp.count; i++) if (lp.getY(i) > lidH * 0.5) lp.setY(i, lp.getY(i) - 25 * ((lp.getZ(i) + d / 2) / d));
      lid.geometry.computeVertexNormals();
      return [body, line, lid];
    },
  },
  {
    type: 'stick-remote',
    label: 'スティックリモコン（トイレ・横長のバー）',
    hint: '壁付け。背面を壁に付け、「床からの高さ」で下端の高さを決める。TOTO のスティックリモコン（シルバー）は横に長いバーで、手前にボタンが並ぶ',
    defaults: { w: 360, d: 24, h: 34, color: '#c5c8cb' },
    build: ({ w, d, h }, mat) => {
      mat.metalness = 0.75;
      mat.roughness = 0.3;
      const dark = new THREE.MeshStandardMaterial({ color: '#4a4d50', roughness: 0.4 });
      const bar = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, 6), mat);
      bar.position.y = h / 2;
      const out: THREE.Object3D[] = [bar];
      // 手前の面のボタン（流す・止・おしり・ビデ・強弱）
      for (let i = 0; i < 6; i++) out.push(box(26, 10, 2, -w / 2 + 40 + i * ((w - 80) / 5), h * 0.35, d / 2 + 1, i === 0 ? glow('#9fd7ff', 0.4) : dark));
      return out;
    },
  },
  {
    type: 'framed-glass-door',
    label: '開き戸（黒枠・くもりガラス）',
    hint: '開口部の中心に置く（閉めた状態）。正面が開く側',
    defaults: { w: 750, d: 40, h: 2000, color: '#1c1c1d' },
    build: ({ w, d, h, swing }, mat) => {
      const fr = 45;
      const frost = new THREE.MeshStandardMaterial({ color: '#e7ebed', roughness: 0.95, transparent: true, opacity: 0.88 });
      const parts = [
        box(fr, h, d, -w / 2 + fr / 2, 0, 0, mat),
        box(fr, h, d, w / 2 - fr / 2, 0, 0, mat),
        box(w, fr, d, 0, h - fr, 0, mat),
        box(w, fr, d, 0, 0, 0, mat),
        box(w - fr * 2, h - fr * 2, 6, 0, fr, 0, frost),
        box(20, 300, 30, w / 2 - 90, 900, d / 2 + 15, mat), // 取手
      ];
      return [swingLeaf(parts, -w / 2, -(swing ?? 1) * (Math.PI / 2))];
    },
  },
  {
    type: 'kitchen-cabinet',
    label: 'キッチンの下台（引出し）',
    hint: '正面が引出し側。hinged で開き戸。modules に左から幅を並べる（正の数は上下 2 段の引出し、負の数は 1 枚扉（食洗機の扉面材など）、60 未満はフィラー）。省略時は 900 ごと。取手は各段の上端のライン取手（ブラック）',
    defaults: { w: 1800, d: 650, h: 880, color: '#4c4b4a' },
    build: (f, mat) => {
      if (f.fronts?.length) return cabinetByFronts(f, mat);
      const { w, d, h, modules, hinged } = f;
      const plinth = 80;
      const ft = 20;
      const carcass = new THREE.MeshStandardMaterial({ color: '#1d1d1e', roughness: 0.8 });
      const rack = new THREE.MeshStandardMaterial({ color: '#8d9096', roughness: 0.5, metalness: 0.3 });
      const out: THREE.Object3D[] = [
        box(w, h - plinth, d - ft, 0, plinth, -ft / 2, carcass),
        // 台輪（足元のくぼみ）
        box(w - 20, plinth, d - 70, 0, 0, -35, carcass),
      ];
      const n = Math.max(1, Math.round(w / 900));
      const list = modules?.length ? modules : Array.from({ length: n }, () => w / n);
      const sum = list.reduce((a, b) => a + Math.abs(b), 0);
      const k = w / sum;
      const g = 3;
      const z = d / 2 - ft / 2;
      const split = h - 250;
      let x = -w / 2;
      for (const m of list) {
        const mw = Math.abs(m) * k;
        const xc = x + mw / 2;
        x += mw;
        if (mw < 60) {
          out.push(box(mw - g, h - plinth - g, ft, xc, plinth + g / 2, z, mat));
          continue;
        }
        if (hinged) {
          // 開き戸（中に棚板 1 枚）。吊元は外側の縁、取手は上端のライン取手
          out.push(box(mw - 40, 18, d - ft - 30, xc, plinth + (h - plinth) / 2, -ft / 2, carcass));
          const left = xc < 0;
          const hx = left ? xc - mw / 2 + g / 2 : xc + mw / 2 - g / 2;
          const leaf = new THREE.Group();
          leaf.position.set(hx, 0, z);
          leaf.add(box(mw - g, h - plinth - g, ft, xc - hx, plinth + g / 2, 0, mat));
          leaf.add(box(mw - g - 2, 12, 6, xc - hx, h - g - 22, ft / 2 + 1, black));
          leaf.userData.door = { type: 'swing', angle: (left ? -1 : 1) * THREE.MathUtils.degToRad(100), t: 0, part: true };
          out.push(leaf);
          continue;
        }
        const fronts: [number, number][] = m < 0 ? [[plinth, h]] : [[plinth, split], [split, h]];
        for (const [y0, y1] of fronts) {
          // 引出し（食洗機はスライドオープンのかご）。クリックでその引出しだけ KITCHEN_PULL 前へ出る
          const dr = new THREE.Group();
          dr.add(box(mw - g, y1 - y0 - g, ft, xc, y0 + g / 2, z, mat));
          // ライン取手（上端の黒い溝）
          dr.add(box(mw - g - 2, 12, 6, xc, y1 - g - 22, d / 2 + 1, black));
          dr.add(...tray(mw - 60, y1 - y0 - 70, d - ft - 80, xc, y0 + 25, d / 2 - ft, m < 0 ? rack : carcass));
          dr.userData.door = { type: 'slide', dz: KITCHEN_PULL, z0: 0, t: 0, part: true };
          out.push(dr);
        }
      }
      return out;
    },
  },
  {
    type: 'kitchen-sink-bowl',
    label: 'キッチンのシンク（天板の下に付く鉢）',
    hint: 'z は鉢の底（天板の上面 − 深さ）。天板はシンクの穴をあけて置く。w × d が穴の大きさ、h が深さ。トクラス H2 シンク（奥に段差のある 2 段のシンク）',
    defaults: { w: 760, d: 470, h: 200, color: '#9aa0a3' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.45;
      const t = 6;
      const out: THREE.Object3D[] = [
        box(w, t, d, 0, 0, 0, mat),
        box(w, h, t, 0, 0, -d / 2 + t / 2, mat),
        box(w, h, t, 0, 0, d / 2 - t / 2, mat),
        box(t, h, d, -w / 2 + t / 2, 0, 0, mat),
        box(t, h, d, w / 2 - t / 2, 0, 0, mat),
        // H2 シンクの奥の段（プレートやまな板を渡せる 2 段目の縁）
        box(w - 2 * t, t, 70, 0, h - 70, -d / 2 + t + 35, mat),
        box(w - 2 * t, 70, t, 0, h - 70, -d / 2 + t + 70, mat),
      ];
      // 排水口（右寄りの奥）
      const drain = new THREE.Mesh(new THREE.CylinderGeometry(55, 55, 4, 32), new THREE.MeshStandardMaterial({ color: '#c7cacd', roughness: 0.3, metalness: 0.8 }));
      drain.position.set(w * 0.25, t + 1, 40);
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 5, 24), new THREE.MeshStandardMaterial({ color: '#1a1a1a' }));
      hole.position.set(w * 0.25, t + 2, 40);
      out.push(drain, hole);
      return out;
    },
  },
  {
    type: 'ih-cooktop',
    label: 'IH クッキングヒーター（3 口）',
    hint: '天板の上に置く。「床からの高さ」を天板の上面に。黒いガラスのトッププレートに 3 つの加熱部の円、手前に操作部',
    defaults: { w: 600, d: 510, h: 8, color: '#101112' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.05;
      mat.metalness = 0.3;
      const line = new THREE.MeshStandardMaterial({ color: '#7d8084', roughness: 0.5 });
      const out: THREE.Object3D[] = [box(w, h, d, 0, 0, 0, mat), box(w + 4, h - 2, d + 4, 0, 0, 0, new THREE.MeshStandardMaterial({ color: '#2a2b2c', roughness: 0.4, metalness: 0.6 }))];
      for (const [x, z, r] of [[-w * 0.25, d * 0.08, 95], [w * 0.25, d * 0.08, 95], [0, -d * 0.27, 70]] as const) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 2, 4, 48), line);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(x, h + 1, z);
        out.push(ring);
      }
      // 手前の操作部（細い線と小さな印）
      out.push(box(w - 60, 1, 2, 0, h + 0.5, d / 2 - 55, line));
      for (let i = 0; i < 5; i++) out.push(box(14, 1, 14, -w / 2 + 120 + i * 90, h + 0.5, d / 2 - 32, line));
      return out;
    },
  },
  {
    type: 'glass-panel',
    label: '油はね防止のガラスパネル（クリア）',
    hint: '天板の上に立てる。「床からの高さ」を天板の上面に。w 長さ・h 高さ・d 厚み。下に小さな金具',
    defaults: { w: 600, d: 6, h: 450, color: '#dfe9ec' },
    build: ({ w, d, h }, mat) => {
      const glass = new THREE.MeshPhysicalMaterial({ color: mat.color, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
      const steel = new THREE.MeshStandardMaterial({ color: '#c7cacd', roughness: 0.3, metalness: 0.8 });
      return [box(w, h, d, 0, 0, 0, glass), box(40, 30, 30, -w / 2 + 60, 0, 0, steel), box(40, 30, 30, w / 2 - 60, 0, 0, steel)];
    },
  },
  {
    type: 'cooktop',
    label: 'ガスコンロ（ガラストップ 3口）',
    hint: '天板の上に置く。「床からの高さ」を天板の上面に',
    defaults: { w: 600, d: 500, h: 10, color: '#141516' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.08;
      mat.metalness = 0.4;
      const out: THREE.Object3D[] = [box(w, h, d, 0, 0, 0, mat)];
      const iron = new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.5, metalness: 0.6 });
      // 左右手前に大きいバーナー、奥の真ん中に小さいバーナー
      for (const [x, z, r] of [[-w * 0.27, d * 0.12, 95], [w * 0.27, d * 0.12, 95], [0, -d * 0.22, 70]] as const) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 8, 6, 24), iron);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(x, h + 14, z);
        out.push(ring);
      }
      out.push(box(w - 40, 6, 40, 0, h, d / 2 - 30, iron)); // 操作部
      return out;
    },
  },
  {
    type: 'range-hood',
    label: 'レンジフード',
    hint: '背面を壁に付ける。「床からの高さ」はフードの下端。h は天井（下がり天井）までの高さ',
    defaults: { w: 900, d: 600, h: 700, color: '#1d1d1e' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.7;
      mat.metalness = 0.2;
      const bodyH = 90;
      return [
        // 薄いフード本体と前の縁
        box(w, bodyH, d - 20, 0, 0, -10, mat),
        box(w, bodyH - 30, 20, 0, 15, d / 2 - 10, mat),
        // 天井までの幕板（ダクトカバー）
        box(w * 0.36, h - bodyH, d * 0.5, 0, bodyH, -d / 2 + d * 0.25, mat),
        // 下面の整流板と照明
        box(w - 60, 2, d - 80, 0, -1, -10, new THREE.MeshStandardMaterial({ color: '#2a2a2b', roughness: 0.5, metalness: 0.4 })),
        box(160, 2, 30, 0, -2, d / 2 - 40, glow('#fff3df', 0.8)),
      ];
    },
  },
  {
    type: 'sliding-door',
    label: '吊り引き戸（上吊り）',
    hint: '開口部の横の壁に沿って置く。上のレールから吊るので床にレールはなく、下は少し空く。h は天井（レール）までの高さ',
    defaults: { w: 800, d: 36, h: 2400, color: '#efeeea' },
    build: (f, mat) => hungDoor(f, mat, 'none'),
  },
  {
    type: 'mirror-sliding-door',
    label: '吊り引き戸（上吊り・全面ミラー）',
    hint: '正面が全面ミラー（フルハイトドア fit など）。開口部の横の壁に沿って置く。上のレールから吊るので床にレールはなく、下は少し空く。取手の側は「左右反転」で変える',
    defaults: { w: 800, d: 36, h: 2400, color: '#2a2a2b' },
    build: (f, mat) => hungDoor(f, mat, 'full'),
  },
  {
    type: 'mirror-sheet-door',
    label: '吊り引き戸（上吊り・ミラーシート貼り）',
    hint: '普通のハイドアの正面に、全身鏡くらいのミラーシートを貼った戸。取手の側は「左右反転」で変える',
    defaults: { w: 800, d: 36, h: 2400, color: '#efeeea' },
    build: (f, mat) => hungDoor(f, mat, 'sheet'),
  },
  {
    type: 'swing-door',
    label: '開き戸（扉）',
    hint: '開口部（ドア）の中心に置く（閉めた状態）。取手の側は「左右反転」で変える',
    defaults: { w: 720, d: 36, h: 2000, color: '#efeeea' },
    build: ({ w, d, h, flip, swing, handle, doorSeries, stopper, stopperColor }, mat) => {
      const s = flip ? -1 : 1;
      const parts: THREE.Object3D[] = [box(w, h - 10, d, 0, 0, 0, mat)];
      // ドアストッパー: 床の丸い部品（直径 36.4）は、開いた（90°）ときの扉の先から 60 の所。シリンダー式は扉の下に箱（W36・H40・D35）
      const extra: THREE.Object3D[] = [];
      // 吊元は、開く側の面の角（開いた扉が枠や壁にめり込まない）
      const hz = Math.sign(swing ?? 1) * (d / 2);
      if (stopper) {
        const sm = new THREE.MeshStandardMaterial({ color: STOPPER_COLORS[stopperColor ?? 'BE']?.[1] ?? '#1f1f1f', roughness: 0.4, metalness: 0.3 });
        const a = -s * (swing ?? 1) * (Math.PI / 2);
        // 扉の厚みの真ん中・扉の先から 60 の点を、吊元のまわりに 90° 回した所
        const dx = s * (w - 60);
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(18.2, 18.2, 4, 24), sm);
        disc.position.set(-s * (w / 2) + dx * Math.cos(a) - hz * Math.sin(a), 2, hz - dx * Math.sin(a) - hz * Math.cos(a));
        extra.push(disc);
        if (stopper === 'cylinder') parts.push(box(36, 40, 35, s * (w / 2 - 60), 0, Math.sign(swing ?? 1) * (d / 2 + 17.5), sm));
      }
      if (doorSeries === 'calm') {
        // CALM 専用のグレモン錠（ステンレスの角い座に L 字のレバー、下に鍵。ほかのハンドルは選べない）
        const steel = new THREE.MeshStandardMaterial({ color: '#c9ccce', roughness: 0.3, metalness: 0.9 });
        for (const z of [1, -1]) {
          parts.push(box(42, 150, 8, s * (w / 2 - 60), 880, z * (d / 2 + 4), steel));
          parts.push(box(18, 18, 45, s * (w / 2 - 60), 990, z * (d / 2 + 22), steel), box(120, 18, 18, s * (w / 2 - 110), 990, z * (d / 2 + 40), steel));
          parts.push(box(22, 22, 6, s * (w / 2 - 60), 900, z * (d / 2 + 10), steel));
        }
        return [swingLeaf(parts, -s * (w / 2), -s * (swing ?? 1) * (Math.PI / 2), hz), ...extra];
      }
      const black = handleMat(handle);
      // レバーハンドル（両面）
      for (const z of [1, -1]) parts.push(box(16, 16, 40, s * (w / 2 - 70), 950, z * (d / 2 + 20), black), box(130, 14, 14, s * (w / 2 - 120), 950, z * (d / 2 + 38), black));
      return [swingLeaf(parts, -s * (w / 2), -s * (swing ?? 1) * (Math.PI / 2), hz), ...extra];
    },
  },
  {
    type: 'floor-hatch',
    label: '床下点検口（枠なし・フチネ）',
    hint: '床に置く（z は床の高さ）。蓋に「面材」で床と同じ素材を貼ると、周りの 3mm の目地だけが見える（城東テクノ フチネ SPF-FN6060 など）',
    defaults: { w: 600, d: 600, h: 2, color: '#8e8b87' },
    build: ({ w, d, h }, mat) => {
      const joint = new THREE.MeshStandardMaterial({ color: '#2b2b2c', roughness: 0.6 });
      const j = 3;
      return [
        box(w - 2 * j, h, d - 2 * j, 0, 0, 0, mat),
        box(w, 1, j, 0, 0, -d / 2 + j / 2, joint),
        box(w, 1, j, 0, 0, d / 2 - j / 2, joint),
        box(j, 1, d - 2 * j, -w / 2 + j / 2, 0, 0, joint),
        box(j, 1, d - 2 * j, w / 2 - j / 2, 0, 0, joint),
      ];
    },
  },
  {
    type: 'bifold-door',
    label: '折れ戸（クローゼット・両開き）',
    hint: '開口部の中心に置く（閉めた状態）。w は開口の幅で、左右の吊元から 2 枚ずつ折れて正面の側へ開く。取手なし（LIXIL ラフィスのクローゼットの折戸は手掛けのデザイン）。クリックした側だけ開く',
    defaults: { w: 1600, d: 30, h: 2390, color: '#cfccc5' },
    build: ({ w, d, h }, mat) => {
      const out: THREE.Object3D[] = [];
      const leaf = w / 4;
      const gap = 3;
      for (const s of [-1, 1] as const) {
        // 吊元（開口の端）の板。板は吊元から開口の真ん中へ向かう
        const g1 = new THREE.Group();
        g1.position.set(s * (w / 2), 0, 0);
        g1.add(box(leaf - gap, h - 10, d, -s * (leaf / 2), 5, 0, mat));
        // 先の板（折れる所が軸）。手掛けの細い溝
        const g2 = new THREE.Group();
        g2.position.set(-s * leaf, 0, 0);
        g2.add(box(leaf - gap, h - 10, d, -s * (leaf / 2), 5, 0, mat));
        g2.add(box(6, 400, 2, -s * (leaf - 20), 850, d / 2 + 1, black), box(6, 400, 2, -s * (leaf - 20), 850, -d / 2 - 1, black));
        g2.userData.foldInner = true;
        g1.add(g2);
        // 正面（+z）の側へ開く: 左（s = −1）は −、右（s = 1）は ＋ に回す
        g1.userData.door = { type: 'fold', angle: s * THREE.MathUtils.degToRad(80), t: 0, part: true };
        out.push(g1);
      }
      // 上のレール
      out.push(box(w, 20, 40, 0, h, 0, black));
      return out;
    },
  },
  {
    type: 'ecocute-tank',
    label: 'エコキュートの貯湯タンク（角型）',
    hint: '外の地面に置く（z は地面の高さ）。背面を外壁に付ける。370L の角型（幅 630・奥行 730・高さ 1810 くらい）。正面の下に配管カバー',
    defaults: { w: 630, d: 730, h: 1810, color: '#e9e8e3' },
    build: ({ w, d, h }, mat) => {
      const dark = new THREE.MeshStandardMaterial({ color: '#8d8f91', roughness: 0.6 });
      return [
        box(w - 20, 40, d - 20, 0, 0, 0, dark),
        roundBox(w, h - 40, d, 0, 40, 0, 20, mat),
        // 正面の下の配管カバーと銘板
        box(w - 80, 300, 10, 0, 60, d / 2 + 5, mat),
        box(160, 40, 2, 0, h - 300, d / 2 + 1, dark),
      ];
    },
  },
  {
    type: 'outdoor-unit',
    label: '室外機（エアコン・エコキュートのヒートポンプ）',
    hint: '外の地面に置く（z は地面の高さ）。背面を外壁に向ける。正面の右寄りに丸いファンの吹出し口',
    defaults: { w: 800, d: 300, h: 640, color: '#e9e8e3' },
    build: ({ w, d, h }, mat) => {
      const grille = new THREE.MeshStandardMaterial({ color: '#3a3b3d', roughness: 0.7 });
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.36, h * 0.36, 6, 32), grille);
      fan.rotation.x = Math.PI / 2;
      fan.position.set(-w * 0.16, 40 + (h - 40) / 2, d / 2 + 2);
      return [
        box(w - 60, 40, d - 40, 0, 0, 0, grille),
        box(w, h - 40, d, 0, 40, 0, mat),
        fan,
        // 右の側面の通風口（縦のスリット）
        box(6, h * 0.6, d * 0.7, w / 2 + 1, h * 0.25, 0, grille),
      ];
    },
  },
  {
    type: 'wall-bass',
    label: '壁掛けのベース（HERCULES GSP38WBK PLUS のハンガー付き）',
    hint: '背面を壁に向けて置く（中心は壁の面から 110 ＋ 厚みの半分）。z はボディの下端。h は全長、w はボディの幅、d はボディの厚み',
    defaults: { w: 340, d: 45, h: 1170, color: '#1d1d1f' },
    build: (f, mat) => hungInstrument(f, mat, 'bass'),
  },
  {
    type: 'wall-guitar',
    label: '壁掛けのギター（HERCULES GSP38WBK PLUS のハンガー付き）',
    hint: '背面を壁に向けて置く（中心は壁の面から 110 ＋ 厚みの半分）。z はボディの下端。h は全長、w はボディの幅、d はボディの厚み',
    defaults: { w: 330, d: 45, h: 990, color: '#e9e6df' },
    build: (f, mat) => hungInstrument(f, mat, 'guitar'),
  },
  {
    type: 'piano-bench',
    label: 'ピアノ椅子（背もたれなし・四角）',
    hint: '座面 幅 550・奥行 330・高さ 480 くらい。正面（座る人が向く側）をピアノに向ける',
    defaults: { w: 550, d: 330, h: 480, color: '#3b2620' },
    build: ({ w, d, h }, mat) => {
      const cushion = new THREE.MeshStandardMaterial({ color: '#1d1d1f', roughness: 0.7 });
      const out: THREE.Object3D[] = [roundBox(w, 60, d, 0, h - 60, 0, 12, cushion), box(w - 20, 70, d - 20, 0, h - 130, 0, mat)];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box(40, h - 130, 40, sx * (w / 2 - 35), 0, sz * (d / 2 - 35), mat));
      return out;
    },
  },
  {
    type: 'pet-cage',
    label: 'ペットのケージ（金網・多段・キャスター付き）',
    hint: '背面を壁に付ける。チンチラなどの背の高いケージ。中に棚板（count 枚）、下は引出しのトレー、キャスター付き',
    defaults: { w: 800, d: 500, h: 1200, color: '#1d1d1f' },
    build: ({ w, d, h, count, coverSides }, mat) => {
      mat.metalness = 0.4;
      mat.roughness = 0.5;
      const tray = new THREE.MeshStandardMaterial({ color: '#2a2a2b', roughness: 0.6 });
      const board = new THREE.MeshStandardMaterial({ color: '#c9a77c', roughness: 0.7 });
      const base = 100;
      const out: THREE.Object3D[] = [box(w, 120, d, 0, base - 60, 0, tray)];
      // キャスター
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(25, 25, 20, 12), tray);
        c.rotation.z = Math.PI / 2;
        c.position.set(sx * (w / 2 - 40), 25, sz * (d / 2 - 40));
        out.push(c);
      }
      // 金網: 角の柱、上下の枠、縦の細い線（約 25 間隔）
      const top = h;
      const hh = top - base - 60;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box(12, hh, 12, sx * (w / 2 - 6), base + 60, sz * (d / 2 - 6), mat));
      for (const y of [base + 60, top - 8, base + 60 + hh / 2]) {
        out.push(box(w, 8, 8, 0, y, d / 2 - 4, mat), box(w, 8, 8, 0, y, -d / 2 + 4, mat), box(8, 8, d, -w / 2 + 4, y, 0, mat), box(8, 8, d, w / 2 - 4, y, 0, mat));
      }
      const step = 25;
      for (let x = -w / 2 + step; x < w / 2 - 1; x += step) out.push(box(3, hh, 3, x, base + 60, d / 2 - 4, mat), box(3, hh, 3, x, base + 60, -d / 2 + 4, mat));
      for (let z = -d / 2 + step; z < d / 2 - 1; z += step) out.push(box(3, hh, 3, -w / 2 + 4, base + 60, z, mat), box(3, hh, 3, w / 2 - 4, base + 60, z, mat));
      // 天井の網と、中の棚板（左右交互）・正面の扉の枠
      out.push(box(w, 3, d, 0, top - 4, 0, mat));
      const n = count ?? 3;
      for (let i = 0; i < n; i++) {
        const y = base + 60 + ((i + 1) * hh) / (n + 1);
        out.push(box(w * 0.45, 18, d - 40, (i % 2 ? 1 : -1) * w * 0.25, y, 0, board));
      }
      out.push(box(w * 0.5, 8, 6, 0, base + 60 + hh * 0.7, d / 2, mat), box(w * 0.5, 8, 6, 0, base + 120, d / 2, mat));
      // 上から掛けた布（天井と、垂らした面。下は床から少し上まで、ゆるいひだ付き）
      if (coverSides?.length) {
        const cloth = new THREE.MeshStandardMaterial({ color: '#b9b3a8', roughness: 0.95, side: THREE.DoubleSide });
        const o = 15;
        const drop = top - 60;
        out.push(box(w + 2 * o, 4, d + 2 * o, 0, top + 2, 0, cloth));
        const pleats = (len: number, along: 'x' | 'z', pos: number) => {
          const n = Math.max(3, Math.round(len / 120));
          for (let i = 0; i < n; i++) {
            const c = -len / 2 + (len * (i + 0.5)) / n;
            const off = i % 2 ? 6 : 0;
            out.push(along === 'x' ? box(len / n + 2, drop, 4, c, top - drop + 2, pos + Math.sign(pos) * off, cloth) : box(4, drop, len / n + 2, pos + Math.sign(pos) * off, top - drop + 2, c, cloth));
          }
        };
        if (coverSides.includes('back')) pleats(w + 2 * o, 'x', -d / 2 - o);
        if (coverSides.includes('left')) pleats(d + 2 * o, 'z', -w / 2 - o);
        if (coverSides.includes('right')) pleats(d + 2 * o, 'z', w / 2 + o);
      }
      return out;
    },
  },
  {
    type: 'chinchilla',
    label: 'チンチラ',
    hint: '床や棚板の上に置く（z は足元の高さ）。正面が顔の向き。色はバイオレット（青みのある薄い紫がかった灰色・おなかは白）。体長（しっぽを除く）約 250',
    defaults: { w: 130, d: 300, h: 170, color: '#a7a1ad' },
    build: (_f, mat) => {
      mat.roughness = 0.95;
      const belly = new THREE.MeshStandardMaterial({ color: '#ecebef', roughness: 0.95 });
      const ear = new THREE.MeshStandardMaterial({ color: '#c8b6bc', roughness: 0.8 });
      const eye = new THREE.MeshStandardMaterial({ color: '#0d0d0e', roughness: 0.15 });
      const ball = (r: number, sx: number, sy: number, sz: number, x: number, y: number, z: number, m: THREE.Material) => {
        const o = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), m);
        o.scale.set(sx, sy, sz);
        o.position.set(x, y, z);
        o.castShadow = true;
        return o;
      };
      const out: THREE.Object3D[] = [
        // 丸い体（後ろが太い）と、白いおなか
        ball(70, 0.95, 1.0, 1.35, 0, 75, -20, mat),
        ball(60, 0.85, 0.7, 1.1, 0, 45, 0, belly),
        // 頭・ほお・鼻・目
        ball(52, 1.0, 0.95, 1.0, 0, 115, 70, mat),
        ball(28, 1.0, 0.9, 1.0, 0, 100, 105, belly),
        ball(5, 1, 1, 1, 0, 112, 120, ear),
        ball(10, 1, 1.1, 0.8, -25, 126, 111, eye),
        ball(10, 1, 1.1, 0.8, 25, 126, 111, eye),
      ];
      // 大きな丸い耳（少し外へ開く）
      for (const sx of [-1, 1]) {
        const e = ball(26, 1.0, 1.3, 0.35, sx * 30, 170, 55, ear);
        e.rotation.z = -sx * 0.35;
        out.push(e);
        // 前足・後ろ足
        out.push(ball(12, 1, 0.8, 1.2, sx * 22, 10, 55, belly), ball(18, 1, 0.7, 1.6, sx * 35, 10, -55, mat));
      }
      // ふさふさのしっぽ（後ろで上へ巻く）
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(22, 14, 130, 14), mat);
      tail.position.set(0, 60, -125);
      tail.rotation.x = -0.9;
      tail.castShadow = true;
      out.push(tail);
      return out;
    },
  },
  {
    type: 'floor-hatch-framed',
    label: '点検口（アルミ枠・床下／天井）',
    hint: '床に置く（z は床の高さ）。アルミの枠の中に床と同じ素材の蓋（「面材」で指定）。天井点検口は z を天井の高さ − h にして、蓋に天井のクロスを貼る',
    defaults: { w: 600, d: 600, h: 2, color: '#8e8b87' },
    build: ({ w, d, h }, mat) => {
      const frame = new THREE.MeshStandardMaterial({ color: '#a9abad', roughness: 0.35, metalness: 0.8 });
      const k = 15;
      return [
        box(w - 2 * k, h, d - 2 * k, 0, 0, 0, mat),
        box(w, h + 1, k, 0, 0, -d / 2 + k / 2, frame),
        box(w, h + 1, k, 0, 0, d / 2 - k / 2, frame),
        box(k, h + 1, d - 2 * k, -w / 2 + k / 2, 0, 0, frame),
        box(k, h + 1, d - 2 * k, w / 2 - k / 2, 0, 0, frame),
      ];
    },
  },
  {
    type: 'fire-roll-screen',
    label: '防火ロールスクリーン（三協アルミ FIRECUT-RS）',
    hint: '窓の室内側の壁に、窓を囲むように付ける（背面を壁に）。w・h は枠の外の大きさ、z は枠の下端。上にスクリーンを巻き込むケース、左右にガイドレール、下に受け。色（color）は枠の色: シャンパングレイ UC・ブラック KC・ホワイト WH・サンシルバー SLC。screen はスクリーン色（shut シャットホワイト 遮光率 99.9%・mesh メッシュホワイト 80.3%・frost フロストホワイト 69%）。クリックで下ろす・巻き上げる',
    defaults: { w: 910, d: 70, h: 2130, color: '#f2f2f0' },
    build: ({ w, d, h, screen }, mat) => {
      mat.roughness = 0.45;
      mat.metalness = 0.3;
      const head = 110;
      const rail = 40;
      const sill = 30;
      const kind = screen ?? 'frost';
      // シャットは光を通さない、メッシュ・フロストは少し透ける（フロストのほうが明るく透ける）
      const cloth = new THREE.MeshStandardMaterial({
        color: kind === 'shut' ? '#f4f4f2' : '#fbfbf9',
        roughness: 0.95,
        side: THREE.DoubleSide,
        transparent: kind !== 'shut',
        opacity: kind === 'shut' ? 1 : kind === 'mesh' ? 0.82 : 0.72,
        emissive: new THREE.Color(kind === 'shut' ? '#000000' : '#3a3a38'),
      });
      const out: THREE.Object3D[] = [
        // 上のケース、左右のガイドレール、下の受け
        box(w, head, d, 0, h - head, 0, mat),
        box(rail, h - head - sill, d, -w / 2 + rail / 2, sill, 0, mat),
        box(rail, h - head - sill, d, w / 2 - rail / 2, sill, 0, mat),
        box(w, sill, d, 0, 0, 0, mat),
      ];
      // スクリーン（ケースの下から下へ伸びる。巻き上げた状態から始める）
      const drop = h - head - sill - 20;
      const sc = new THREE.Group();
      sc.position.y = h - head;
      const c = box(w - 2 * rail + 10, drop, 2, 0, -drop, 0, cloth);
      sc.add(c);
      // 最初は下ろした（閉じた）状態。クリックで巻き上げる
      sc.userData.door = { type: 'roll', roll: 0.02, t: 1, open: true };
      // 下のバー（スクリーンと一緒に下りる）
      const bar = new THREE.Group();
      bar.add(box(w - 2 * rail + 6, 30, 16, 0, h - head - 30 - drop * 0.02, 0, mat));
      bar.position.y = -drop * 0.98;
      bar.userData.door = { type: 'slide', dy: -drop * 0.98, y0: 0, t: 1, open: true };
      // 窓の前の見えない板（巻き上げていても、窓をクリックすれば下ろせるように）
      const hit = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
      out.push(sc, bar, box(w - 2 * rail, h - head - sill, 1, 0, sill, d / 2 - 6, hit));
      return out;
    },
  },
  {
    type: 'vertical-blind',
    label: '縦型ブラインド（バーチカルブラインド）',
    hint: '窓の上の壁に付ける（窓を覆う幅）。z は羽根の下端、h は羽根の下端から上のレールの上まで。クリックで羽根が回って開く・閉じる。色は羽根の色',
    defaults: { w: 700, d: 70, h: 2000, color: '#e9e7e1' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.85;
      mat.side = THREE.DoubleSide;
      const rail = new THREE.MeshStandardMaterial({ color: mat.color.clone().multiplyScalar(0.9), roughness: 0.5 });
      const out: THREE.Object3D[] = [box(w, 40, d, 0, h - 40, 0, rail)];
      // 羽根は幅 89、80 間隔で少し重なる。閉じた状態（窓と平行）から、クリックで 75° 回る
      const n = Math.max(2, Math.round((w - 20) / 80));
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + 10 + ((w - 20) * (i + 0.5)) / n;
        const g = new THREE.Group();
        g.position.set(x, 0, 0);
        g.add(box(89, h - 50, 2, 0, 0, 0, mat));
        g.userData.door = { type: 'swing', angle: THREE.MathUtils.degToRad(75), t: 0 };
        out.push(g);
      }
      return out;
    },
  },
  {
    type: 'roll-screen',
    label: 'ロールスクリーン',
    hint: '窓の上の壁に付ける（窓を覆う幅）。z は下ろしたときの生地の下端（窓の下端）、h は生地の下端から上のケースの上までの長さ。最初は下ろした状態で、クリックで巻き上げる・下ろす。色は生地の色',
    defaults: { w: 1700, d: 60, h: 600, color: '#4a4b4d' },
    build: ({ w, d, h }, mat) => {
      const caseMat = new THREE.MeshStandardMaterial({ color: mat.color.clone().multiplyScalar(0.85), roughness: 0.5 });
      const cloth = new THREE.MeshStandardMaterial({ color: mat.color, roughness: 0.95, side: THREE.DoubleSide });
      const drop = h - 70;
      const sc = new THREE.Group();
      sc.position.y = h - 70;
      sc.add(box(w - 30, drop, 2, 0, -drop, d / 2 - 10, cloth));
      // 最初は下ろした（閉じた）状態。クリックで巻き上げる
      sc.userData.door = { type: 'roll', roll: 0.03, t: 1, open: true };
      const bar = new THREE.Group();
      bar.add(box(w - 30, 18, 12, 0, h - 70 - drop * 0.03 - 18, d / 2 - 10, caseMat)); // ウエイトバー
      bar.position.y = -drop * 0.97;
      bar.userData.door = { type: 'slide', dy: -drop * 0.97, y0: 0, t: 1, open: true };
      return [box(w, 70, d, 0, h - 70, 0, caseMat), sc, bar, box(w - 30, drop, 1, 0, 0, d / 2 - 4, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))];
    },
  },
  {
    type: 'fridge',
    label: '冷蔵庫（5ドア）',
    hint: '背面を壁に付ける。上が右開きの冷蔵室、その下に製氷室と切替室（左右）、野菜室、冷凍室（東芝 ベジータ GR-V450GT は 幅600・奥行649・高さ1850、色はフロストグレージュ／フロストホワイト）',
    defaults: { w: 600, d: 649, h: 1850, color: '#6c6966' },
    build: ({ w, d, h, doorAngles }, mat) => {
      mat.metalness = 0.45;
      mat.roughness = 0.38;
      const body = mat.clone();
      body.color.offsetHSL(0, 0, -0.05);
      body.metalness = 0.2;
      body.roughness = 0.6;
      const dark = new THREE.MeshStandardMaterial({ color: '#1e1e1f', roughness: 0.7 });
      const fd = 28;
      const zf = d / 2 - fd / 2;
      const g = 3;
      const out: THREE.Object3D[] = [box(w, h - 30, d - fd, 0, 30, -fd / 2, body), box(w - 40, 30, 20, 0, 0, d / 2 - 40, dark)];
      // 扉の高さ（下から。公式の寸法図の側面から読んだ値）: 下段冷凍室 30〜483、製氷室（左）・上段冷凍室（右）483〜631、
      // 野菜室 631〜985（寸法図で引き出した段の上端が 985）、冷蔵室 985〜1850
      const cuts = [30, 483, 631, 985, h];
      const panel = (x: number, bw: number, y0: number, y1: number) => box(bw - g, y1 - y0 - g, fd, x, y0 + g / 2, zf, mat);
      const liner = new THREE.MeshStandardMaterial({ color: '#e9ecee', roughness: 0.5 });
      // 引出し: クリックでその段だけ前へ。野菜室は公式の寸法図（引き出したときの奥行 1,065 − 本体 652）で 413
      const drawer = (x: number, bw: number, y0: number, y1: number, pull: number) => {
        const gp = new THREE.Group();
        gp.add(panel(x, bw, y0, y1), box(bw - 40, 6, 3, x, y1 - 16, d / 2 + 1, dark));
        gp.add(...tray(bw - 50, y1 - y0 - 70, d - fd - 90, x, y0 + 30, d / 2 - fd, liner));
        gp.userData.door = { type: 'slide', dz: pull, z0: 0, t: 0, part: true };
        return gp;
      };
      out.push(drawer(0, w, cuts[0], cuts[1], 413), drawer(-w / 4, w / 2, cuts[1], cuts[2], 350), drawer(w / 4, w / 2, cuts[1], cuts[2], 350), drawer(0, w, cuts[2], cuts[3], 413));
      // 冷蔵室の中（扉を開けると見える）: 白い内箱・棚・明かり
      out.push(box(w - 50, cuts[4] - cuts[3] - 80, 4, 0, cuts[3] + 40, d / 2 - fd + 2, liner));
      for (const y of [1250, 1480, 1680]) out.push(box(w - 60, 6, d - fd - 120, 0, y, -fd / 2 - 40, new THREE.MeshStandardMaterial({ color: '#dfe6ea', roughness: 0.1, transparent: true, opacity: 0.5 })));
      // 冷蔵室の扉（右開き = 吊元は右の前の角）。公式の寸法図では約 128° まで開く（扉を開いたときの奥行 1,213）。
      // 右に壁があるなどで開く角度が違うときは doorAngles[0]（度）
      const door = new THREE.Group();
      door.position.set(w / 2, 0, d / 2);
      for (const p of [
        panel(0, w, cuts[3], cuts[4]),
        // 取手は冷蔵室の左端の縦の溝、タッチ操作部
        box(6, 500, 3, -w / 2 + 14, cuts[3] + 250, d / 2 + 1, dark),
        box(60, 14, 2, w / 2 - 70, cuts[3] + 420, d / 2 + 1, glow('#cfe6ff', 0.3)),
      ]) {
        p.position.x -= w / 2;
        p.position.z -= d / 2;
        door.add(p);
      }
      door.userData.door = { type: 'swing', angle: THREE.MathUtils.degToRad(doorAngles?.[0] ?? 128), t: 0, part: true };
      out.push(door);
      return out;
    },
  },
  {
    type: 'pc-desk-lexia',
    label: 'パソコンデスク（引出し 2 杯・木目の天板＋黒いスチール脚）',
    hint: 'YM WORLD レクシア 00-146（幅 900・奥行 450・高さ 720）。正面が座る側。天板の下に引出し（左が小・右が大）、脚は黒い角パイプで、横と背面に補強のバー',
    defaults: { w: 900, d: 450, h: 720, color: '#5b3f2e' },
    build: ({ w, d, h }, mat) => {
      const top = 25;
      const steel = new THREE.MeshStandardMaterial({ color: '#1b1b1c', roughness: 0.55, metalness: 0.4 });
      const p = 25;
      const out: THREE.Object3D[] = [box(w, top, d, 0, h - top, 0, mat)];
      // 天板の下の引出し（幕板と一体の箱）。正面に引出しの目地
      const dh = 110;
      out.push(box(w - 2 * p - 10, dh, d - 30, 0, h - top - dh, 0, mat));
      const split = -w / 2 + p + (w - 2 * p) * 0.36;
      out.push(box(4, dh - 10, 2, split, h - top - dh + 5, (d - 30) / 2 + 1, steel));
      for (const [x0, x1] of [[-w / 2 + p + 5, split], [split, w / 2 - p - 5]]) out.push(box(80, 8, 6, (x0 + x1) / 2, h - top - 35, (d - 30) / 2 + 3, steel));
      // 脚（4 本の角パイプ）と、両横の下のバー・背面の X の補強
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) out.push(box(p, h - top, p, sx * (w / 2 - p / 2), 0, sz * (d / 2 - p / 2), steel));
        out.push(box(p, 20, d - 2 * p, sx * (w / 2 - p / 2), 120, 0, steel));
      }
      out.push(rod([-w / 2 + p, 120, -d / 2 + 12], [w / 2 - p, h - top - dh, -d / 2 + 12], 14, steel), rod([w / 2 - p, 120, -d / 2 + 12], [-w / 2 + p, h - top - dh, -d / 2 + 12], 14, steel));
      return out;
    },
  },
  {
    type: 'office-chair-mesh',
    label: 'オフィスチェア（メッシュ・肘なし・キャスター）',
    hint: '楽天 singlelife 19-001（幅 550・奥行 585・高さ 870〜980）。正面（座る人が向く側）を机に向ける',
    defaults: { w: 550, d: 585, h: 930, color: '#1d1d1f' },
    build: ({ w, d, h }, mat) => {
      const seat = 450;
      const out: THREE.Object3D[] = [...starBase(w / 2, 60), box(50, seat - 120, 50, 0, 90, 0, black)];
      out.push(roundBox(w - 80, 70, d - 120, 0, seat - 70, 20, 30, mat));
      // 背もたれ（メッシュ。少し後ろへ倒す）と、座面の後ろからの支柱
      const back = roundBox(w - 120, h - seat - 60, 25, 0, 0, 0, 40, mat);
      const bg = new THREE.Group();
      bg.add(back);
      bg.position.set(0, seat + 40, -d / 2 + 70);
      bg.rotation.x = -0.12;
      out.push(bg, box(40, 200, 25, 0, seat - 60, -d / 2 + 60, black));
      return out;
    },
  },
  {
    type: 'gaming-chair',
    label: 'ゲーミングチェア（AKRacing Pro-X V2）',
    hint: '座面幅 390・座面奥行 545・背もたれ高さ 950・全高 1270〜1340・アームレスト（床から 585〜725）。色はレッド（黒地に赤のサイド）。正面（座る人が向く側）を机に向ける',
    defaults: { w: 700, d: 700, h: 1300, color: '#b3121b' },
    build: ({ w, d, h }, mat) => {
      const pu = new THREE.MeshStandardMaterial({ color: '#151516', roughness: 0.5 });
      const seatTop = 480;
      const out: THREE.Object3D[] = [...starBase(w / 2 - 20, 70), box(55, seatTop - 200, 55, 0, 110, 0, black)];
      // 座面（真ん中は黒、両側の盛り上がりは赤）
      out.push(roundBox(390, 110, 545, 0, seatTop - 110, 20, 40, pu));
      for (const sx of [-1, 1]) out.push(roundBox(70, 150, 520, sx * 230, seatTop - 120, 20, 30, mat));
      // 背もたれ（全体を後ろへ少し倒す）: 真ん中は黒、両側の羽根と肩は赤。上に頭の当たる所の穴の黒
      const bh = 950;
      const bg = new THREE.Group();
      bg.add(roundBox(380, bh, 110, 0, 0, 0, 50, pu));
      for (const sx of [-1, 1]) {
        bg.add(roundBox(90, bh - 260, 150, sx * 225, 60, -10, 35, mat));
        bg.add(roundBox(110, 200, 120, sx * 170, bh - 230, 0, 40, mat));
      }
      bg.add(box(70, 120, 4, -110, bh - 210, 58, black), box(70, 120, 4, 110, bh - 210, 58, black));
      bg.position.set(0, seatTop - 60, -d / 2 + 120);
      bg.rotation.x = -0.18;
      out.push(bg);
      // 4D アームレスト（黒）。床から約 650
      for (const sx of [-1, 1]) {
        out.push(box(40, 220, 60, sx * 280, seatTop - 70, 30, black));
        out.push(roundBox(90, 30, 260, sx * 285, 650 - 30, 40, 12, pu));
      }
      void h;
      return out;
    },
  },
  {
    type: 'gaming-desk',
    label: 'ゲーミングデスク（Bauhutte BHD-1200M・昇降式）',
    hint: '幅 1200・奥行 600・高さ 510〜800（h で天板の高さ。BHD-1000M は幅 1000・高さ 590〜800）。黒い天板と、チェアの脚が入る形の脚（後ろ寄りの柱＋床の横バー）、天板の下の補強パイプ。正面が座る側',
    defaults: { w: 1200, d: 600, h: 720, color: '#1a1a1b' },
    build: ({ w, d, h }, mat) => {
      const steel = new THREE.MeshStandardMaterial({ color: '#141415', roughness: 0.55, metalness: 0.35 });
      const top = 25;
      const out: THREE.Object3D[] = [box(w, top, d, 0, h - top, 0, mat)];
      for (const sx of [-1, 1]) {
        const x = sx * (w / 2 - 70);
        // 柱（後ろ寄り。パンチングの板付き）、床の脚（前後に長い）、天板の下の受け
        out.push(box(70, h - top - 40, 50, x, 40, -d / 2 + 140, steel));
        out.push(box(60, 40, d - 40, x, 0, -10, steel));
        out.push(box(50, 30, d - 80, x, h - top - 30, 0, steel));
        out.push(box(4, 300, 120, x + sx * 37, 250, -d / 2 + 140, steel));
      }
      // 補強パイプ（後ろ）とハンギングバー
      out.push(box(w - 140, 30, 30, 0, h - top - 60, -d / 2 + 60, steel));
      return out;
    },
  },
  {
    type: 'side-rack',
    label: 'デスクサイドラック（Bauhutte BHS-700SM ラージ）',
    hint: '幅 704・奥行 360・高さ 1513。黒いスチールの枠に、パンチングの棚板（下・上段・天）と、デスクと同じ高さ（約 720）の木の天板。背板は取り外しできるスチール',
    defaults: { w: 704, d: 360, h: 1513, color: '#1a1a1b' },
    build: ({ w, d, h }, mat) => {
      const steel = new THREE.MeshStandardMaterial({ color: '#151516', roughness: 0.6, metalness: 0.35 });
      const p = 25;
      const out: THREE.Object3D[] = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box(p, h, p, sx * (w / 2 - p / 2), 0, sz * (d / 2 - p / 2), steel));
      // パンチングの棚板（下・上段・天）と、デスクの高さの木の天板（MDF・黒）
      for (const y of [70, 1110, h - 20]) out.push(box(w - 2 * p, 20, d - 2 * p, 0, y, 0, steel));
      out.push(box(w - 2 * p, 25, d - 10, 0, 695, 5, mat));
      // 背板（下の段の後ろ）とコの字の落下防止バー
      out.push(box(w - 2 * p, 500, 3, 0, 120, -d / 2 + 4, steel), box(w - 2 * p, 15, 15, 0, 1110 + 120, d / 2 - 8, steel));
      return out;
    },
  },
  {
    type: 'extension-desk',
    label: 'エクステンションデスク（Bauhutte BHC-1200H）',
    hint: '幅 1200・奥行 250・高さ 590〜800（h で天板の高さ）。天板の下にパンチングの棚（ケーブル・電源タップ）、中段と下段の棚。黒い脚',
    defaults: { w: 1200, d: 250, h: 700, color: '#1a1a1b' },
    build: ({ w, d, h }, mat) => {
      const steel = new THREE.MeshStandardMaterial({ color: '#151516', roughness: 0.6, metalness: 0.35 });
      const out: THREE.Object3D[] = [box(w, 20, d, 0, h - 20, 0, mat)];
      for (const sx of [-1, 1]) {
        out.push(box(30, h - 20, 30, sx * (w / 2 - 20), 0, -d / 2 + 20, steel), box(30, h - 20, 30, sx * (w / 2 - 20), 0, d / 2 - 20, steel));
        out.push(box(40, 25, d, sx * (w / 2 - 20), 0, 0, steel));
      }
      for (const y of [h - 110, Math.round(h / 2) - 20, 80]) out.push(box(w - 70, 15, d - 20, 0, y, 0, steel));
      return out;
    },
  },
  {
    type: 'trash-niche-storage',
    label: '壁面収納（壁埋め込み・ゴミ箱のニッチ付き）',
    hint: '正面を壁の仕上げ面にそろえて、壁の中に埋め込む。上は黒い扉付きの収納（棚板 3 枚、一番下の段の真ん中に逆さのティッシュ）、カウンターの高さ（850）に四角い投入口の棚、その下は薄型のゴミ箱を置くニッチ（奥と両側は TH34190）',
    defaults: { w: 550, d: 160, h: 2050, color: '#1f1f20' },
    build: ({ w, d, h, doorAngles }, mat) => {
      const counter = 850;
      const cab = 1080;
      const lining = getMaterial('cross-th34190');
      const lined = (bw: number, bh: number, bd: number, x: number, y: number, z: number) => {
        const m = box(bw, bh, bd, x, y, z, lining);
        boxUVsInMm(m.geometry as THREE.BoxGeometry);
        return m;
      };
      const steel = new THREE.MeshStandardMaterial({ color: '#c9ccd0', roughness: 0.25, metalness: 0.9 });
      const out: THREE.Object3D[] = [
        // 下のニッチ（奥と両側を壁と同じ木目調に）
        lined(w, cab, 6, 0, 0, -d / 2 + 3),
        lined(6, cab, d, -w / 2 + 3, 0, 0),
        lined(6, cab, d, w / 2 - 3, 0, 0),
      ];
      // 投入口の棚（カウンターと同じ高さ）。四角い穴にステンレスの縁
      const hw = Math.min(320, w - 120);
      const hd = d - 50;
      const side = (w - hw) / 2;
      out.push(
        box(side, 20, d, -w / 2 + side / 2, counter - 20, 0, mat),
        box(side, 20, d, w / 2 - side / 2, counter - 20, 0, mat),
        box(hw, 20, (d - hd) / 2, 0, counter - 20, -d / 2 + (d - hd) / 4, mat),
        box(hw, 20, (d - hd) / 2, 0, counter - 20, d / 2 - (d - hd) / 4, mat),
        box(hw + 8, 3, 4, 0, counter, -hd / 2, steel),
        box(hw + 8, 3, 4, 0, counter, hd / 2, steel),
        box(4, 3, hd, -hw / 2, counter, 0, steel),
        box(4, 3, hd, hw / 2, counter, 0, steel),
      );
      // 薄型の四角いゴミ箱（投入口の真下）
      out.push(box(hw + 60, counter - 70, hd - 10, 0, 0, 0, new THREE.MeshStandardMaterial({ color: '#3c3d3f', roughness: 0.5 })));
      // 上の収納: 黒い箱に棚板 3 枚。扉は両開き（クリックで開く）
      const inner = d - 22;
      out.push(
        box(w, 20, d, 0, cab, 0, mat),
        box(20, h - cab, d, -w / 2 + 10, cab, 0, mat),
        box(20, h - cab, d, w / 2 - 10, cab, 0, mat),
        box(w, 20, d, 0, h - 20, 0, mat),
        box(w - 40, h - cab, 8, 0, cab, -d / 2 + 4, mat),
      );
      const bottom = 240;
      for (const y of [cab + bottom, cab + bottom + 245, cab + bottom + 490]) out.push(box(w - 40, 16, inner, 0, y, -11 + 2, mat));
      // 扉は両開き（左右 2 枚）。クリックで開く（開いた角度は doorAngles、省略時 105°）
      const dw = (w - 6) / 2;
      for (const side of [1, -1]) {
        const door = new THREE.Group();
        door.position.set(side * (w / 2 - 2), cab + 22, d / 2);
        const deg = (side === 1 ? doorAngles?.[1] : doorAngles?.[0]) ?? 105;
        door.userData.door = { type: 'swing', angle: side * THREE.MathUtils.degToRad(deg), t: 0 };
        door.add(box(dw, h - cab - 24, 20, -side * (dw / 2), 0, -10, mat), box(10, 120, 14, -side * (dw - 30), (h - cab) / 2 - 60, 6, black));
        out.push(door);
      }
      // 一番下の段の真ん中: 逆さに置いたティッシュの箱。底板の穴から 1 枚垂れて、下から引き出せる
      const white = new THREE.MeshStandardMaterial({ color: '#f4f4f2', roughness: 0.8 });
      const tx = 0;
      out.push(box(240, 60, 115, tx, cab + 20, -d / 2 + 8 + 70, white));
      out.push(box(190, 22, 16, tx, cab - 1, -d / 2 + 8 + 70, new THREE.MeshStandardMaterial({ color: '#0d0d0d' })));
      const sheet = box(110, 80, 1, tx, cab - 80, -d / 2 + 8 + 74, white);
      sheet.rotation.x = 0.12;
      out.push(sheet);
      return out;
    },
  },
  {
    type: 'shelf-unit',
    label: '造作棚（オープン）',
    hint: '背面を壁に付ける。側板と天板・地板の箱に、「棚板の枚数」だけ棚板が入る',
    defaults: { w: 900, d: 450, h: 1800, color: '#dcdad6' },
    build: ({ w, d, h, count }, mat) => {
      const n = Math.max(1, count ?? 4);
      const out: THREE.Object3D[] = [box(20, h, d, -w / 2 + 10, 0, 0, mat), box(20, h, d, w / 2 - 10, 0, 0, mat), box(w, 20, d, 0, h - 20, 0, mat), box(w, 60, d, 0, 0, 0, mat), box(w - 40, h, 8, 0, 0, -d / 2 + 4, mat)];
      for (let i = 1; i <= n; i++) out.push(box(w - 40, 20, d - 10, 0, 60 + ((h - 80) * i) / (n + 1), 5, mat));
      // 一番下に洗濯かご
      const basket = new THREE.MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.4, metalness: 0.6, wireframe: true });
      for (const x of [-w / 4, w / 4]) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(w / 6, w / 7, 300, 16, 4, true), basket);
        b.position.set(x, 60 + 150, 0);
        out.push(b);
      }
      return out;
    },
  },
  {
    type: 'iron-bar',
    label: 'アイアンバー（L字・タオル干し）',
    hint: '横の棒の長さが w、天井までの吊り下げが h。左端は壁に付き、右端を天井から吊る',
    defaults: { w: 600, d: 16, h: 450, color: '#1c1c1d' },
    build: ({ w, d, h }) => {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, w, 12), black);
      bar.rotation.z = Math.PI / 2;
      bar.position.y = 0;
      const drop = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, h, 12), black);
      drop.position.set(w / 2, h / 2, 0);
      for (const m of [bar, drop]) m.castShadow = true;
      return [bar, drop, box(10, 60, 60, -w / 2, -30, 0, black), box(60, 6, 60, w / 2, h - 6, 0, black)];
    },
  },
  {
    type: 'aj-wall-lamp',
    label: 'ブラケットライト（AJ ウォールランプ型・斜めの円すいの傘）',
    hint: '壁付け。背面を壁に付ける。beaubelle チボリ bbw-009（W258×D165×H276、傘 直径 165×高さ 282、壁の丸い台座 直径 90）。「床からの高さ」は器具の下端。傘は下向きに斜めに付き、開いた口が下を向く。flip で傘の口を壁の側（真下のアートなど）へ向ける',
    defaults: { w: 258, d: 165, h: 276, color: '#1c1c1d' },
    build: ({ d, h, flip }, mat) => {
      mat.roughness = 0.4;
      mat.metalness = 0.3;
      mat.side = THREE.DoubleSide;
      // 傘の傾き。ふつうは口が下・手前（部屋の側）、flip は口が下・壁の側（壁の下のアートを照らす）
      const tilt = flip ? 0.3 : -0.6;
      // 壁の丸い台座
      const base = new THREE.Mesh(new THREE.CylinderGeometry(45, 45, 28, 32), mat);
      base.rotation.x = Math.PI / 2;
      base.position.set(0, h * 0.75, -d / 2 + 14);
      // 斜めの円すいの傘（細い方が上・台座側、太い口が下前）
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(22, 82, 282, 32, 1, true), mat);
      // 細い方を壁側の上に、太い口を下・手前（部屋の側）へ傾ける
      shade.rotation.x = tilt;
      shade.position.set(0, h * 0.5, flip ? 30 : 10);
      shade.castShadow = true;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 4, 16), mat);
      cap.rotation.x = tilt;
      cap.position.set(0, h * 0.5 + Math.cos(tilt) * 141, (flip ? 30 : 10) + Math.sin(tilt) * 141);
      // 傘の中の電球
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(26, 12, 8), glow());
      bulb.position.set(0, h * 0.4, flip ? 20 : 30);
      return [base, shade, cap, bulb];
    },
    lights: ({ h, flip }) => (flip ? spot(0, h * 0.25, 30, [0, -1, -0.12], 40, 90, true) : spot(0, h * 0.25, 60, [0, -1, 0.55], 40, 90, true)),
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
    // 上下に約 90° の光（コイズミ arkia AB54807 などの壁面を照らすブラケット）
    // 光束の半分ずつを上下へ（省略時は 250lm くらいの小さなブラケット）
    lights: ({ h, lumen, beam, kelvin }) => {
      const b = beam ?? 90;
      const cd = candela((lumen ?? 250) / 2, b);
      const c = kelvinColor(kelvin);
      return [...spot(0, h + 10, 20, [0, 1, 0.12], cd, b, false, 8, c), ...spot(0, -10, 20, [0, -1, 0.12], cd, b, false, 8, c)];
    },
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
    // 明るさは家具の lumen（製品の定格光束）と beam（広がり）から。省略時は一般的な 60W 相当（700lm・90°）。
    // 影は付けない（影を付ける光源ごとに GPU のテクスチャの枠を使い、線の光の分と合わせると上限 16 を超えて壁が描けなくなる）
    lights: ({ lumen, beam, kelvin }) => spot(0, -15, 0, [0, -1, 0], candela(lumen ?? 700, beam ?? 90), beam ?? 90, false, 8, kelvinColor(kelvin)),
  },
  {
    type: 'lighting-rail',
    label: 'ライティングレール（＋スポットライト）',
    hint: '天井付け。「床からの高さ」を天井（下がり天井ならその板の下面）の高さに。w がレールの長さ（向きは回転で）。count 個のスポットライトを等間隔に吊るす（黒い筒・下向き。0 ならレールだけ）。lumen・beam は 1 灯あたり',
    defaults: { w: 2000, d: 40, h: 20, color: '#1c1c1d' },
    build: ({ w, count, fixture }, mat) => {
      mat.roughness = 0.45;
      mat.metalness = 0.4;
      const n = Math.max(0, count ?? 3);
      const out: THREE.Object3D[] = [box(w, 20, 36, 0, -20, 0, mat)];
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + (w * (i + 0.5)) / n;
        if (fixture === 'pendant') {
          // ペンダントライト: アダプターから 650 のコード、下に黒いドームの笠（直径 300）
          out.push(box(30, 20, 30, x, -40, 0, mat), box(4, 650, 4, x, -690, 0, mat));
          mat.side = THREE.DoubleSide;
          const dome = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2.2), mat);
          dome.position.set(x, -850, 0);
          dome.castShadow = true;
          const bulb = new THREE.Mesh(new THREE.SphereGeometry(35, 16, 10), glow(WARM, 3));
          bulb.position.set(x, -800, 0);
          out.push(dome, bulb);
          continue;
        }
        // アダプター・アーム・筒
        out.push(box(30, 20, 30, x, -40, 0, mat));
        out.push(box(10, 50, 10, x, -90, 0, mat));
        const can = new THREE.Mesh(new THREE.CylinderGeometry(32, 32, 130, 20), mat);
        can.position.set(x, -140, 0);
        can.castShadow = true;
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 4, 20), glow(WARM, 3));
        lens.position.set(x, -207, 0);
        out.push(can, lens);
      }
      return out;
    },
    lights: ({ w, count, lumen, beam, kelvin, fixture }) => {
      const n = Math.max(0, count ?? 3);
      const out: THREE.Object3D[] = [];
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + (w * (i + 0.5)) / n;
        if (fixture === 'pendant') out.push(...spot(x, -830, 0, [0, -1, 0], candela(lumen ?? 500, beam ?? 100), beam ?? 100, false, 8, kelvinColor(kelvin)));
        else out.push(...spot(x, -215, 0, [0, -1, 0], candela(lumen ?? 600, beam ?? 35), beam ?? 35, false, 8, kelvinColor(kelvin)));
      }
      return out;
    },
  },
  {
    type: 'ceiling-light',
    label: 'シーリングライト',
    hint: '天井付け。「床からの高さ」を天井高にする。施工会社の標準は DAIKO DCL-42121（丸い薄型・3,699lm・6 畳まで・調光調色）',
    defaults: { w: 560, d: 560, h: 90, color: '#f6f6f4' },
    build: ({ w, h }, mat) => {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2 - 20, h, 48), mat);
      body.position.y = -h / 2;
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 - 22, w / 2 - 22, 4, 48), glow(WARM, 2));
      lens.position.y = -h - 2;
      return [body, lens];
    },
    // 部屋全体に広がる光（真下の光度は 全光束 / π くらい）。省略時は 6 畳用（3,700lm）
    lights: ({ h, lumen, kelvin }) => spot(0, -h - 10, 0, [0, -1, 0], ((lumen ?? 3700) / Math.PI) * CAL, 170, false, 8, kelvinColor(kelvin)),
  },
  {
    type: 'spot-light',
    label: 'スポットライト（壁付け・外）',
    hint: '壁付け。背面を壁に付け、「床からの高さ」で取付高さを決める。施工会社の標準は DAIKO DOL-4824YB（黒い筒形・300lm）',
    defaults: { w: 70, d: 150, h: 120, color: '#1c1c1d' },
    build: ({ w, d, h }, mat) => {
      const can = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, d - 30, 20), mat);
      can.rotation.x = Math.PI / 2 - 0.6;
      can.position.set(0, h / 2, 10);
      can.castShadow = true;
      return [box(60, 90, 20, 0, h / 2 - 45, -d / 2 + 10, mat), box(14, 14, 50, 0, h / 2 - 7, -d / 2 + 40, mat), can];
    },
    lights: ({ h, lumen, beam, kelvin }) => spot(0, h / 2 - 30, 40, [0, -1, 0.7], candela(lumen ?? 300, beam ?? 50), beam ?? 50, false, 8, kelvinColor(kelvin)),
  },
  {
    type: 'outlet',
    label: 'コンセント',
    hint: '壁付け。背面を壁に付け、「床からの高さ」でプレートの下端を決める（中心が FL+250 なら 190）。施工会社の標準のプレートはコスモワイド スクエア。名前に種類（2 口・アース付・専用・エアコン用・テレビなど）を書く',
    defaults: { w: 70, d: 8, h: 120, color: '#f7f7f5' },
    build: ({ w, d, h, count, lan }, mat) => {
      const slot = new THREE.MeshStandardMaterial({ color: '#4b4b4b', roughness: 0.6 });
      const out: THREE.Object3D[] = [box(w, h, d, 0, 0, 0, mat)];
      // 差し込み口（count 個、上下に並べる）。LAN 付きは上に詰めて、下に LAN のポート（四角い口）
      const n = count ?? 2;
      const pitch = lan ? 26 : 34;
      const top = lan ? h - 30 : h / 2 + ((n - 1) / 2) * 34 - 9;
      for (let i = 0; i < n; i++) {
        const y = top - i * pitch;
        out.push(box(4, 12, 2, -7, y, d / 2 + 1, slot), box(4, 12, 2, 7, y, d / 2 + 1, slot));
      }
      if (lan) out.push(box(18, 16, 2, 0, 14, d / 2 + 1, slot));
      return out;
    },
  },
  {
    type: 'switch',
    label: 'スイッチ',
    hint: '壁付け。背面を壁に付け、「床からの高さ」でプレートの下端を決める（中心が FL+1200 なら 1140）。count はスイッチの数。施工会社の標準はコスモワイド スクエア（ネームなし・ホタルあり）',
    defaults: { w: 70, d: 8, h: 120, color: '#f7f7f5' },
    build: ({ w, d, h, count }, mat) => {
      const n = Math.max(1, count ?? 1);
      const out: THREE.Object3D[] = [box(w, h, d, 0, 0, 0, mat)];
      const kh = (h - 24) / n;
      const hotaru = glow('#7fd17f', 1.2);
      // ボタンは上から 0, 1, 2…（クリックしたボタンで回路を選ぶ）
      for (let i = 0; i < n; i++) {
        const y = 12 + (n - 1 - i) * kh;
        const key = box(w - 18, kh - 4, 4, 0, y + 2, d / 2 + 2, mat);
        key.userData.button = i;
        out.push(key, box(6, 3, 2, w / 2 - 18, y + kh / 2, d / 2 + 4, hotaru));
      }
      return out;
    },
  },
  {
    type: 'remote-panel',
    label: 'リモコン・モニター（壁付け）',
    hint: '壁付け。インターホンの親機、給湯器のリモコン、換気（熱交換器）のリモコンなど。名前に種類を書く',
    defaults: { w: 120, d: 20, h: 120, color: '#f2f2f0' },
    build: ({ w, d, h }, mat) => [box(w, h, d, 0, 0, 0, mat), box(w - 24, h * 0.45, 2, 0, h * 0.45, d / 2 + 1, new THREE.MeshStandardMaterial({ color: '#202224', roughness: 0.3 }))],
  },
  {
    type: 'line-light',
    label: '間接照明（ライン）',
    hint: '幅の長さで光る。天井や壁際に置き、「床からの高さ」で取付高さを決める',
    defaults: { w: 1800, d: 60, h: 40, color: '#f4f4f4' },
    build: ({ w, d, h }) => [box(w, h, d, 0, 0, 0, glow(WARM, 2.5))],
    // テープライトは線の光にする（細長い面光源）。光る向きは下。「左右反転」で上向き（下がり天井の上に置いて天井を照らす）。
    // 縦に長いもの（縦ラインの間接照明）は正面へ光る
    lights: ({ w, d, h, flip }) => {
      const vertical = h > w * 3;
      const len = (vertical ? h : w) * MM_LIGHT;
      const thick = 0.05;
      // 1m あたり 20cd くらい（以前の点の光と同じくらいの明るさ）になる輝度
      const l = new THREE.RectAreaLight(WARM, 20 / thick, vertical ? thick : len, vertical ? len : thick);
      if (vertical) {
        l.position.set(0, h / 2, d / 2 + 5);
        l.rotation.y = Math.PI;
      } else {
        l.position.set(0, flip ? h + 5 : -5, 0);
        l.rotation.x = flip ? Math.PI / 2 : -Math.PI / 2;
      }
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
    type: 'pitta-mirror',
    label: 'ピッタミラー（ミラタップ・LED なし）',
    hint: '背面を壁に付ける。幅 450〜2300 のオーダー（壁と壁の間なら壁の内のり −10）、高さ 600／800、厚み 40。正面から見たアルミのフレームは 1.5mm だけ、鏡はフレームより 1mm 前に出る。壁から浮いて見える形（裏は小さい）。色（color）はフレーム ホワイト／ブラック',
    defaults: { w: 1690, d: 40, h: 800, color: '#1f1f20' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.4;
      mat.metalness = 0.5;
      // 壁から浮いて見えるように、裏の取付部は一回り小さく奥まる
      const back = box(w - 120, h - 120, d - 20, 0, 60, -10, mat);
      // フレームの前面は鏡より 1mm 奥（同じ面に重なるとちらつく）
      const frame = box(w, h, d - 22, 0, 0, 10, mat);
      const mirror = new Reflector(new THREE.PlaneGeometry(w - 3, h - 3), {
        textureWidth: 512,
        textureHeight: Math.round((512 * h) / w),
        color: 0xc4c8ca,
        clipBias: 0.003,
      });
      mirror.position.set(0, h / 2, d / 2 + 0.5);
      mirror.userData.hideWhenCut = true;
      return [back, frame, mirror];
    },
  },
  {
    type: 'round-mirror',
    label: '丸ミラー',
    hint: '壁掛け。w が直径。「床からの高さ」で下端の高さを決める',
    defaults: { w: 500, d: 20, h: 500, color: '#2a2a2a' },
    build: ({ w, d }, mat) => {
      const back = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, d, 48), mat);
      back.rotation.x = Math.PI / 2;
      back.position.set(0, w / 2, 0);
      const mirror = new Reflector(new THREE.CircleGeometry(w / 2 - 6, 48), { textureWidth: 512, textureHeight: 512, color: 0xb8bcc0, clipBias: 0.003 });
      mirror.position.set(0, w / 2, d / 2 + 1);
      mirror.userData.hideWhenCut = true;
      return [back, mirror];
    },
  },
  {
    type: 'halo-light',
    label: '丸ミラーの裏の間接照明（壁を丸く照らす）',
    hint: '丸ミラーの裏に置く光る輪。w がミラーの直径、d が壁からミラーまでの浮かせ（ミラーは壁から d だけ前に出す）。「床からの高さ」はミラーの下端と同じ',
    defaults: { w: 500, d: 30, h: 500, color: '#1c1c1d' },
    build: ({ w, d }, mat) => {
      // 壁から浮かせる黒い台座と、ミラーの縁の少し内側を回る光る輪（正面からはミラーに隠れる）
      const base = new THREE.Mesh(new THREE.CylinderGeometry(w / 2 - 60, w / 2 - 60, d, 40), mat);
      base.rotation.x = Math.PI / 2;
      base.position.set(0, w / 2, 0);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(w / 2 - 50, 5, 8, 64), glow(WARM, 3));
      ring.position.set(0, w / 2, 0);
      // 壁に映る光の輪（ミラーの縁から外へ 150 ほどぼやけて消える）。照明が消えているときは隠す
      const R = w / 2 + 150;
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const g = c.getContext('2d')!;
      const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      const r0 = (w / 2 - 40) / R;
      grad.addColorStop(0, 'rgba(255,196,120,0)');
      grad.addColorStop(r0, 'rgba(255,196,120,0.95)');
      grad.addColorStop(Math.min(0.99, (w / 2 + 25) / R), 'rgba(255,200,130,0.7)');
      grad.addColorStop(1, 'rgba(255,214,160,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 256);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(R * 2, R * 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
      halo.position.set(0, w / 2, -d / 2 + 2);
      halo.userData.fixture = true;
      return [base, ring, halo];
    },
    // 壁とミラーのすき間から壁へ広がる光。ミラーの真ん中の後ろの点の光で、壁に丸い光の輪ができる
    lights: ({ w, d }) => {
      const l = new THREE.PointLight(WARM, 0.6, (w / 2 + 350) * MM_LIGHT, 2);
      l.position.set(0, w / 2, -d / 2 + 10);
      l.userData.fixture = true;
      return [l];
    },
  },
  {
    type: 'robot-vacuum-base',
    label: 'ロボット掃除機の基地（自動ゴミ収集のベース＋本体）',
    hint: '背面を壁（コンセントの前）に付ける。w・d・h はベースの大きさ（ルンバ j7+ のクリーンベースは 幅310×奥行390×高さ480 くらい）。本体（直径 340・高さ 87）はベースの正面に乗って、半分くらい前へ出る',
    defaults: { w: 310, d: 390, h: 480, color: '#1e1f20' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.5;
      const dark = new THREE.MeshStandardMaterial({ color: '#111213', roughness: 0.35 });
      // ベース: 後ろの縦長の塔（ゴミの紙パック）と、前の低い台（本体が乗る斜面）
      const tower = box(w, h, d * 0.45, 0, 0, -d / 2 + (d * 0.45) / 2, mat);
      const ramp = box(w, 12, d * 0.55, 0, 0, d / 2 - (d * 0.55) / 2, dark);
      const lid = box(w - 30, 4, d * 0.45 - 30, 0, h, -d / 2 + (d * 0.45) / 2, dark);
      // 本体: 丸い掃除機（直径 340・高さ 87）。ベースの正面に半分くらい乗る
      const body = new THREE.Mesh(new THREE.CylinderGeometry(170, 170, 87, 48), mat);
      body.position.set(0, 12 + 87 / 2, d / 2 - 60);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(150, 150, 2, 48), dark);
      top.position.set(0, 12 + 87 + 1, d / 2 - 60);
      for (const m of [tower, body]) m.castShadow = true;
      return [tower, ramp, lid, body, top];
    },
  },
  {
    type: 'star-pendant',
    label: 'ペンダントライト（星型・金色の細い枠）',
    hint: '「床からの高さ」は星の下端の高さ。w が星の大きさ（HFUGUD 星型 1 灯は 22cm）、h はコードを含む長さ（天井まで）。2 つの三角すいを組み合わせた星の形の細い枠の中に電球',
    defaults: { w: 220, d: 220, h: 500, color: '#b8975a' },
    build: ({ w, h }, mat) => {
      mat.roughness = 0.45;
      mat.metalness = 0.7;
      const s = w / 2;
      const c = new THREE.Vector3(0, s, 0);
      // 星の頂点: 立方体の 8 つの角を、偶数と奇数の組に分けた 2 つの正四面体（星形八面体）
      const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new THREE.Vector3(x, y, z))));
      const out: THREE.Object3D[] = [];
      for (const parity of [1, -1]) {
        const vs = corners.filter((v) => v.x * v.y * v.z === parity).map((v) => v.clone().multiplyScalar(s * 0.999).add(c));
        for (let i = 0; i < vs.length; i++)
          for (let j = i + 1; j < vs.length; j++) {
            const a = vs[i];
            const b = vs[j];
            const len = a.distanceTo(b);
            const rod = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, len, 6), mat);
            rod.position.copy(a).add(b).multiplyScalar(0.5);
            rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
            rod.castShadow = true;
            out.push(rod);
          }
      }
      // コード（天井から星の上の角まで）と電球
      const top = w;
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, Math.max(1, h - top), 6), new THREE.MeshStandardMaterial({ color: '#1c1c1d', roughness: 0.6 }));
      cord.position.set(0, top + (h - top) / 2, 0);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(30, 12, 8), glow());
      bulb.position.copy(c);
      out.push(cord, bulb);
      return out;
    },
    lights: ({ w }) => {
      // 小さな部屋（トイレ）に吊るすので、影を付けて壁でさえぎる（影がないと光が壁を突き抜けて隣の部屋まで明るくなる）
      const l = new THREE.PointLight(WARM, 12, 4, 2);
      l.position.set(0, w / 2, 0);
      l.castShadow = true;
      l.shadow.mapSize.set(512, 512);
      l.shadow.camera.near = 0.05;
      l.shadow.bias = -0.002;
      l.userData.fixture = true;
      return [l];
    },
  },
  {
    type: 'basin',
    label: '洗面ボウル',
    hint: 'カウンターの上に置く（「床からの高さ」をカウンター天板の高さに）。h が 30 以下ならアンダーボウル（キッチンのシンクも）',
    defaults: { w: 450, d: 350, h: 130, color: '#f6f6f4' },
    build: ({ w, d, h }, mat) => {
      const drain = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 3, 20), new THREE.MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.3, metalness: 0.8 }));
      if (h <= 30) {
        // 天板に埋め込んだボウル。口のまわりと、奥が暗く見える底
        const deep = mat.clone();
        deep.color.offsetHSL(0, 0, -0.18);
        drain.position.set(w * 0.25, 3, 0);
        return [box(w, 2, d, 0, 0, 0, mat), box(w - 30, 2, d - 30, 0, 1, 0, deep), drain];
      }
      // 置き型（AICA スマートサニタリーU のオンボウル）。薄い縁（8mm）の、角の丸みが小さい長方形の器。
      // 底は一段小さい台で浮いて見え、中の底は排水口へ向かってゆるく下がる
      mat.roughness = 0.15;
      const t = 8;
      const r = 28;
      const foot = 18;
      const ring = roundRect(w, d, r);
      ring.holes.push(roundRect(w - t * 2, d - t * 2, r - t));
      drain.position.set(w * 0.28, foot + 16, 0);
      const floor1 = prism(roundRect(w - t * 2, d - t * 2, r - t), 14, foot, mat);
      const floor2 = prism(roundRect(w * 0.55, d * 0.55, 40), 4, foot + 14, mat);
      floor2.position.x = w * 0.18;
      return [prism(roundRect(w - 40, d - 40, r), foot, 0, mat), prism(ring, h - foot, foot, mat), floor1, floor2, drain];
    },
  },
  {
    type: 'oval-bowl',
    label: '洗面ボウル（置き型・楕円の浅い器）',
    hint: 'カウンターの上に置く（「床からの高さ」をカウンター天板の高さに）。AICA スマートサニタリーU のオンボウル D600 標準フランジ（KMB6AGW-3N）: 外寸 517×366×高さ 136、内の深さ 118、縁は薄い（外 5R）。底はすぼまって小さな台。排水口は奥の縁から 140',
    defaults: { w: 517, d: 366, h: 136, color: '#f6f6f4' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.15;
      mat.side = THREE.DoubleSide;
      const R = w / 2;
      // 断面（半径は w/2 を 1 として）: 外側を下から縁へ、縁で折り返して内側を底まで
      const prof: [number, number][] = [
        [0.0, 0], [0.32, 0], [0.42, 0.06], [0.62, 0.2], [0.8, 0.42], [0.92, 0.66], [0.985, 0.88], [1.0, 1.0],
        [0.985, 1.0], [0.965, 0.87], [0.9, 0.66], [0.78, 0.44], [0.6, 0.27], [0.38, 0.17], [0.0, 0.13],
      ];
      const pts = prof.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r * R), y * h));
      const geo = new THREE.LatheGeometry(pts, 64);
      geo.scale(1, 1, d / w);
      const bowl = new THREE.Mesh(geo, mat);
      bowl.castShadow = bowl.receiveShadow = true;
      const drain = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 3, 24), new THREE.MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.3, metalness: 0.8 }));
      drain.position.set(0, h * 0.13 + 2, -d / 2 + 140);
      return [bowl, drain];
    },
  },
  {
    type: 'wall-faucet',
    label: '壁付け水栓（丸い座・曲がった吐水口・別のレバー）',
    hint: '背面を壁（水栓のふかし）に付ける。「床からの高さ」は吐水口の座の中心。d が吐水口の出、w は座の直径。右に 140 離して丸い座のレバー（flip で左）',
    defaults: { w: 50, d: 200, h: 50, color: '#1c1c1d' },
    build: ({ w, d, flip }, mat) => {
      mat.roughness = 0.45;
      mat.metalness = 0.3;
      const out: THREE.Object3D[] = [];
      const plate = (x: number) => {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 8, 32), mat);
        p.rotation.x = Math.PI / 2;
        p.position.set(x, 0, -d / 2 + 4);
        return p;
      };
      // 吐水口: 壁から水平に出て、先で下へ曲がる丸いパイプ
      const tube = 9;
      const reach = d - 40;
      const straight = new THREE.Mesh(new THREE.CylinderGeometry(tube, tube, reach, 20), mat);
      straight.rotation.x = Math.PI / 2;
      straight.position.set(0, 0, -d / 2 + 8 + reach / 2);
      const bend = new THREE.Mesh(new THREE.TorusGeometry(30, tube, 12, 20, Math.PI / 2), mat);
      bend.rotation.y = -Math.PI / 2;
      bend.position.set(0, -30, -d / 2 + 8 + reach);
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(tube, tube, 30, 20), mat);
      tip.position.set(0, -45, -d / 2 + 8 + reach + 30);
      out.push(plate(0), straight, bend, tip);
      // レバー（別の丸い座から前へ短い軸、下へ細い棒）
      const lx = (flip ? -1 : 1) * 140;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 40, 20), mat);
      shaft.rotation.x = Math.PI / 2;
      shaft.position.set(lx, 0, -d / 2 + 28);
      const lever = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 90, 12), mat);
      lever.position.set(lx, -40, -d / 2 + 44);
      out.push(plate(lx), shaft, lever);
      for (const m of out) m.castShadow = true;
      return out;
    },
  },
  {
    type: 'faucet',
    label: '水栓',
    hint: 'h が立ち上がりの高さ、d が吐水口の長さ。壁付けなら背面を壁に付けて h を小さく。h が 350 以上ならグースネック（キッチンの引出し式）',
    defaults: { w: 30, d: 180, h: 250, color: '#1c1c1d' },
    build: ({ w, d, h }, mat) => {
      if (h >= 350) {
        // グースネック（KOHLER Simplice のような引出し式）。後ろの柱から弧を描いて前で下を向く
        mat.roughness = 0.4;
        mat.metalness = 0.5;
        const r = (d - w) / 2;
        const tube = w / 2.6;
        const zc = -d / 2 + w / 2 + r;
        const yc = h - r - tube;
        const base = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.75, w * 0.8, 40, 20), mat);
        base.position.set(0, 20, zc - r);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(tube, tube, yc, 16), mat);
        post.position.set(0, yc / 2, zc - r);
        const arc = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 10, 28, Math.PI), mat);
        arc.rotation.y = Math.PI / 2;
        arc.position.set(0, yc, zc);
        const head = new THREE.Mesh(new THREE.CylinderGeometry(tube * 1.35, tube * 1.2, 150, 16), mat);
        head.position.set(0, yc - 75, zc + r);
        const lever = box(12, 12, 70, w * 0.9, yc * 0.45, zc - r, mat);
        for (const m of [base, post, arc, head]) m.castShadow = true;
        return [base, post, arc, head, lever];
      }
      const post = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 16), black);
      post.position.set(0, h / 2, -d / 2 + w / 2);
      const spout = box(w * 0.8, w * 0.8, d, 0, h - w * 0.8, 0, black);
      return [post, spout];
    },
  },
  {
    type: 'bathtub',
    label: '浴槽',
    defaults: { w: 1600, d: 750, h: 550, color: '#f4f4f2' },
    build: ({ w, d, h }, mat) => {
      const body = box(w, h, d, 0, 0, 0, mat);
      // 楕円形の湯舟の口
      const water = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 4, 48), new THREE.MeshStandardMaterial({ color: '#cfdde0', roughness: 0.15 }));
      water.scale.set(w - 180, 1, d - 160);
      water.position.y = h + 1;
      return [body, water];
    },
  },
  {
    type: 'caster-base',
    label: 'キャスター付きの台（洗濯機・冷蔵庫の下）',
    hint: '洗濯機などの下に置く、伸縮するキャスター付きの枠。DEWEL 洗濯機台 JS-JJL-0051N（奥行・幅 45〜66.5cm で伸縮、高さ 11〜12cm、8 輪・360° 回転、耐荷重 500kg）。w・d は伸ばした大きさ、h は台の上面の高さ',
    defaults: { w: 620, d: 660, h: 110, color: '#6b6d6f' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.5;
      mat.metalness = 0.3;
      const dark = new THREE.MeshStandardMaterial({ color: '#2a2a2b', roughness: 0.6 });
      const rail = 40;
      const top = h - 25;
      const out: THREE.Object3D[] = [];
      // 四角い枠（伸縮する角パイプ）
      out.push(box(w, 25, rail, 0, top, -d / 2 + rail / 2, mat), box(w, 25, rail, 0, top, d / 2 - rail / 2, mat));
      out.push(box(rail, 25, d - 2 * rail, -w / 2 + rail / 2, top, 0, mat), box(rail, 25, d - 2 * rail, w / 2 - rail / 2, top, 0, mat));
      // 四隅の足（ゴムの受け）と、2 輪ずつのキャスター
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const cx = sx * (w / 2 - rail / 2);
          const cz = sz * (d / 2 - rail / 2);
          out.push(box(70, 10, 70, cx, top - 10, cz, dark));
          for (const o of [-18, 18]) {
            const wheel = new THREE.Mesh(new THREE.CylinderGeometry(22, 22, 14, 16), dark);
            wheel.rotation.z = Math.PI / 2;
            wheel.position.set(cx + o, 22, cz);
            out.push(wheel);
          }
          out.push(box(50, top - 44, 12, cx, 44, cz, mat));
        }
      for (const m of out) m.castShadow = true;
      return out;
    },
  },
  {
    type: 'washer',
    label: '洗濯機（ドラム式）',
    hint: '正面にドアが付く。キャスター付台に載せるなら「床からの高さ」を 100 くらいに',
    defaults: { w: 640, d: 650, h: 1050, color: '#f2f2f0' },
    build: ({ w, d, h }, mat) => {
      const body = box(w, h, d, 0, 0, 0, mat);
      const door = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.3, w * 0.3, 30, 40), new THREE.MeshStandardMaterial({ color: '#2b2d30', roughness: 0.2 }));
      door.rotation.x = Math.PI / 2;
      door.position.set(0, h * 0.58, d / 2 + 10);
      return [body, door];
    },
  },
  {
    type: 'entry-door',
    label: '玄関ドア（親子ドア）',
    hint: '開口部の中心に置く。正面が外側。「本数」を 1 にすると片開き',
    defaults: { w: 1235, d: 60, h: 2330, color: '#2a2c2e' },
    build: ({ w, d, h, count }, mat) => {
      const fr = 40;
      const inner = w - fr * 2;
      const mainW = count === 1 ? inner : Math.round(inner * 0.68);
      const out: THREE.Object3D[] = [
        box(fr, h, d + 20, -w / 2 + fr / 2, 0, 0, mat),
        box(fr, h, d + 20, w / 2 - fr / 2, 0, 0, mat),
        box(w, fr, d + 20, 0, h - fr, 0, mat),
      ];
      if (count !== 1) out.push(box(inner - mainW - 4, h - fr, d, w / 2 - fr - (inner - mainW) / 2, 0, 0, mat));
      // 親扉と縦長のバーハンドル（外側・内側）。左の吊元で外（正面）へ開く
      const hx = -w / 2 + fr + mainW - 90;
      const leaf: THREE.Object3D[] = [box(mainW - 4, h - fr, d, -w / 2 + fr + mainW / 2, 0, 0, mat)];
      for (const s of [1, -1]) leaf.push(box(24, 1000, 24, hx, 550, s * (d / 2 + 40), black));
      // ポケット Key（YKK AP のスマートキー）: 外側のハンドルにリクエストボタン、扉に上下 2 つの電気錠のシリンダー
      const silver = new THREE.MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.3, metalness: 0.8 });
      leaf.push(box(18, 30, 6, hx, 1080, d / 2 + 54, silver));
      for (const y of [820, 1180]) {
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 6, 20), silver);
        cyl.rotation.x = Math.PI / 2;
        cyl.position.set(hx - 70, y, d / 2 + 3);
        leaf.push(cyl);
      }
      out.push(swingLeaf(leaf, -w / 2 + fr, -Math.PI / 2));
      return out;
    },
  },
  {
    type: 'post-box',
    label: '宅配ボックス・ポスト（埋込）',
    hint: '外壁に埋め込む。正面を外に向け、「床からの高さ」で下端の高さを決める。flip で壁を貫通して、背面（家の側）に取り出し扉（前入後出）',
    defaults: { w: 360, d: 60, h: 600, color: '#1e1f20' },
    build: ({ w, d, h, flip }, mat) => [
      box(w, h, d, 0, 0, 0, mat),
      box(w - 80, 12, 8, 0, h - 120, d / 2 + 2, black), // 投函口
      box(w - 40, 2, 4, 0, h * 0.42, d / 2 + 1, black), // 扉の境目
      ...(flip
        ? [box(w - 40, h - 40, 4, 0, 20, -d / 2 - 2, black), box(80, 16, 10, w / 2 - 70, h * 0.55, -d / 2 - 6, new THREE.MeshStandardMaterial({ color: '#8d9096', roughness: 0.4, metalness: 0.7 }))]
        : []),
    ],
  },
  {
    type: 'intercom',
    label: 'インターホン（玄関子機）',
    defaults: { w: 100, d: 30, h: 160, color: '#1e1f20' },
    build: ({ w, d, h }, mat) => {
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.12, w * 0.12, 4, 20), new THREE.MeshStandardMaterial({ color: '#050505', roughness: 0.1 }));
      lens.rotation.x = Math.PI / 2;
      lens.position.set(0, h * 0.75, d / 2 + 2);
      const button = new THREE.Mesh(new THREE.TorusGeometry(w * 0.2, 3, 8, 32), glow('#f4f4f4', 0.6));
      button.position.set(0, h * 0.32, d / 2 + 2);
      return [box(w, h, d, 0, 0, 0, mat), lens, button];
    },
  },
  {
    type: 'down-bracket',
    label: 'ポーチライト（下向き・表札灯）',
    hint: '壁付け。背面を壁に付け、「床からの高さ」で取付高さを決める',
    defaults: { w: 100, d: 100, h: 100, color: '#1c1c1d' },
    build: ({ w, d, h }, mat) => [box(w, h, d, 0, 0, 0, mat), box(w * 0.8, 4, d * 0.8, 0, -4, 0, glow())],
    lights: () => spot(0, -10, 10, [0, -1, 0.1], 30, 70, false),
  },
  {
    type: 'camera',
    label: '防犯カメラ（バレット型・壁付け）',
    hint: '背面を壁に付ける。壁の丸いベースから短いアームが出て、筒形の本体が正面へ少し下向きに付く。「床からの高さ」はベースの中心の高さ',
    defaults: { w: 80, d: 300, h: 120, color: '#f2f2f2' },
    build: ({ w, d }, mat) => {
      const cyl = (r: number, len: number, m: THREE.Material) => {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 28), m);
        c.rotation.x = Math.PI / 2; // 軸を前後（z）に向ける
        c.castShadow = true;
        return c;
      };
      // 壁の丸いベース（ジャンクションボックス）
      const base = cyl(w * 0.8, 40, mat);
      base.position.set(0, 0, -d / 2 + 20);
      // 短いアーム
      const arm = box(36, 36, 70, 0, -18, -d / 2 + 70, mat);
      // 本体（下向き 25°）。サンシェードの庇と黒いレンズ
      const head = new THREE.Group();
      const bodyLen = d - 110;
      const body = cyl(w / 2, bodyLen, mat);
      const hood = box(w + 14, 8, bodyLen + 40, 0, w / 2 - 2, 20, mat);
      const lens = cyl(w * 0.36, 6, new THREE.MeshStandardMaterial({ color: '#0a0a0a', roughness: 0.05, metalness: 0.5 }));
      lens.position.z = bodyLen / 2 + 3;
      const ring = cyl(w * 0.46, 4, new THREE.MeshStandardMaterial({ color: '#1e1e1e', roughness: 0.4 }));
      ring.position.z = bodyLen / 2 + 1;
      head.add(body, hood, ring, lens);
      head.position.set(0, -10, -d / 2 + 110 + bodyLen / 2);
      head.rotation.x = 0.44;
      return [base, arm, head];
    },
  },
  {
    type: 'utility-pole',
    label: '電柱（街路灯付き）',
    hint: '「床からの高さ」を地面（GL）に。街路灯の腕は正面の向きに出る',
    defaults: { w: 350, d: 350, h: 11000, color: '#a9a8a3' },
    build: ({ w, h }, mat) => {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.36, w / 2, h, 24), mat);
      pole.position.y = h / 2;
      pole.castShadow = pole.receiveShadow = true;
      const arm = box(1600, 90, 90, 0, h - 1200, 0, black); // 腕金
      const lampArm = box(50, 50, 900, 0, h - 3600, 450, mat);
      const lamp = box(180, 70, 360, 0, h - 3670, 900, mat);
      const lens = box(150, 4, 320, 0, h - 3674, 900, glow('#fff1d6', 3));
      return [pole, arm, lampArm, lamp, lens];
    },
    lights: ({ h }) => spot(0, h - 3690, 900, [0, -1, 0.05], 50, 100, false),
  },
  {
    type: 'road',
    label: '道路（車道）',
    hint: '幅 w が道路の長さ、奥行き d が車道の幅。端に白線、真ん中に破線を引く。「床からの高さ」を地面（GL）に',
    defaults: { w: 40000, d: 6000, h: 20, color: '#3c3d3f' },
    build: ({ w, d, h }, mat) => {
      const white = new THREE.MeshStandardMaterial({ color: '#e9e9e4', roughness: 0.8 });
      const out: THREE.Object3D[] = [box(w, h, d, 0, 0, 0, mat)];
      for (const s of [-1, 1]) out.push(box(w, 3, 150, 0, h, s * (d / 2 - 300), white));
      // 中央の破線（5m 引いて 5m 空ける）
      for (let x = -w / 2 + 2500; x < w / 2; x += 10000) out.push(box(5000, 3, 150, x, h, 0, white));
      for (const o of out) o.castShadow = false;
      return out;
    },
  },
  {
    type: 'sidewalk',
    label: '歩道（縁石付き）',
    hint: '幅 w が長さ、奥行き d が歩道の幅、h が車道からの高さ。正面（南）側に縁石が付く',
    defaults: { w: 40000, d: 2000, h: 150, color: '#b4b2ad' },
    build: ({ w, d, h }, mat) => {
      const curb = new THREE.MeshStandardMaterial({ color: '#cfcdc8', roughness: 0.85 });
      const tactile = new THREE.MeshStandardMaterial({ color: '#d9b43a', roughness: 0.8 });
      return [box(w, h, d - 150, 0, 0, -75, mat), box(w, h + 10, 150, 0, 0, d / 2 - 75, curb), box(w, 4, 300, 0, h, d / 2 - 600, tactile)];
    },
  },
  {
    type: 'crosswalk',
    label: '横断歩道',
    hint: '幅 w が横断歩道の幅（道路に沿った長さ）、奥行き d が車道の幅',
    defaults: { w: 4000, d: 6000, h: 3, color: '#e9e9e4' },
    build: ({ w, d, h }, mat) => {
      const out: THREE.Object3D[] = [];
      for (let z = -d / 2 + 450; z < d / 2 - 300; z += 900) out.push(box(w, h, 450, 0, 20, z, mat));
      for (const o of out) o.castShadow = false;
      return out;
    },
  },
  {
    type: 'stool',
    label: '丸椅子（スツール）',
    hint: '丸い座面と細い脚。w が座面の直径、h が座面の高さ',
    defaults: { w: 340, d: 340, h: 450, color: '#3a3b3d' },
    build: ({ w, h }, mat) => {
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 35, 32), mat);
      seat.position.y = h - 17;
      seat.castShadow = seat.receiveShadow = true;
      const out: THREE.Object3D[] = [seat];
      // 少し外へ開いた 4 本脚と、足掛けのリング
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, h - 30, 8), black);
        leg.position.set(Math.cos(a) * w * 0.33, (h - 30) / 2, Math.sin(a) * w * 0.33);
        leg.rotation.set(Math.sin(a) * 0.06, 0, -Math.cos(a) * 0.06);
        out.push(leg);
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(w * 0.34, 6, 6, 32), black);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = h * 0.4;
      out.push(ring);
      return out;
    },
  },
  {
    type: 'laundry-shelf',
    label: '造作棚（下に洗濯かご・前開きの扉）',
    hint: '背面を壁に付ける。一番下は棚板なしで床に洗濯かごを直接置き、前に開き戸。扉のすぐ上が洗濯物の投入口（あいている）。その上に「棚板の枚数」だけ棚板',
    defaults: { w: 1030, d: 450, h: 2300, color: '#4a3a30' },
    build: ({ w, d, h, count }, mat) => {
      const doorH = 620;
      const firstShelf = 1000;
      const out: THREE.Object3D[] = [
        box(20, h, d, -w / 2 + 10, 0, 0, mat),
        box(20, h, d, w / 2 - 10, 0, 0, mat),
        box(w, 20, d, 0, h - 20, 0, mat),
        box(w - 40, h, 8, 0, 0, -d / 2 + 4, mat),
      ];
      const n = Math.max(1, count ?? 3);
      for (let i = 0; i < n; i++) out.push(box(w - 40, 20, d - 10, 0, firstShelf + ((h - 20 - firstShelf) * i) / n, 5, mat));
      // 前開きの開き戸（左右 2 枚）。上の端に指を掛けるくぼみ
      const dw = (w - 44) / 2;
      for (const s of [-1, 1]) {
        out.push(box(dw, doorH - 4, 18, s * (dw / 2 + 1), 2, d / 2 - 9, mat));
        out.push(box(120, 10, 6, s * (dw / 2 + 1), doorH - 30, d / 2 + 2, black));
      }
      // 床に直接置いた洗濯かご（扉の上のすき間から投げ入れる）
      const basket = new THREE.MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.4, metalness: 0.6, wireframe: true });
      for (const x of [-w / 4, w / 4]) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(w / 6, w / 7, 520, 16, 4, true), basket);
        b.position.set(x, 260, -20);
        out.push(b);
      }
      return out;
    },
  },
  {
    type: 'paper-holder',
    label: 'トイレットペーパーホルダー',
    hint: '壁付け。背面を壁に付け、「床からの高さ」で下端の高さを決める',
    defaults: { w: 150, d: 125, h: 110, color: '#c9ccd0' },
    build: ({ w, d, h }, mat) => {
      mat.metalness = 0.8;
      mat.roughness = 0.3;
      const paper = new THREE.Mesh(new THREE.CylinderGeometry(55, 55, w - 30, 24), new THREE.MeshStandardMaterial({ color: '#fbfbf9', roughness: 0.9 }));
      paper.rotation.z = Math.PI / 2;
      paper.position.set(0, h - 70, 10);
      return [box(w, 6, d, 0, h - 6, 0, mat), box(w, h, 6, 0, 0, -d / 2 + 3, mat), box(6, 60, 60, -w / 2 + 3, h - 66, -d / 2 + 36, mat), box(6, 60, 60, w / 2 - 3, h - 66, -d / 2 + 36, mat), paper];
    },
  },
  {
    type: 'ceiling-vent',
    label: '換気口（sumika などの全館換気）',
    hint: '天井付けなら「床からの高さ」を天井高に。「左右反転」にすると床に置くガラリ（sumika の吸気口・排気口は床に付く）',
    defaults: { w: 150, d: 150, h: 10, color: '#eeeeec' },
    build: ({ w, d, flip }, mat) => {
      const slot = new THREE.MeshStandardMaterial({ color: '#3a3a3a', roughness: 0.8 });
      // 床のガラリは床から 4 だけ出る枠と、上を向いたすき間
      const y = flip ? 0 : -5;
      const sy = flip ? 4.5 : -6;
      const out: THREE.Object3D[] = [box(w, flip ? 4 : 5, d, 0, y, 0, mat)];
      for (let i = 0; i < 5; i++) out.push(box(w - 24, 1, 10, 0, sy, -d / 2 + 22 + ((d - 44) * i) / 4, slot));
      return out;
    },
  },
  {
    type: 'sumika-exhaust',
    label: '床の排気口（sumika 室内排気口・丸形）',
    hint: '床に置く。マーベックス sumika の床用 室内排気口 KGR-SHW-0008（直径 135・床から出る縁 6、同心円の格子と十字の桟）。色は 7 色（ウォークスルーでクリックして選べる）',
    defaults: { w: 135, d: 135, h: 6, color: '#7a7a79' },
    build: ({ w }, mat) => {
      mat.roughness = 0.55;
      const r = w / 2;
      const dark = new THREE.MeshStandardMaterial({ color: '#1e1e1e', roughness: 0.9 });
      const out: THREE.Object3D[] = [];
      // 縁（外周の平らな輪）と、中の暗いすき間
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 5, 48), mat);
      rim.position.y = 2.5;
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(r - 14, r - 14, 1, 48), dark);
      hole.position.y = 5.2;
      out.push(rim, hole);
      // 同心円の格子（4 重）と真ん中の丸、十字の桟
      for (const k of [0.25, 0.45, 0.65, 0.85]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry((r - 14) * k, 2.2, 6, 48), mat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 5.5;
        out.push(ring);
      }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 2, 20), mat);
      hub.position.y = 5.8;
      out.push(hub);
      for (const a of [0, Math.PI / 2]) {
        const rib = box(2 * (r - 14), 1.5, 3, 0, 5, 0, mat);
        rib.rotation.y = a;
        out.push(rib);
      }
      for (const o of out) o.receiveShadow = true;
      return out;
    },
  },
  {
    type: 'aircon',
    label: 'エアコン（壁掛け）',
    hint: '背面を壁に付け、「床からの高さ」で下端の高さを決める（上端は天井から 50〜100 下）',
    defaults: { w: 798, d: 250, h: 295, color: '#f4f4f2' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.35;
      const body = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, 45), mat);
      body.position.y = h / 2;
      body.castShadow = body.receiveShadow = true;
      const dark = new THREE.MeshStandardMaterial({ color: '#2b2c2e', roughness: 0.6 });
      // 下の吹出口とルーバー、運転ランプ
      return [body, box(w - 90, 46, 30, 0, 18, d / 2 - 40, dark), box(w - 100, 8, 40, 0, 40, d / 2 - 25, mat), box(40, 6, 2, w / 2 - 90, h * 0.45, d / 2 + 1, glow('#9fe0ff', 1))];
    },
  },
  {
    type: 'digital-piano',
    label: '電子ピアノ（アップライト型）',
    hint: '背面を壁に付ける。正面が鍵盤側（Roland RP107 は 幅1378・奥行410・高さ982）',
    defaults: { w: 1378, d: 410, h: 982, color: '#3b2620' },
    build: ({ w, d, h }, mat) => {
      const keyTop = 790;
      const white = new THREE.MeshStandardMaterial({ color: '#f5f3ee', roughness: 0.35 });
      const blackKey = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.3 });
      const gold = new THREE.MeshStandardMaterial({ color: '#c9a95c', roughness: 0.3, metalness: 0.9 });
      const keyD = 150;
      const out: THREE.Object3D[] = [
        // 両側の脚（側板）。床から鍵盤の下まで、前に少し出る
        box(36, keyTop - 40, d - 40, -w / 2 + 18, 0, 20, mat),
        box(36, keyTop - 40, d - 40, w / 2 - 18, 0, 20, mat),
        // 鍵盤の下の本体と、鍵盤の奥のケース（ふたは奥へスライドして開いた状態）
        box(w, 90, d, 0, keyTop - 110, 0, mat),
        box(w, h - 110 - keyTop, d - keyD - 20, 0, keyTop - 20, -(keyD + 20) / 2, mat),
        // 鍵盤の両側の拍子木
        box(45, 60, keyD + 20, -w / 2 + 22, keyTop - 20, d / 2 - (keyD + 20) / 2, mat),
        box(45, 60, keyD + 20, w / 2 - 22, keyTop - 20, d / 2 - (keyD + 20) / 2, mat),
        // 白鍵の面
        box(w - 90, 22, keyD, 0, keyTop - 22, d / 2 - keyD / 2 - 5, white),
        // 前の幕板（足元）とペダル 3 本
        box(w - 72, 520, 16, 0, 60, -d / 2 + 60, mat),
        // 譜面台
        box(w * 0.55, 110, 14, 0, h - 110, -d / 2 + 140, mat),
      ];
      // 黒鍵（オクターブに 5 本）。88 鍵 = 白鍵 52 本
      const kw = (w - 90) / 52;
      for (let i = 0; i < 52; i++) {
        out.push(box(1, 22.5, keyD, -(w - 90) / 2 + kw * i, keyTop - 22, d / 2 - keyD / 2 - 5, blackKey));
        const n = (i + 5) % 7; // A から始まる
        if (i < 51 && n !== 2 && n !== 6) out.push(box(kw * 0.55, 14, keyD * 0.62, -(w - 90) / 2 + kw * (i + 1), keyTop, d / 2 - 5 - keyD + (keyD * 0.62) / 2, blackKey));
      }
      for (const x of [-60, 0, 60]) out.push(box(28, 14, 70, x, 50, -d / 2 + 100, gold));
      return out;
    },
  },
  {
    type: 'sofa-l',
    label: 'ソファ（L字・コーナー）',
    hint: '背面が w の長さ。座面の低い、ぽってりしたモジュール型。L 字の短い側（カウチ）は右端（「左右反転」で左端）で、前への出幅が chaise（mm）',
    defaults: { w: 2400, d: 950, h: 720, color: '#5f5e5c' },
    build: ({ w, d, h, flip, chaise }, mat, sub) => {
      const s = flip ? -1 : 1;
      const base = 260;
      const seat = 140;
      const backD = 230;
      const arm = 230;
      const cw = 950;
      const cl = Math.max(d, chaise ?? d * 1.7);
      const out: THREE.Object3D[] = [];
      const soft = (bw: number, bh: number, bd: number, x: number, y: number, z: number, m = mat) => {
        const c = new THREE.Mesh(new RoundedBoxGeometry(bw, bh, bd, 3, Math.min(40, bh / 2 - 1)), m);
        c.position.set(x, y + bh / 2, z);
        c.castShadow = c.receiveShadow = true;
        return c;
      };
      // 台座（背面の長い側）とカウチの台座
      out.push(soft(w, base, d, 0, 0, 0, sub));
      const cx = s * (w / 2 - cw / 2);
      out.push(soft(cw, base, cl - d + 5, cx, 0, d / 2 + (cl - d) / 2 - 2, sub));
      // 背もたれ（長い側だけ）と、カウチと反対の端のひじ掛け
      out.push(soft(w - arm, h - base, backD, (-s * arm) / 2, base, -d / 2 + backD / 2));
      out.push(soft(arm, 560 - base, d, -s * (w / 2 - arm / 2), base, 0));
      // 座面のクッション（長い側は 2〜3 個に分ける）
      const seatW = w - arm - cw;
      const n = Math.max(1, Math.round(seatW / 800));
      for (let i = 0; i < n; i++) {
        const x = -s * (w / 2 - arm) + s * (seatW * (i + 0.5)) / n;
        out.push(soft(seatW / n - 8, seat, d - backD - 10, x, base, backD / 2 + 5));
      }
      out.push(soft(cw - 8, seat, cl - backD - 10, cx, base, -d / 2 + backD + (cl - backD) / 2));
      // 背当てのクッション
      for (let i = 0; i < n + 1; i++) {
        const x = -s * (w / 2 - arm) + s * ((w - arm) * (i + 0.5)) / (n + 1);
        const c = soft((w - arm) / (n + 1) - 30, 380, 140, x, base + seat, -d / 2 + backD + 60);
        c.rotation.x = -0.18;
        out.push(c);
      }
      return out;
    },
  },
  {
    type: 'dining-table-frame',
    label: 'ダイニングテーブル（石目の天板・黒いフレーム）',
    hint: '天板は「面材」で素材を貼る（大理石調など）。脚と幕板は細い黒いフレーム',
    defaults: { w: 1400, d: 850, h: 720, color: '#c9c6c1' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.35;
      const top = 20;
      const leg = 40;
      const out: THREE.Object3D[] = [box(w, top, d, 0, h - top, 0, mat)];
      // 幕板（天板の下の細いフレーム）
      out.push(box(w - 120, 40, leg, 0, h - top - 40, -d / 2 + 60, black), box(w - 120, 40, leg, 0, h - top - 40, d / 2 - 60, black));
      out.push(box(leg, 40, d - 120, -w / 2 + 60, h - top - 40, 0, black), box(leg, 40, d - 120, w / 2 - 60, h - top - 40, 0, black));
      for (const x of [-w / 2 + 60, w / 2 - 60]) for (const z of [-d / 2 + 60, d / 2 - 60]) out.push(box(leg, h - top, leg, x, 0, z, black));
      return out;
    },
  },
  {
    type: 'ceramic-ext-table',
    label: 'ダイニングテーブル（セラミック天板・伸長式・黒いスチール脚）',
    hint: '家具のきむら のびーるセラミック: 幅 1400（片側だけ伸びて 1800）・奥行 805・高さ 720。天板は 6mm セラミック＋6mm 強化ガラス、脚は角の 4 本（脚の内のり 1230×710）。+x の側が脚ごと伸びる（クリックで伸ばす・縮める）',
    defaults: { w: 1400, d: 805, h: 720, color: '#2a2a2b' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.3;
      const steel = new THREE.MeshStandardMaterial({ color: '#1b1b1c', roughness: 0.5, metalness: 0.4 });
      const top = 12;
      const leg = 50;
      const out: THREE.Object3D[] = [box(w, top, d, 0, h - top, 0, mat)];
      // 天板の下の黒い幕板（スライドレール）と、動かない側（−x）の脚
      out.push(box(w - 160, 50, 30, 0, h - top - 50, -d / 2 + 70, steel), box(w - 160, 50, 30, 0, h - top - 50, d / 2 - 70, steel));
      for (const z of [-d / 2 + 25 + 22, d / 2 - 25 - 22]) out.push(box(leg, h - top, leg, -w / 2 + 60, 0, z, steel));
      // 伸びる側（+x）: 脚ごと 400 スライドし、天板の下にしまってある延長の板（400）が出てくる。クリックで伸ばす・縮める
      const ext = new THREE.Group();
      for (const z of [-d / 2 + 25 + 22, d / 2 - 25 - 22]) ext.add(box(leg, h - top, leg, w / 2 - 60, 0, z, steel));
      ext.add(box(400, top - 1, d - 2, w / 2 - 200, h - top + 0.5, 0, mat));
      ext.add(box(400, 50, 30, w / 2 - 200, h - top - 50, -d / 2 + 70, steel), box(400, 50, 30, w / 2 - 200, h - top - 50, d / 2 - 70, steel));
      ext.userData.door = { type: 'slide', dx: 400, x0: 0, t: 0 };
      out.push(ext);
      return out;
    },
  },
  {
    type: 'curve-back-chair',
    label: 'ダイニングチェア（曲げた背もたれ・細いスチール脚）',
    hint: '家具のきむら のびーるセラミックのチェア: 幅 520・奥行 660・高さ 720・座面 440。背もたれと座面の間に約 13cm のすき間（肘を掛けられる）。正面が座る側。色は座面と背もたれ（PVC）',
    defaults: { w: 520, d: 660, h: 720, color: '#1e1e1f' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.45;
      const steel = new THREE.MeshStandardMaterial({ color: '#1b1b1c', roughness: 0.5, metalness: 0.4 });
      const seatY = 440;
      const out: THREE.Object3D[] = [];
      // 座面
      const seat = new THREE.Mesh(new RoundedBoxGeometry(w - 40, 50, d - 200, 3, 18), mat);
      seat.position.set(0, seatY - 25, 40);
      out.push(seat);
      // 背もたれ: 後ろで丸く曲がって左右へ回り込む帯（高さ 130、座面の 130 上から）
      const r = (w - 20) / 2;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 130, 40, 1, true, Math.PI / 2 - 0.35, Math.PI + 0.7), mat);
      band.material = mat.clone();
      (band.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
      band.scale.z = 0.75;
      band.position.set(0, h - 65, -d / 2 + r * 0.75 + 10);
      out.push(band);
      // 背もたれの両端から前へ伸びる肘掛け（テーブルの天板に引っ掛けられる）
      for (const sx of [-1, 1]) out.push(roundBox(40, 30, 260, sx * (r - 20), h - 100, -d / 2 + r * 0.75 + 10 + 130, 8, mat));
      // 細い脚（前は少し前へ、後ろは後ろへ開く）と、背もたれを支える後ろの立ち上がり
      for (const sx of [-1, 1]) {
        out.push(rod([sx * (w / 2 - 40), 0, d / 2 - 60], [sx * (w / 2 - 50), seatY - 50, d / 2 - 120], 18, steel));
        out.push(rod([sx * (w / 2 - 40), 0, -d / 2 + 40], [sx * (w / 2 - 50), seatY - 50, -d / 2 + 140], 18, steel));
        out.push(rod([sx * (w / 2 - 50), seatY - 50, -d / 2 + 140], [sx * (r - 10), h - 130, -d / 2 + 110], 16, steel));
      }
      out.push(rod([-(w / 2 - 50), seatY - 50, d / 2 - 120], [w / 2 - 50, seatY - 50, d / 2 - 120], 16, steel), rod([-(w / 2 - 50), seatY - 50, -d / 2 + 140], [w / 2 - 50, seatY - 50, -d / 2 + 140], 16, steel));
      for (const m of out) m.castShadow = true;
      return out;
    },
  },
  {
    type: 'dining-chair',
    label: 'ダイニングチェア（黒いフレーム・布張り）',
    hint: '正面が座る側。色は座面と背もたれの布の色',
    defaults: { w: 460, d: 520, h: 820, color: '#cfc4b6' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.95;
      const seatY = 430;
      const l = 32;
      const out: THREE.Object3D[] = [];
      // 前脚と、背もたれまで立ち上がる後ろ脚
      for (const x of [-w / 2 + l / 2, w / 2 - l / 2]) {
        out.push(box(l, seatY, l, x, 0, d / 2 - l / 2, black));
        const back = box(l, h, l, x, 0, -d / 2 + l / 2, black);
        back.rotation.x = -0.06;
        out.push(back);
      }
      // 座面のフレームとクッション、背もたれのクッション
      out.push(box(w, 30, d, 0, seatY - 30, 0, black));
      out.push(new THREE.Mesh(new RoundedBoxGeometry(w - 30, 60, d - 40, 3, 20), mat));
      out[out.length - 1].position.set(0, seatY + 30, 10);
      const pad = new THREE.Mesh(new RoundedBoxGeometry(w - 50, 330, 50, 3, 20), mat);
      pad.position.set(0, h - 230, -d / 2 + 40);
      pad.rotation.x = -0.1;
      out.push(pad);
      for (const m of out) m.castShadow = true;
      return out;
    },
  },
  {
    type: 'bath-faucet',
    label: '浴室の水栓（TOTO スッキリ棚水栓）',
    hint: '背面を壁に付ける。横長のサーモスタット混合水栓（左が温度、右が切替のハンドル）の上に白い棚が載る形。w は棚の幅（W300 など）',
    defaults: { w: 300, d: 130, h: 90, color: '#d6d8da' },
    build: ({ w, d }, mat) => {
      mat.metalness = 0.9;
      mat.roughness = 0.18;
      const white = new THREE.MeshStandardMaterial({ color: '#f4f4f2', roughness: 0.3 });
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, w - 20, 24), mat);
      bar.rotation.z = Math.PI / 2;
      bar.position.set(0, 30, -d / 2 + 60);
      const out: THREE.Object3D[] = [bar];
      // 両端のハンドル（左: 温度の目盛り付きダイヤル、右: 切替）
      for (const s of [-1, 1]) {
        const dial = new THREE.Mesh(new THREE.CylinderGeometry(32, 32, 46, 28), mat);
        dial.rotation.z = Math.PI / 2;
        dial.position.set(s * (w / 2 + 12), 30, -d / 2 + 60);
        out.push(dial, box(4, 10, 3, s * (w / 2 + 12), 52, -d / 2 + 92, s < 0 ? new THREE.MeshStandardMaterial({ color: '#c23b3b' }) : black));
      }
      // 吐水口（真ん中から下向き）と、上に載る白い棚（角の丸い板）
      out.push(box(40, 26, 30, 0, 0, -d / 2 + 95, mat));
      const shelf = new THREE.Mesh(new RoundedBoxGeometry(w + 60, 16, d, 3, 7), white);
      shelf.position.set(0, 72, 0);
      shelf.castShadow = true;
      out.push(shelf);
      return out;
    },
  },
  {
    type: 'slide-bar',
    label: 'シャワーのスライドバー',
    hint: '背面を壁に付ける。h がバーの長さ。シャワーを掛けるホルダーは上のほう',
    defaults: { w: 40, d: 60, h: 900, color: '#d6d8da' },
    build: ({ h, d }, mat) => {
      mat.metalness = 0.9;
      mat.roughness = 0.18;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, h, 16), mat);
      bar.position.set(0, h / 2, -d / 2 + 35);
      return [bar, box(36, 40, 35, 0, 0, -d / 2 + 17, mat), box(36, 40, 35, 0, h - 40, -d / 2 + 17, mat), box(46, 60, 40, 0, h * 0.8, -d / 2 + 40, mat)];
    },
  },
  {
    type: 'hand-shower',
    label: 'ハンドシャワー（TOTO コンフォートウエーブ）',
    hint: 'スライドバーのホルダーに掛けた状態。z はヘッドの中心の高さ。白い本体に丸いヘッドとメッキの縁、下にホース',
    defaults: { w: 110, d: 60, h: 260, color: '#f2f2f0' },
    build: ({ w, h }, mat) => {
      mat.roughness = 0.3;
      const chrome = new THREE.MeshStandardMaterial({ color: '#d6d8da', roughness: 0.15, metalness: 0.9 });
      // 少し前に傾けたヘッド（散水板は手前を向く）と、下へ伸びる持ち手
      const head = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 26, 32), mat);
      disc.rotation.x = Math.PI / 2;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(w / 2, 4, 8, 32), chrome);
      ring.position.z = 13;
      const plate = new THREE.Mesh(new THREE.CircleGeometry(w / 2 - 8, 32), new THREE.MeshStandardMaterial({ color: '#c9ccd0', roughness: 0.35, metalness: 0.5 }));
      plate.position.z = 13.5;
      head.add(disc, ring, plate);
      head.rotation.x = 0.25;
      head.position.set(0, 0, 40);
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(15, 13, h - w / 2, 16), mat);
      grip.position.set(0, -(h - w / 2) / 2 - w / 2 + 10, 30);
      grip.rotation.x = 0.15;
      // 持ち手の下からホースが棚の手前に垂れて、水栓の右端（切替ハンドルの横）につながる。
      // 水栓の右端の位置は、浴室の配置（水栓 FL+850・シャワー FL+1720）に合わせた相対位置（mm）
      const [hx, hy, hz] = [170, -840, 30];
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, -h + 20, 25),
        new THREE.Vector3(0, -h - 200, 150),
        new THREE.Vector3(hx * 0.4, hy - 20, 200),
        new THREE.Vector3(hx + 30, hy - 40, 120),
        new THREE.Vector3(hx, hy, hz),
      ]);
      const hose = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 7, 8), chrome);
      for (const m of [disc, grip, hose]) m.castShadow = true;
      return [head, grip, hose];
    },
  },
  {
    type: 'bed-wood',
    label: 'ベッド（木の枠・キャビネットのヘッドボード付き）',
    hint: '正面が足元。フランスベッド アニバーサリー70C（シングル 幅980・長さ2090・ヘッドボードの高さ850）のような、ナチュラルの木の枠と角材の脚（足元側に 2 本）、頭側に照明の入った棚のくぼみがあるヘッドボード（床まで下りる板）。脚 173・マットレスの厚さ 250。h はマットレスの上面の高さ。木目は「面材」で指定',
    defaults: { w: 980, d: 2090, h: 510, color: '#c9b08f' },
    build: ({ w, d, h }, mat) => {
      // ヘッドボードの厚さ 141（アニバーサリー70C の実物を測った値）
      const hbD = 141;
      const hbH = 850;
      // 脚は 173（実物を測った値）、マットレスの厚さは 250。h はマットレスの上面なので、床板の高さは h − 250
      const legH = 173;
      const frameTop = h - 250;
      const z0 = -d / 2 + hbD;
      const len = d - hbD;
      const white = new THREE.MeshStandardMaterial({ color: '#f3f2ee', roughness: 0.95 });
      const out: THREE.Object3D[] = [];
      // 足元側の 2 本の脚（枠と同じナチュラルの木・角材）。頭側はヘッドボードの板が床まで下りて脚を兼ねる
      const leg = 45;
      for (const x of [-w / 2 + leg / 2 + 30, w / 2 - leg / 2 - 30]) out.push(box(leg, legH, leg, x, 0, d / 2 - 110, mat));
      // 木の枠（床板の周りの框）
      out.push(box(w, frameTop - legH, len, 0, legH, z0 + len / 2, mat));
      // マットレス
      const mattress = new THREE.Mesh(new RoundedBoxGeometry(w - 10, h - frameTop, len - 10, 3, 35), white);
      mattress.position.set(0, frameTop + (h - frameTop) / 2, z0 + len / 2);
      mattress.castShadow = mattress.receiveShadow = true;
      out.push(mattress);
      // ヘッドボード（床から高さ 850 の板）。上のほうの真ん中に、照明の入った角の丸い棚のくぼみ
      const zc = -d / 2 + hbD / 2;
      const nw = w * 0.46;
      const [nb, nt] = [hbH - 245, hbH - 115];
      const side = (w - nw) / 2;
      out.push(
        box(w, nb, hbD, 0, 0, zc, mat),
        box(w, hbH - nt, hbD, 0, nt, zc, mat),
        box(side, nt - nb, hbD, -w / 2 + side / 2, nb, zc, mat),
        box(side, nt - nb, hbD, w / 2 - side / 2, nb, zc, mat),
        // くぼみの奥（深さ 80）と、上に隠した照明
        box(nw, nt - nb, hbD - 80, 0, nb, -d / 2 + (hbD - 80) / 2, mat),
        box(nw - 30, 6, 20, 0, nt - 10, -d / 2 + hbD - 70, glow(WARM, 1.2)),
      );
      return out;
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
  // 面材の指定があれば、色の代わりに素材のテクスチャを実寸で貼る
  if (f.material && getMaterialDef(f.material)) {
    const surfaceId = f.material;
    const surface = getMaterial(surfaceId);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material === mat) {
        if (o.geometry instanceof THREE.BoxGeometry) {
          boxUVsInMm(o.geometry);
          // 木目の素材は、±x の側面の木目を下面・上面と同じ向き（z の方向）にそろえる（下がり天井の板の縁など）
          if (/木目|柾目|板張り/.test(getMaterialDef(surfaceId)?.name ?? '')) woodSidesAlongZ(o.geometry);
          // 床材（タイルなど）を貼った箱の側面は、床と同じ平面図の座標で目地をそろえる（段差の立ち上がり）
          if (surfaceId.startsWith('floor-') && f.rotation % 360 === 0) alignSidesToPlan(o.geometry, f.x + o.position.x, f.y + o.position.z);
        }
        o.material = surface;
      }
    });
  }
  g.position.set(f.x, f.z ?? 0, f.y);
  // 平面図で時計回り = 上から見て時計回り = three.js の y 軸まわりで負の回転
  g.rotation.y = -THREE.MathUtils.degToRad(f.rotation);
  g.userData.furnitureId = f.id;
  g.userData.furnitureType = f.type;
  // ウォークスルーで上り下りできる物（階段）
  g.userData.walkable = ['stairs', 'stairs-box', 'winder-stairs'].includes(f.type);
  return g;
}

/**
 * 上吊りの引き戸。天井に埋め込んだレールから吊るので枠も床のレールもなく、戸の下は 12mm ほど空く。
 * 床には戸の振れ止め（ガイド）だけが付く。mirror なら正面（+z）がミラー面になる。
 */
function hungDoor({ w, d, h, flip, pocket, handle, travel }: Furniture, mat: THREE.MeshStandardMaterial, mirror: 'none' | 'full' | 'sheet'): THREE.Object3D[] {
  const gap = 12;
  const panelH = h - gap - 6;
  // 取手は戸の先（戸袋と反対側）。flip で反対側にする
  const s = flip ? -1 : 1;
  const leaf = new THREE.Group();
  leaf.add(box(w, panelH, d, 0, gap, 0, mat));
  // クリックで戸袋の側（取手と反対）へ、戸の幅から 60 引いた分だけ動く
  // 開けたときに動く長さ。戸袋が短いときは travel で止める
  leaf.userData.door = { type: 'slide', dx: -s * (travel ?? w - 60), t: 0, x0: 0 };
  const out: THREE.Object3D[] = [leaf];
  // 引込み戸（壁の中に引き込む）はレールもガイドも壁の中で見えない
  if (!pocket) {
    // 天井のレール（閉めた位置から戸袋の側へ、戸の幅の 2 倍。戸袋は取手と反対の側）
    out.push(box(w * 2, 6, 40, (-s * w) / 2, h - 6, 0, black));
    // 床のガイド（戸の後ろの端）
    out.push(box(30, gap, d + 20, -s * (w / 2 - 40), 0, 0, black));
  }
  if (mirror === 'full') {
    // フルハイトドア fit のような全面ミラー。細い枠と、細い縦の取手
    leaf.add(...reflector(w - 30, panelH - 30, 0, gap + panelH / 2, d / 2 + 1));
    // 引込み戸は戸袋に入るので、取手は出っ張らない彫り込みの引手（黒い細長い溝）
    for (const z of [1, -1]) leaf.add(pocket ? box(16, 900, 1, s * (w / 2 - 40), 650, z * (d / 2 + 0.5), black) : box(14, 1000, 14, s * (w / 2 - 45), 600, z * (d / 2 + 9), black));
  } else {
    for (const z of [1, -1]) leaf.add(pocket ? box(18, 300, 1, s * (w / 2 - 50), 850, z * (d / 2 + 0.5), handleMat(handle)) : box(20, 500, 8, s * (w / 2 - 60), 850, z * (d / 2 + 4), handleMat(handle)));
    // 貼り付けのミラーシート（全身鏡くらい）
    if (mirror === 'sheet') leaf.add(...reflector(Math.min(450, w - 120), 1600, -s * 40, 350 + 800, d / 2 + 1));
  }
  return out;
}

/**
 * 開き戸の扉の部分を、吊元（x = hinge）を軸にした group にまとめる。クリックで angle だけ回って開く
 */
function swingLeaf(parts: THREE.Object3D[], hinge: number, angle: number, hingeZ = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.x = hinge;
  g.position.z = hingeZ;
  for (const p of parts) {
    p.position.x -= hinge;
    p.position.z -= hingeZ;
    g.add(p);
  }
  g.userData.door = { type: 'swing', angle, t: 0 };
  return g;
}

/** 2 点を結ぶ細い角棒（補強のバーなど） */
function rod(a: [number, number, number], b: [number, number, number], s: number, mat: THREE.Material): THREE.Mesh {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, len), mat);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.lookAt(vb);
  m.castShadow = true;
  return m;
}

/** 角の丸い箱（座面・背もたれなど）。y は下端 */
function roundBox(w: number, h: number, d: number, x: number, y: number, z: number, r: number, mat: THREE.Material): THREE.Mesh {
  const rr = Math.min(r, w / 2 - 1, h / 2 - 1);
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + rr, 0);
  s.lineTo(w / 2 - rr, 0);
  s.quadraticCurveTo(w / 2, 0, w / 2, rr);
  s.lineTo(w / 2, h - rr);
  s.quadraticCurveTo(w / 2, h, w / 2 - rr, h);
  s.lineTo(-w / 2 + rr, h);
  s.quadraticCurveTo(-w / 2, h, -w / 2, h - rr);
  s.lineTo(-w / 2, rr);
  s.quadraticCurveTo(-w / 2, 0, -w / 2 + rr, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -d / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** 椅子の 5 本脚とキャスター（半径 r、脚の高さ y） */
function starBase(r: number, y: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const wheel = new THREE.MeshStandardMaterial({ color: '#111112', roughness: 0.6 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const tip: [number, number, number] = [Math.sin(a) * r, y, Math.cos(a) * r];
    out.push(rod([0, y + 20, 0], tip, 40, black));
    const c = new THREE.Mesh(new THREE.CylinderGeometry(25, 25, 22, 12), wheel);
    c.rotation.z = Math.PI / 2;
    c.position.set(tip[0], 25, tip[2]);
    out.push(c);
  }
  return out;
}

/**
 * 壁に掛けたベース・ギター。ヘッドの下を HERCULES GSP38WBK PLUS（黒い木のベースに、オートグリップの U 字のアーム）で受ける。
 * ボディは大小 2 つの丸を重ねた形、ネックとヘッドは細い板
 */
function hungInstrument({ w, d, h }: Furniture, mat: THREE.MeshStandardMaterial, kind: 'bass' | 'guitar'): THREE.Object3D[] {
  const neckWood = new THREE.MeshStandardMaterial({ color: '#c49a68', roughness: 0.6 });
  const board = new THREE.MeshStandardMaterial({ color: '#3a2a20', roughness: 0.6 });
  const metal = new THREE.MeshStandardMaterial({ color: '#cfd2d4', roughness: 0.3, metalness: 0.9 });
  const pick = new THREE.MeshStandardMaterial({ color: '#111112', roughness: 0.4 });
  mat.roughness = 0.25;
  const out: THREE.Object3D[] = [];
  const bodyLen = kind === 'bass' ? 480 : 440;
  const disc = (r: number, y: number, x = 0) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d, 40), mat);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, 0);
    m.castShadow = true;
    return m;
  };
  // ボディ（下の大きい丸・上の小さい丸）とピックガード・ブリッジ
  out.push(disc(w / 2, w / 2), disc(w * 0.4, bodyLen - w * 0.4, -10));
  out.push(box(w * 0.45, bodyLen * 0.45, 2, -w * 0.08, bodyLen * 0.25, d / 2 + 1, pick));
  out.push(box(w * 0.3, 30, 8, 0, 110, d / 2 + 4, metal));
  // ネック・指板・ヘッド
  const headLen = kind === 'bass' ? 200 : 180;
  const neckLen = h - bodyLen - headLen + 60;
  out.push(box(kind === 'bass' ? 50 : 45, neckLen, 22, 0, bodyLen - 60, -d / 2 + 30, neckWood));
  out.push(box(kind === 'bass' ? 48 : 43, neckLen, 4, 0, bodyLen - 60, -d / 2 + 43, board));
  out.push(box(kind === 'bass' ? 85 : 75, headLen, 16, 0, h - headLen, -d / 2 + 26, neckWood));
  // 弦（細い線）
  const n = kind === 'bass' ? 4 : 6;
  for (let i = 0; i < n; i++) out.push(box(1.5, h - headLen - 110, 1.5, (i - (n - 1) / 2) * (kind === 'bass' ? 9 : 7), 110, -d / 2 + 47, metal));
  // ハンガー（壁のベース板と、ネックの付け根（ヘッドのすぐ下）を受ける U 字のアーム）
  const wallZ = -d / 2 - 110;
  const yoke = h - headLen - 40;
  out.push(box(70, 125, 20, 0, yoke - 60, wallZ + 10, pick));
  out.push(box(20, 20, 110, 0, yoke - 10, wallZ + 20 + 55, pick));
  for (const sx of [-1, 1]) out.push(box(14, 50, 14, sx * 38, yoke - 10, -d / 2 + 30, pick));
  out.push(box(90, 14, 14, 0, yoke - 10, -d / 2 + 30, pick));
  return out;
}

/** キッチンの引出しを引き出す長さ（トクラス コラージアの引出しはフルスライドで、約 40cm 奥まで開く） */
const KITCHEN_PULL = 400;

/** 引出しの中の箱（上が開いた箱）。前の板のすぐ後ろ（zFront）から奥へ depth */
/**
 * トクラスの取付設置図の展開図どおりのキッチンの下台（modules と fronts）。
 * 前板は上から順に積む。引出しはクリックでそれだけ前へ出る。0 から下は扉のない空洞（中の背板・底板・側板と、給水・給湯・排水の管）
 */
function cabinetByFronts({ w, d, h, modules, fronts }: Furniture, mat: THREE.MeshStandardMaterial): THREE.Object3D[] {
  const ft = 20;
  const g = 3;
  const carcass = new THREE.MeshStandardMaterial({ color: '#1d1d1e', roughness: 0.8 });
  const rack = new THREE.MeshStandardMaterial({ color: '#8d9096', roughness: 0.5, metalness: 0.3 });
  const pipeMat = new THREE.MeshStandardMaterial({ color: '#b9bcbf', roughness: 0.5, metalness: 0.2 });
  const out: THREE.Object3D[] = [];
  const list = modules ?? [];
  const sum = list.reduce((a, b) => a + Math.abs(b), 0);
  const k = w / sum;
  const z = d / 2 - ft / 2;
  const inD = d - ft;
  let x = -w / 2;
  list.forEach((m, i) => {
    const mw = Math.abs(m) * k;
    const xc = x + mw / 2;
    x += mw;
    // フィラー（両端の側板）は床まで、奥行いっぱいの扉と同じ面材（横から見える面もグレーストーン）
    if (mw < 60) {
      out.push(box(mw, h, d, xc, 0, 0, mat));
      return;
    }
    const spec = fronts?.[i] ?? [];
    let top = h;
    let open = false;
    for (const s of spec) {
      if (s === 0) {
        open = true;
        break;
      }
      const hh = Math.abs(s);
      const y0 = top - hh;
      if (s < 0) {
        out.push(box(mw - g, hh - g, ft, xc, y0 + g / 2, z, mat));
      } else {
        const dr = new THREE.Group();
        dr.add(box(mw - g, hh - g, ft, xc, y0 + g / 2, z, mat));
        dr.add(box(mw - g - 2, 12, 6, xc, top - g - 22, d / 2 + 1, black));
        // 食洗機（モジュールの幅が負）は大きい前板の中だけかご
        dr.add(...tray(mw - 60, Math.max(40, hh - 70), inD - 60, xc, Math.max(y0 + 25, 25), d / 2 - ft, m < 0 && hh >= 400 ? rack : carcass));
        // 食洗機（幅が負のモジュールの大きい前板）: 中に銀色のかご（下段に立てた皿、上段にカップ、右にカトラリーかご）
        if (m < 0 && hh >= 400) dr.add(...dishwasherRack(mw - 70, hh - 80, inD - 70, xc, y0 + 30, d / 2 - ft - 5));
        dr.userData.door = { type: 'slide', dz: KITCHEN_PULL, z0: 0, t: 0, part: true };
        out.push(dr);
      }
      top = y0;
    }
    if (open) {
      // 空洞: 背板・底板・左右の側板（天板の下まで。上はシンクの鉢が入るので箱でふさがない）、管
      out.push(box(mw, h, 18, xc, 0, -d / 2 + 9, carcass), box(mw, 18, inD, xc, 0, -ft / 2, carcass));
      out.push(box(18, h, inD, xc - mw / 2 + 9, 0, -ft / 2, carcass), box(18, h, inD, xc + mw / 2 - 9, 0, -ft / 2, carcass));
      for (const [px, r] of [[-0.25, 10], [-0.05, 10], [0.15, 25]] as const) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, top - 18, 12), pipeMat);
        p.position.set(xc + mw * px, 18 + (top - 18) / 2, -d / 2 + 90);
        out.push(p);
      }
      return;
    }
    // 箱と、前板が床まで届かない分の台輪（奥へ引っ込む）
    out.push(box(mw, h - top, inD, xc, top, -ft / 2, carcass));
    if (top > 1) out.push(box(mw, top, inD - 50, xc, 0, -ft / 2 - 25, carcass));
  });
  return out;
}

/** 食洗機の中（引き出したときに見える）。銀色の線のかご 2 段、下段に皿を立てて並べ、上段にカップ、手前の隅にカトラリーかご */
function dishwasherRack(w: number, h: number, depth: number, x: number, y: number, zFront: number): THREE.Object3D[] {
  const wire = new THREE.MeshStandardMaterial({ color: '#c7cacd', roughness: 0.35, metalness: 0.8 });
  const plate = new THREE.MeshStandardMaterial({ color: '#f4f3ef', roughness: 0.3 });
  const cup = new THREE.MeshStandardMaterial({ color: '#d9dcde', roughness: 0.3 });
  const out: THREE.Object3D[] = [];
  const zc = zFront - depth / 2;
  // 内箱（ステンレス）
  out.push(box(w, 4, depth, x, y, zc, wire), box(4, h, depth, x - w / 2, y, zc, wire), box(4, h, depth, x + w / 2, y, zc, wire), box(w, h, 4, x, y, zFront - depth, wire));
  for (const [ly, lh] of [[y + 20, 120], [y + h * 0.55, 90]] as const) {
    // かごの底の格子と縁
    for (let i = 0; i <= 8; i++) out.push(box(3, 3, depth - 40, x - w / 2 + 20 + ((w - 40) * i) / 8, ly, zc, wire));
    out.push(box(w - 30, 4, 4, x, ly + lh, zFront - 20, wire), box(w - 30, 4, 4, x, ly + lh, zFront - depth + 20, wire));
  }
  // 下段: 立てた皿（前後に並ぶ）
  for (let i = 0; i < 7; i++) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(105, 105, 6, 28), plate);
    p.rotation.x = Math.PI / 2;
    p.rotation.y = Math.PI / 2;
    p.position.set(x - w * 0.12, y + 20 + 108, zFront - 60 - i * ((depth - 120) / 6));
    out.push(p);
  }
  // 上段: 伏せたカップ
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(38, 30, 85, 18), cup);
    c.position.set(x - w / 2 + 70 + i * 100, y + h * 0.55 + 45, zFront - 90 - j * 160);
    out.push(c);
  }
  // カトラリーかご（右手前）
  out.push(box(110, 120, 110, x + w / 2 - 75, y + 25, zFront - 70, wire));
  return out;
}

function tray(bw: number, bh: number, depth: number, x: number, y: number, zFront: number, mat: THREE.Material): THREE.Object3D[] {
  const t = 12;
  const zc = zFront - depth / 2;
  return [
    box(bw, t, depth, x, y, zc, mat),
    box(t, bh, depth, x - bw / 2 + t / 2, y, zc, mat),
    box(t, bh, depth, x + bw / 2 - t / 2, y, zc, mat),
    box(bw, bh, t, x, y, zFront - depth + t / 2, mat),
  ];
}

/** 周りが映り込む鏡（解像度は控えめ）。断面表示で切れないので、俯瞰で壁を低く切るときは隠す */
function reflector(w: number, h: number, x: number, y: number, z: number): THREE.Object3D[] {
  const m = new Reflector(new THREE.PlaneGeometry(w, h), { textureWidth: 512, textureHeight: Math.round((512 * h) / w), color: 0xb8bcc0, clipBias: 0.003 });
  m.position.set(x, y, z);
  m.userData.hideWhenCut = true;
  return [m];
}

/** 箱の UV（面ごとに 0〜1）を mm に直す。素材のテクスチャは mm 単位の UV で実寸になる */
/** ±x の側面の UV を入れ替えて、テクスチャの縦（木目の向き）を z の方向にする（boxUVsInMm の後に呼ぶ） */
function woodSidesAlongZ(geo: THREE.BoxGeometry) {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (const face of [0, 1]) {
    for (let k = 0; k < 4; k++) {
      const i = face * 4 + k;
      const u = uv.getX(i);
      uv.setXY(i, uv.getY(i), u);
    }
  }
  uv.needsUpdate = true;
}

function boxUVsInMm(geo: THREE.BoxGeometry) {
  const { width: w, height: h, depth: d } = geo.parameters;
  // BoxGeometry の面の順番: +x, −x, +y, −y, +z, −z（各 4 頂点）
  const sizes: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  sizes.forEach(([su, sv], face) => {
    for (let k = 0; k < 4; k++) {
      const i = face * 4 + k;
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    }
  });
  uv.needsUpdate = true;
}

/**
 * 箱の側面の横方向の UV を、平面図の座標（mm）にずらす。床の UV は平面図の座標そのままなので、
 * 床材を貼った立ち上がりの縦の目地が、前の床の目地と同じ線に来る（回転 0 の箱だけ）
 */
function alignSidesToPlan(geo: THREE.BoxGeometry, cx: number, cy: number) {
  const { width: w, depth: d } = geo.parameters;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  // 面の順番: +x（u は南→北）, −x（北→南）, +y, −y, +z（西→東）, −z（東→西）。u は boxUVsInMm で 0〜幅 mm
  const shift: Record<number, (u: number) => number> = {
    0: (u) => u - (cy + d / 2),
    1: (u) => u + (cy - d / 2),
    4: (u) => u + (cx - w / 2),
    5: (u) => u - (cx + w / 2),
  };
  for (const [face, fn] of Object.entries(shift)) {
    for (let k = 0; k < 4; k++) {
      const i = Number(face) * 4 + k;
      uv.setX(i, fn(uv.getX(i)));
    }
  }
  uv.needsUpdate = true;
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
