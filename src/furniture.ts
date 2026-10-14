// 家具の形。簡単な箱の組み合わせで作る。
// ローカル座標: 中心が原点、x = 幅、z = 奥行き（+z が正面）、y = 高さ（床が 0）。単位は mm。
// 照明器具は光源も持つ。光源には userData.fixture、光る部分の材質には userData.glow を付ける。

import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { getMaterial, getMaterialDef } from './materials';
import type { Furniture } from './types';

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

/** 下向き（dir）のスポットライト。intensity はカンデラ、angle は度、distance は光が届く距離（m） */
function spot(x: number, y: number, z: number, dir: [number, number, number], intensity: number, angle: number, shadow: boolean, distance = 8): THREE.Object3D[] {
  const l = new THREE.SpotLight(WARM, intensity, distance, THREE.MathUtils.degToRad(angle / 2), 0.6, 2);
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
    build: ({ w, d, h, count }, mat) => {
      const n = Math.max(1, count ?? Math.round(h / 300));
      const pieces = Math.max(1, Math.ceil(w / 800));
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
    hint: '背面を壁に付ける。正面が便座の前。h は後ろの機能部の上端（TOTO ネオレスト NJ1/NJ2 のような丸みのある一体形）',
    defaults: { w: 400, d: 700, h: 470, color: '#f7f7f5' },
    build: ({ w, d, h }, mat) => {
      mat.roughness = 0.12;
      const seat = 370;
      // 床の足元は少し小さく、上の便器は前が丸い一体の形
      const out: THREE.Object3D[] = [
        prism(roundRect(w - 50, d - 60, 50, w * 0.4), 80, 0, mat, 0, 10),
        prism(roundRect(w, d, 60, w * 0.47), seat - 80, 80, mat, 12),
        // 後ろの機能部（便座の高さから少し上がる、角の丸い低い部分）
        prism(roundRect(w * 0.92, d * 0.34, 50, 40), h - seat, seat - 10, mat, 30, -d / 2 + d * 0.17 + 6),
        // 便座とふた（閉めた状態）
        prism(roundRect(w * 0.95, d * 0.66, 90, w * 0.45), 22, seat, mat, 0, d / 2 - d * 0.33),
        prism(roundRect(w * 0.93, d * 0.64, 90, w * 0.44), 50, seat + 22, mat, 18, d / 2 - d * 0.33 - 4),
      ];
      // 便座と便器の継ぎ目（細いグレーの線）
      out.push(prism(roundRect(w * 0.96, d * 0.67, 90, w * 0.46), 3, seat - 2, new THREE.MeshStandardMaterial({ color: '#c9cbcc', roughness: 0.5 }), 0, d / 2 - d * 0.335));
      return out;
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
    build: ({ w, d, h }, mat) => {
      const fr = 45;
      const frost = new THREE.MeshStandardMaterial({ color: '#e7ebed', roughness: 0.95, transparent: true, opacity: 0.88 });
      return [
        box(fr, h, d, -w / 2 + fr / 2, 0, 0, mat),
        box(fr, h, d, w / 2 - fr / 2, 0, 0, mat),
        box(w, fr, d, 0, h - fr, 0, mat),
        box(w, fr, d, 0, 0, 0, mat),
        box(w - fr * 2, h - fr * 2, 6, 0, fr, 0, frost),
        box(20, 300, 30, w / 2 - 90, 900, d / 2 + 15, mat), // 取手
      ];
    },
  },
  {
    type: 'kitchen-cabinet',
    label: 'キッチンの下台（引出し）',
    hint: '正面が引出し側。modules に左から幅を並べる（正の数は上下 2 段の引出し、負の数は 1 枚扉（食洗機の扉面材など）、60 未満はフィラー）。省略時は 900 ごと。取手は各段の上端のライン取手（ブラック）',
    defaults: { w: 1800, d: 650, h: 880, color: '#4c4b4a' },
    build: ({ w, d, h, modules }, mat) => {
      const plinth = 80;
      const ft = 20;
      const carcass = new THREE.MeshStandardMaterial({ color: '#1d1d1e', roughness: 0.8 });
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
        const fronts: [number, number][] = m < 0 ? [[plinth, h]] : [[plinth, split], [split, h]];
        for (const [y0, y1] of fronts) {
          out.push(box(mw - g, y1 - y0 - g, ft, xc, y0 + g / 2, z, mat));
          // ライン取手（上端の黒い溝）
          out.push(box(mw - g - 2, 12, 6, xc, y1 - g - 22, d / 2 + 1, black));
        }
      }
      return out;
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
    build: ({ w, d, h, flip }, mat) => {
      const s = flip ? -1 : 1;
      const out: THREE.Object3D[] = [box(w, h - 10, d, 0, 0, 0, mat)];
      // レバーハンドル（両面）
      for (const z of [1, -1]) out.push(box(16, 16, 40, s * (w / 2 - 70), 950, z * (d / 2 + 20), black), box(130, 14, 14, s * (w / 2 - 120), 950, z * (d / 2 + 38), black));
      return out;
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
    type: 'floor-hatch-framed',
    label: '床下点検口（アルミ枠）',
    hint: '床に置く（z は床の高さ）。アルミの枠の中に床と同じ素材の蓋（「面材」で指定）',
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
    type: 'roll-screen',
    label: 'ロールスクリーン',
    hint: '窓の上の壁（または天井）に付ける。z は生地の下端、h は生地の下端から上のケースの上までの長さ',
    defaults: { w: 1700, d: 60, h: 600, color: '#4a4b4d' },
    build: ({ w, d, h }, mat) => {
      const caseMat = new THREE.MeshStandardMaterial({ color: '#2e2f31', roughness: 0.5 });
      const cloth = new THREE.MeshStandardMaterial({ color: mat.color, roughness: 0.95, side: THREE.DoubleSide });
      return [
        box(w, 70, d, 0, h - 70, 0, caseMat),
        box(w - 30, h - 70, 2, 0, 0, d / 2 - 10, cloth),
        box(w - 30, 18, 12, 0, -9, d / 2 - 10, caseMat), // ウエイトバー
      ];
    },
  },
  {
    type: 'fridge',
    label: '冷蔵庫（5ドア）',
    hint: '背面を壁に付ける。上が右開きの冷蔵室、その下に製氷室と切替室（左右）、野菜室、冷凍室（東芝 ベジータ GR-V450GT は 幅600・奥行649・高さ1850、色はフロストグレージュ／フロストホワイト）',
    defaults: { w: 600, d: 649, h: 1850, color: '#6c6966' },
    build: ({ w, d, h }, mat) => {
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
      // 扉の高さ（下から）: 冷凍室 30〜330、野菜室 330〜640、製氷・切替室 640〜860、冷蔵室 860〜1850
      const cuts = [30, 330, 640, 860, h];
      const panel = (x: number, bw: number, y0: number, y1: number) => box(bw - g, y1 - y0 - g, fd, x, y0 + g / 2, zf, mat);
      out.push(panel(0, w, cuts[0], cuts[1]), panel(0, w, cuts[1], cuts[2]), panel(-w / 4, w / 2, cuts[2], cuts[3]), panel(w / 4, w / 2, cuts[2], cuts[3]), panel(0, w, cuts[3], cuts[4]));
      // 取手は扉の上端の内側の溝（引出し）と、冷蔵室の左端の縦の溝（右開き）
      for (const y of [cuts[1], cuts[2], cuts[3]]) out.push(box(w - 40, 6, 3, 0, y - 16, d / 2 + 1, dark));
      out.push(box(6, 500, 3, -w / 2 + 14, cuts[3] + 250, d / 2 + 1, dark));
      // 冷蔵室の扉のタッチ操作部
      out.push(box(60, 14, 2, w / 2 - 70, cuts[3] + 420, d / 2 + 1, glow('#cfe6ff', 0.3)));
      return out;
    },
  },
  {
    type: 'trash-niche-storage',
    label: '壁面収納（壁埋め込み・ゴミ箱のニッチ付き）',
    hint: '正面を壁の仕上げ面にそろえて、壁の中に埋め込む。上は扉付きの収納、カウンターの高さ（850）に四角い投入口の棚、その下は薄型のゴミ箱を置くニッチ（奥と両側は TH34190）',
    defaults: { w: 550, d: 160, h: 2050, color: '#1f1f20' },
    build: ({ w, d, h }, mat) => {
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
      // 上の収納（扉 2 枚）
      out.push(
        box(w, 20, d, 0, cab, 0, mat),
        box(20, h - cab, d, -w / 2 + 10, cab, 0, mat),
        box(20, h - cab, d, w / 2 - 10, cab, 0, mat),
        box(w, 20, d, 0, h - 20, 0, mat),
        box(w - 4, h - cab - 24, 20, 0, cab + 22, d / 2 - 10, mat),
        box(2, h - cab - 24, 2, 0, cab + 22, d / 2 + 1, black),
      );
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
    lights: ({ h }) => [...spot(0, h + 10, 20, [0, 1, 0.12], 40, 90, false), ...spot(0, -10, 20, [0, -1, 0.12], 40, 90, false)],
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
    // 面光源（RectAreaLight）は影がなく壁を通り抜けて遠くまで照らすので、届く距離の短いスポットを並べる
    // 「左右反転」にすると上向き（下がり天井の上に置いて天井を照らす）
    lights: ({ w, h, flip }) => {
      // 縦に長いもの（縦ラインの間接照明）は、高さに沿って正面へ光る
      if (h > w * 3) {
        const m = Math.max(1, Math.round(h / 420));
        return Array.from({ length: m }, (_, i) => spot(0, (h * (i + 0.5)) / m, 10, [0, 0, 1], 8, 150, false, 1.2)).flat();
      }
      const n = Math.max(1, Math.round(w / 420));
      return Array.from({ length: n }, (_, i) => spot(-w / 2 + (w * (i + 0.5)) / n, flip ? h + 10 : -10, 0, [0, flip ? 1 : -1, 0], 8, 150, false, 1.8)).flat();
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
      // 置き型。角の丸い四角い器で、中はくり抜いてある
      mat.roughness = 0.18;
      const t = 12;
      const ring = roundRect(w, d, 70);
      ring.holes.push(roundRect(w - t * 2, d - t * 2, 60));
      drain.position.set(0, 22, 0);
      return [prism(ring, h, 0, mat), prism(roundRect(w - t * 2, d - t * 2, 60), 20, 0, mat), drain];
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
        box(mainW - 4, h - fr, d, -w / 2 + fr + mainW / 2, 0, 0, mat),
      ];
      if (count !== 1) out.push(box(inner - mainW - 4, h - fr, d, w / 2 - fr - (inner - mainW) / 2, 0, 0, mat));
      // 縦長のバーハンドル（外側・内側）
      const hx = -w / 2 + fr + mainW - 90;
      for (const s of [1, -1]) out.push(box(24, 1000, 24, hx, 550, s * (d / 2 + 40), black));
      return out;
    },
  },
  {
    type: 'post-box',
    label: '宅配ボックス・ポスト（埋込）',
    hint: '外壁に埋め込む。正面を外に向け、「床からの高さ」で下端の高さを決める',
    defaults: { w: 360, d: 60, h: 600, color: '#1e1f20' },
    build: ({ w, d, h }, mat) => [
      box(w, h, d, 0, 0, 0, mat),
      box(w - 80, 12, 8, 0, h - 120, d / 2 + 2, black), // 投函口
      box(w - 40, 2, 4, 0, h * 0.42, d / 2 + 1, black), // 扉の境目
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
    lights: () => spot(0, -10, 10, [0, -1, 0.1], 30, 70, true),
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
    lights: ({ h }) => spot(0, h - 3690, 900, [0, -1, 0.05], 50, 100, true),
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
    label: '換気の吸込口（天井）',
    hint: '天井付け。「床からの高さ」を天井高に（sumika などの全館換気の排気口）',
    defaults: { w: 150, d: 150, h: 10, color: '#eeeeec' },
    build: ({ w, d }, mat) => {
      const slot = new THREE.MeshStandardMaterial({ color: '#4a4a4a', roughness: 0.8 });
      const out: THREE.Object3D[] = [box(w, 5, d, 0, -5, 0, mat)];
      for (let i = 0; i < 4; i++) out.push(box(w - 30, 1, 8, 0, -6, -d / 2 + 25 + ((d - 50) * i) / 3, slot));
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
    const surface = getMaterial(f.material);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material === mat) {
        if (o.geometry instanceof THREE.BoxGeometry) boxUVsInMm(o.geometry);
        o.material = surface;
      }
    });
  }
  g.position.set(f.x, f.z ?? 0, f.y);
  // 平面図で時計回り = 上から見て時計回り = three.js の y 軸まわりで負の回転
  g.rotation.y = -THREE.MathUtils.degToRad(f.rotation);
  g.userData.furnitureId = f.id;
  // ウォークスルーで上り下りできる物（階段）
  g.userData.walkable = ['stairs', 'stairs-box', 'winder-stairs'].includes(f.type);
  return g;
}

/**
 * 上吊りの引き戸。天井に埋め込んだレールから吊るので枠も床のレールもなく、戸の下は 12mm ほど空く。
 * 床には戸の振れ止め（ガイド）だけが付く。mirror なら正面（+z）がミラー面になる。
 */
function hungDoor({ w, d, h, flip }: Furniture, mat: THREE.MeshStandardMaterial, mirror: 'none' | 'full' | 'sheet'): THREE.Object3D[] {
  const gap = 12;
  const panelH = h - gap - 6;
  // 取手は戸の先（戸袋と反対側）。flip で反対側にする
  const s = flip ? -1 : 1;
  const out: THREE.Object3D[] = [box(w, panelH, d, 0, gap, 0, mat)];
  // 天井のレール（閉めた位置から戸袋の側へ、戸の幅の 2 倍。戸袋は取手と反対の側）
  out.push(box(w * 2, 6, 40, (-s * w) / 2, h - 6, 0, black));
  // 床のガイド（戸の後ろの端）
  out.push(box(30, gap, d + 20, -s * (w / 2 - 40), 0, 0, black));
  if (mirror === 'full') {
    // フルハイトドア fit のような全面ミラー。細い枠と、細い縦の取手
    out.push(...reflector(w - 30, panelH - 30, 0, gap + panelH / 2, d / 2 + 1));
    for (const z of [1, -1]) out.push(box(14, 1000, 14, s * (w / 2 - 45), 600, z * (d / 2 + 9), black));
  } else {
    for (const z of [1, -1]) out.push(box(20, 500, 8, s * (w / 2 - 60), 850, z * (d / 2 + 4), black));
    // 貼り付けのミラーシート（全身鏡くらい）
    if (mirror === 'sheet') out.push(...reflector(Math.min(450, w - 120), 1600, -s * 40, 350 + 800, d / 2 + 1));
  }
  return out;
}

/** 周りが映り込む鏡（解像度は控えめ）。断面表示で切れないので、俯瞰で壁を低く切るときは隠す */
function reflector(w: number, h: number, x: number, y: number, z: number): THREE.Object3D[] {
  const m = new Reflector(new THREE.PlaneGeometry(w, h), { textureWidth: 512, textureHeight: Math.round((512 * h) / w), color: 0xb8bcc0, clipBias: 0.003 });
  m.position.set(x, y, z);
  m.userData.hideWhenCut = true;
  return [m];
}

/** 箱の UV（面ごとに 0〜1）を mm に直す。素材のテクスチャは mm 単位の UV で実寸になる */
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
