// 照明の光が壁・床・天井を突き抜けないようにする（光の届く範囲＝その照明の部屋）
//
// 影を付けない照明（ダウンライト・ライン照明・部屋の跳ね返りの光）は、three.js では壁でさえぎられず、
// 隣の部屋や上下の階まで明るくしてしまう。影を全部の照明に付けると重すぎる（GPU のテクスチャの上限 16 も超える）ので、
// 照明ごとに「光が届いてよい部屋」（照明のある部屋と、戸のない開口で直接つながった隣の部屋）を決め、
// シェーダーでそれ以外の部屋の面にはその照明の光を足さない。
//
// 軽くするため、描く面ごとに「どの部屋の面か」を 1 回だけ調べ（部屋の外形の箱を順に見る）、
// 照明ごとには「その部屋に届いてよいか」の印（部屋の番号のビット）を見るだけにする。
// （照明ごとに箱を調べる作りでは、照明が 60 個あるとシェーダーの組み立てに時間がかかりすぎ、夜にするとページが固まった）
// three.js はシェーダーの中で照明を「影付き → 影なし」の順、種類ごと（点・スポット・面）に並べるので、
// 同じ並び順で照明ごとの印を uniform に入れる（update）。

import * as THREE from 'three';
import { pointInPolygon } from './geometry';
import type { Plan, Room } from './types';

const MM = 0.001;
/** 範囲を決められる照明の数の上限（超えた分は範囲なし＝今までどおり） */
const LR_MAX = 64;
/** 部屋の数の上限（全部の階の合計。ビットは 16 ずつ 4 つの数に入れる） */
const ROOM_MAX = 64;

const vec4s = (n: number) => Array.from({ length: n }, () => new THREE.Vector4());
const uniforms = {
  /** 部屋の外形の箱（m）: xmin, zmin, xmax, zmax */
  lrRoomBox: { value: vec4s(ROOM_MAX) },
  /** 部屋の高さの範囲（m）: ymin, ymax */
  lrRoomY: { value: vec4s(ROOM_MAX) },
  lrRoomCount: { value: 0 },
  /** 照明ごとの、光が届いてよい部屋の印（部屋の番号 0〜15 は x、16〜31 は y …）。全部 0 なら範囲なし */
  lrBits: { value: vec4s(LR_MAX) },
};

let installed = false;

/** シェーダーの部品を書き換える。マテリアルを作る前（最初に描く前）に 1 回だけ呼ぶ */
export function installLightRegions() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.lights_pars_begin =
    `
uniform vec4 lrRoomBox[ ${ROOM_MAX} ];
uniform vec4 lrRoomY[ ${ROOM_MAX} ];
uniform int lrRoomCount;
uniform vec4 lrBits[ ${LR_MAX} ];
int lrRoom;
float lrPow;
void lrFindRoom( vec3 p ) {
  lrRoom = -1;
  for ( int j = 0; j < ${ROOM_MAX}; j ++ ) {
    if ( j >= lrRoomCount ) break;
    vec4 b = lrRoomBox[ j ];
    vec4 y = lrRoomY[ j ];
    if ( p.x >= b.x && p.x <= b.z && p.z >= b.y && p.z <= b.w && p.y >= y.x && p.y <= y.y ) { lrRoom = j; break; }
  }
  lrPow = lrRoom >= 0 ? exp2( float( lrRoom - ( lrRoom / 16 ) * 16 ) ) : 1.0;
}
float lrBit( vec4 b ) {
  if ( b.x + b.y + b.z + b.w == 0.0 ) return 1.0;
  if ( lrRoom < 0 ) return 0.0;
  float h = lrRoom < 16 ? b.x : lrRoom < 32 ? b.y : lrRoom < 48 ? b.z : b.w;
  return mod( floor( h / lrPow ), 2.0 );
}
` + C.lights_pars_begin;
  let f = C.lights_fragment_begin;
  const rep = (a: string, b: string) => {
    if (!f.includes(a)) throw new Error(`lightRegions: シェーダーの部品が見つからない: ${a}`);
    f = f.replace(a, b);
  };
  rep('vec3 geometryPosition = - vViewPosition;', 'vec3 geometryPosition = - vViewPosition;\nlrFindRoom( transpose( mat3( viewMatrix ) ) * ( geometryPosition - viewMatrix[ 3 ].xyz ) );');
  // 照明の番号: 点の光 0〜、スポットはその後、面の光はさらに後（どれも組み立てのときに決まる数なので、番号は定数になる）
  rep(
    'getPointLightInfo( pointLight, geometryPosition, directLight );',
    `getPointLightInfo( pointLight, geometryPosition, directLight );
		#if UNROLLED_LOOP_INDEX < ${LR_MAX}
		directLight.color *= lrBit( lrBits[ UNROLLED_LOOP_INDEX ] );
		#endif`,
  );
  rep(
    'getSpotLightInfo( spotLight, geometryPosition, directLight );',
    `getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if NUM_POINT_LIGHTS + UNROLLED_LOOP_INDEX < ${LR_MAX}
		directLight.color *= lrBit( lrBits[ NUM_POINT_LIGHTS + UNROLLED_LOOP_INDEX ] );
		#endif`,
  );
  // 面の光（ライン照明）。範囲の外では計算しない
  rep(
    'RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );',
    `#if NUM_POINT_LIGHTS + NUM_SPOT_LIGHTS + UNROLLED_LOOP_INDEX < ${LR_MAX}
		if ( lrBit( lrBits[ NUM_POINT_LIGHTS + NUM_SPOT_LIGHTS + UNROLLED_LOOP_INDEX ] ) > 0.5 )
		#endif
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );`,
  );
  C.lights_fragment_begin = f;
  // すべてのマテリアルに同じ uniform（同じ入れ物）を渡す
  const proto = THREE.Material.prototype as unknown as { onBeforeCompile: (s: { uniforms: Record<string, unknown> }) => void };
  proto.onBeforeCompile = function (shader) {
    Object.assign(shader.uniforms, uniforms);
  };
}

/** 間取りから、部屋の番号と、照明ごとの「光が届いてよい部屋」の印を作る */
export class LightRegions {
  private plan: Plan | null = null;
  /** 「階|部屋 ID」→ 部屋の番号 */
  private roomIndex = new Map<string, number>();
  private bitsCache = new Map<string, THREE.Vector4>();
  /** 場面の中の照明（場面の中の順）。作り直したら dirty にする */
  private lights: THREE.Light[] = [];
  private dirty = true;
  private lastKey = '';

  setPlan(plan: Plan) {
    this.plan = plan;
    this.bitsCache.clear();
    this.roomIndex.clear();
    this.dirty = true;
    // 部屋の箱。上の階を先に並べる（天井のない部屋は上の階の高さまで箱を延ばすので、重なる所は上の階の部屋が勝つ）
    let n = 0;
    for (let fi = plan.floors.length - 1; fi >= 0; fi--) {
      const floor = plan.floors[fi];
      const elev = floor.elevation ?? 0;
      const above = plan.floors[fi + 1]?.height ?? floor.height;
      const below = plan.floors[fi - 1]?.height ?? 0;
      for (const r of floor.rooms) {
        if (n >= ROOM_MAX) break;
        const xs = r.polygon.map((p) => p[0]);
        const ys = r.polygon.map((p) => p[1]);
        const level = r.level ?? 0;
        // 天井がない部屋（吹き抜け・階段）は上の階まで、床を張らない部屋（上の階の吹き抜け）は下の階まで
        const top = r.ceiling === '' ? floor.height + above : level + (r.ceilingHeight ?? floor.ceilingHeight);
        const bottom = r.void ? -below : level;
        uniforms.lrRoomBox.value[n].set(Math.min(...xs) * MM, Math.min(...ys) * MM, Math.max(...xs) * MM, Math.max(...ys) * MM);
        uniforms.lrRoomY.value[n].set((elev + bottom - 30) * MM, (elev + top + 30) * MM, 0, 0);
        this.roomIndex.set(`${fi}|${r.id}`, n);
        n++;
      }
    }
    uniforms.lrRoomCount.value = n;
  }

  /** 照明を足した・外したとき（部屋の跳ね返りの光を作り直したときなど） */
  markDirty() {
    this.dirty = true;
  }

  /** 照明の部屋を決める（furniture の x, y は mm） */
  roomAt(floorIndex: number, x: number, y: number): string | undefined {
    const floor = this.plan?.floors[floorIndex];
    return floor?.rooms.find((r) => !r.void && pointInPolygon([x, y], r.polygon))?.id ?? floor?.rooms.find((r) => pointInPolygon([x, y], r.polygon))?.id;
  }

  /** 照明のある部屋と、戸のない開口で直接つながった隣の部屋の印 */
  bits(floorIndex: number, roomId: string): THREE.Vector4 | undefined {
    const key = `${floorIndex}|${roomId}`;
    const hit = this.bitsCache.get(key);
    if (hit) return hit;
    const floor = this.plan?.floors[floorIndex];
    const self = floor?.rooms.find((x) => x.id === roomId);
    if (!floor || !self || !this.roomIndex.has(key)) return undefined;
    const near = (r: Room, p: [number, number]) =>
      r.polygon.some((a, i) => {
        const b = r.polygon[(i + 1) % r.polygon.length];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
        return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) < 2;
      });
    const list: Room[] = [self];
    for (const o of floor.openings) {
      if (o.type !== 'opening' || o.slideRoom || o.slideTo || !near(self, o.at)) continue;
      for (const other of floor.rooms) if (!list.includes(other) && near(other, o.at)) list.push(other);
    }
    const v = [0, 0, 0, 0];
    for (const r of list) {
      const i = this.roomIndex.get(`${floorIndex}|${r.id}`);
      if (i === undefined) continue;
      v[i >> 4] += 2 ** (i & 15);
    }
    const out = new THREE.Vector4(v[0], v[1], v[2], v[3]);
    this.bitsCache.set(key, out);
    return out;
  }

  /**
   * 描く直前に呼ぶ。three.js がシェーダーに照明を並べるのと同じ順（場面の中の順・影付きが先・種類ごと）で、照明ごとの印を入れる。
   * 照明の userData.lrFloor（階の番号）・userData.lrRoom（部屋 ID）を使う。ないものは範囲なし
   */
  update(scene: THREE.Scene) {
    if (this.dirty) {
      this.lights = [];
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight) this.lights.push(o as THREE.Light);
      });
      this.dirty = false;
      this.lastKey = '';
    }
    const shown = (o: THREE.Object3D | null) => {
      for (; o; o = o.parent) if (!o.visible) return false;
      return true;
    };
    const lights = this.lights.filter((l) => shown(l));
    const rank = (l: THREE.Light) => (l.castShadow ? 2 : 0) + ((l as THREE.SpotLight).map ? 1 : 0);
    lights.sort((a, b) => rank(b) - rank(a));
    const all = [
      ...lights.filter((l) => (l as THREE.PointLight).isPointLight),
      ...lights.filter((l) => (l as THREE.SpotLight).isSpotLight),
      ...lights.filter((l) => (l as THREE.RectAreaLight).isRectAreaLight),
    ];
    // 並びが前のフレームと同じなら入れ直さない
    const key = all.map((l) => l.id).join(',');
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (let k = 0; k < LR_MAX; k++) {
      const l = all[k];
      const b = l && l.userData.lrRoom !== undefined ? this.bits(l.userData.lrFloor as number, l.userData.lrRoom as string) : undefined;
      uniforms.lrBits.value[k].set(b?.x ?? 0, b?.y ?? 0, b?.z ?? 0, b?.w ?? 0);
    }
  }
}
