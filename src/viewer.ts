// 3D 表示。カメラ（俯瞰／ウォークスルー）、照明、家具のドラッグ操作を受け持つ。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { openingsOnSegment, pointInPolygon, signedArea } from './geometry';
import { buildPlan, type BuiltPlan, type SurfaceInfo } from './builder';
import type { Circuit, Plan } from './types';
import { WEB } from './env';
import { installLightRegions, LightRegions } from './lightRegions';
import { CLICK_LIGHT_TYPES, LOOSE_FURNITURE_TYPES } from './furniture';
import { Collision } from './collision';

// 照明の光が壁・床を突き抜けないよう、シェーダーを書き換える（マテリアルを描く前に）
if (!WEB) installLightRegions();

export type ViewMode = 'orbit' | 'walk';

/** 部屋の中の照明器具の光の強さ（器具の値に掛ける）と、部屋の跳ね返りの光に掛ける値。夜に照明をつけた LDK が昼より少し暗いくらいになるように合わせた */
const FIXTURE_SPOT = 0.05;
const FIXTURE_AREA = 0.1;
const FIXTURE_POINT = 0.07;
const BOUNCE = 0.07;

/** 開口部をふさぐ扉の家具の種類（窓の光を隣の部屋へ分けるかどうかの判定に使う） */
const DOOR_TYPES = new Set(['swing-door', 'sliding-door', 'mirror-sliding-door', 'mirror-sheet-door', 'framed-glass-door', 'entry-door', 'bifold-door']);

/** 窓の光の強さ（窓の面積が床の面積の 20% の部屋で 1 のとき。decay 1 なので、窓から 3m で 0.8 くらい = 前の家じゅう一律の空の光） */
const DAYLIGHT = 5.2;

/**
 * 部屋ごとの、窓から入る昼の光。量は 窓の面積 ÷ 床の面積 を 0.2 で割った値（上限 1。窓の光はひと続きの空間に広がるので、窓のある小さな部屋だけ白く飛ばないように。2026-10-25 に 1.5 から下げた）。
 * 光を置く所は窓の少し外（窓が複数あれば面積で重み付けした平均・高さは窓の真ん中）で、窓から部屋の奥へ差し込む向きになる。
 * 窓のない部屋は、戸のない開口（type: opening）でつながった隣の部屋の 35% をもらい、光はその開口の所に置く
 */
function roomDaylight(plan: Plan): Map<string, { day: number; at: [number, number, number] | null }> {
  const out = new Map<string, { day: number; at: [number, number, number] | null }>();
  const t = plan.wallThickness;
  for (const floor of plan.floors) {
    const own = new Map<string, { day: number; at: [number, number, number] | null }>();
    const links = new Map<string, { id: string; at: [number, number, number] }[]>();
    for (const room of floor.rooms) {
      const area = Math.abs(signedArea(room.polygon)) / 1e6;
      let win = 0;
      const sum = [0, 0, 0];
      const n = room.polygon.length;
      for (let i = 0; i < n; i++) {
        const a = room.polygon[i];
        const b = room.polygon[(i + 1) % n];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1) continue;
        // 辺の法線（部屋の外向きを、少し外の点が部屋に入るかで決める）
        let nx = -(b[1] - a[1]) / len;
        let ny = (b[0] - a[0]) / len;
        const mx = (a[0] + b[0]) / 2;
        const my = (a[1] + b[1]) / 2;
        if (pointInPolygon([mx + nx * 200, my + ny * 200], room.polygon)) {
          nx = -nx;
          ny = -ny;
        }
        for (const s of openingsOnSegment(floor.openings, a, b, t / 2 + 1)) {
          const o = s.opening;
          const lvl = room.level ?? 0;
          if (o.type === 'window') {
            const wa = ((s.u1 - s.u0) * o.height) / 1e6;
            win += wa;
            sum[0] += (o.at[0] + nx * 600) * wa;
            sum[1] += (o.at[1] + ny * 600) * wa;
            sum[2] += (o.sill + o.height / 2 - lvl) * wa;
          }
          // 戸のない開口だけ（引込み戸の開口・扉のある開口は、戸を閉めると光が入らないので除く）
          const hasDoor = o.slideRoom || o.slideTo || floor.furniture.some((f) => DOOR_TYPES.has(f.type) && Math.hypot(f.x - o.at[0], f.y - o.at[1]) < o.width);
          if (o.type === 'opening' && !hasDoor) {
            const other = floor.rooms.find((r) => r !== room && pointInPolygon([o.at[0] + nx * (t / 2 + 50), o.at[1] + ny * (t / 2 + 50)], r.polygon));
            if (other) links.set(room.id, [...(links.get(room.id) ?? []), { id: other.id, at: [o.at[0] + nx * 300, o.at[1] + ny * 300, Math.min(o.height, 2400) / 2] }]);
          }
        }
      }
      own.set(room.id, { day: area > 0 ? Math.min(1, win / area / 0.2) : 0, at: win > 0 ? [sum[0] / win, sum[1] / win, sum[2] / win] : null });
    }
    for (const room of floor.rooms) {
      const mine = own.get(room.id)!;
      let best = mine;
      for (const l of links.get(room.id) ?? []) {
        const d = (own.get(l.id)?.day ?? 0) * 0.35;
        if (d > best.day) best = { day: d, at: l.at };
      }
      out.set(room.id, best);
    }
  }
  return out;
}
export type TimeOfDay = 'day' | 'evening' | 'night';

/** ウォークスルーで画面の中央に見えている物 */
export type WalkTarget = SurfaceInfo | { kind: 'furniture'; furnitureId: string };

export interface WalkInfo {
  /** 今立っている部屋 */
  roomId: string | null;
  target: WalkTarget | null;
}

/** 扉・引出しを、開き具合 d.t（0〜1）の位置・向きにする */
function poseDoor(o: THREE.Object3D, d: DoorState) {
  const e = d.t * d.t * (3 - 2 * d.t);
  if (d.type === 'roll') o.scale.y = (d.roll ?? 0.02) + (1 - (d.roll ?? 0.02)) * e;
  else if (d.type === 'slide' && d.dy !== undefined) o.position.y = (d.y0 ?? 0) + d.dy * e;
  else if (d.type === 'slide' && d.dz !== undefined) o.position.z = (d.z0 ?? 0) + d.dz * e;
  else if (d.type === 'slide') o.position.x = (d.x0 ?? 0) + (d.dx ?? 0) * e;
  else if (d.type === 'flap') o.rotation.x = (d.angle ?? 0) * e;
  else o.rotation.y = (d.angle ?? 0) * e;
  if (d.type === 'fold') for (const c of o.children) if (c.userData.foldInner) c.rotation.y = -2 * (d.angle ?? 0) * e;
}

/** 開け閉めできる扉の状態（家具の部品の userData.door） */
interface DoorState {
  /** fold = 折れ戸（吊元の側の板が angle、先の板（userData.foldInner の子）が逆へ 2 倍回って、先の端がレールの上を滑る） */
  /** flap = 上の辺を軸に跳ね上げる板（rotation.x） */
  type: 'slide' | 'swing' | 'fold' | 'roll' | 'flap';
  /** 0 = 閉、1 = 開 */
  t: number;
  open?: boolean;
  dx?: number;
  x0?: number;
  /** 引出し: 前（家具の正面の向き）へ出す長さ */
  dz?: number;
  z0?: number;
  /** 上下に動く物（ロールスクリーンの下のバー）: 下へ動く長さ */
  dy?: number;
  y0?: number;
  /** roll = ロールスクリーンの生地。巻き上げたときの縦の倍率（開 = 下ろした状態で 1） */
  roll?: number;
  angle?: number;
  /** クリックした扉・引出しだけを動かす（冷蔵庫・キッチンの引出しなど）。なければ家具の扉をまとめて動かす */
  part?: boolean;
}

export interface ViewerEvents {
  /** 家具をクリックした（null は何もない所） */
  onSelectFurniture: (id: string | null) => void;
  onSelectRoom: (id: string) => void;
  /** ウォークスルーで立っている部屋・見ている物が変わった（俯瞰に戻ると null） */
  onWalkInfo: (info: WalkInfo | null) => void;
  /** ウォークスルーで壁・天井などをクリックした（クロスを試すため） */
  onPickSurface: (target: WalkTarget | null) => void;
  /** ウォークスルーでスイッチを押した（button は上から何番目か） */
  onPressSwitch?: (switchId: string, button: number) => void;
}

const MM = 0.001;
/** 人感センサーが人を見つける範囲（器具の真下からの距離 m）と、離れてから消えるまでの秒数（実物は設定で 30 秒〜数分） */
const SENSOR_RANGE = 2.5;
const SENSOR_HOLD = 10;
/** 身長から目の高さ（m）を出す。目は頭のてっぺんより 11cm ほど下 */
export const eyeHeightFor = (statureCm: number) => Math.max(0.5, (statureCm - 11) / 100);

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private orbit: OrbitControls;
  private world = new THREE.Group();
  private built: BuiltPlan | null = null;
  private clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.2);
  private hemi = new THREE.HemisphereLight('#dfe9f5', '#8a7f6e', 1.2);
  /** Web 版: 部屋ごとの光の代わりに、家全体を少し明るくする光 */
  private webFill = new THREE.AmbientLight('#fff1e2', 0);
  /**
   * 照明の数が変わると、すべての素材の陰影の計算（シェーダー）を作り直す。そのまま描くと作り終わるまで画面が固まる
   * （夜に切り替えると 10 秒以上「ページは応答していません」になった）ので、裏で少しずつ組み立て（compileAsync）、
   * 終わるまでは前の画面のまま描かない
   */
  private compiling = false;
  private lightKey = '';
  private compileNote = document.createElement('div');
  /** Web 版: 止まっている間は描かないため、最後に触った時刻と前のカメラ */
  private lastActive = 0;
  private lastCam = '';
  /** クロスの色の確認用に、照明を無視して全体を白い光で明るくする光 */
  private colorCheckLight = new THREE.AmbientLight('#ffffff', 0);
  private sun = new THREE.DirectionalLight('#ffffff', 2.5);
  private roomLights = new THREE.Group();
  private selection = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color('#ff7a1a'));
  private selectedId: string | null = null;
  private raycaster = new THREE.Raycaster();
  private mode: ViewMode = 'orbit';
  private time: TimeOfDay = 'day';
  private cutaway = true;
  private showLabels = true;
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private timer = new THREE.Timer();
  private ground: THREE.Mesh;
  /** 俯瞰で表示する一番上の階（'all' なら外観として全部の階を見せる） */
  private floorView: number | 'all' = 'all';
  /** ウォークスルー中の階と目の高さ（m） */
  private walkFloor = 0;
  /** 照明の回路。回路ごとのつけ消し（未設定なら「夕方・夜・昼も照明をつける」に従う） */
  private circuits: Circuit[] = [];
  private circuitState = new Map<string, boolean>();
  private lightCircuit = new Map<string, string>();
  /** 人感センサー付きの照明と、あと何秒ついているか（ウォークスルーで近づくとつき、離れて SENSOR_HOLD 秒で消える） */
  private sensors = new Map<string, THREE.Vector3>();
  private sensorTimer = new Map<string, number>();
  /** 家具がどの階にあるか（ウォークスルーでは今いる階の照明だけを計算して軽くする） */
  private furnitureFloor = new Map<string, number>();
  /** 照明ごとの光が届いてよい範囲（部屋） */
  private lightRegions = new LightRegions();
  /** 最後に作った間取り（描画が止まって戻ったときに作り直す） */
  private lastPlan: Plan | null = null;
  /** 開け閉めしている途中の扉 */
  private movingDoors = new Set<THREE.Object3D>();
  /** 床からの目の高さ（m）。身長で変える */
  private eyeHeight = eyeHeightFor(160);
  private eyeY = this.eyeHeight;
  /** 照明器具を点けるか（夕方・夜は自動で点ける） */
  private lightsOn = false;
  /** ウォークスルーで影の濃淡（アンビエントオクルージョン）を付けるか */
  private highQuality = true;
  /** ウォークスルーで見回すドラッグの向きを逆にする */
  private invertLook = false;
  private walkInfoKey = '';
  /** 足元の高さを調べる相手（見えている床と階段） */
  private walkTargets: THREE.Object3D[] = [];
  private walkInfoTimer = 0;
  private composer: EffectComposer;
  private gtao: GTAOPass;

  constructor(
    private container: HTMLElement,
    private events: ViewerEvents,
  ) {
    // Web 版（iPad・スマホ）は描画のメモリを減らす（足りなくなると描画が止まって画面が真っ暗になる）
    this.renderer = new THREE.WebGLRenderer({ antialias: !WEB, preserveDrawingBuffer: !WEB });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, WEB ? 1 : 2));
    // 描画のメモリが足りなくなって描画が止まったら（画面が真っ暗になる）、戻ったときに 3D を作り直す
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      // 周りの照り返し（環境光）も描画先に作り直す
      this.makeEnvironment();
      if (this.lastPlan) this.setPlan(this.lastPlan);
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);
    this.compileNote.textContent = '照明を準備中…';
    this.compileNote.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);background:#141414b8;color:#fff;padding:6px 12px;border-radius:8px;font-size:13px;pointer-events:none;display:none;z-index:4';
    container.appendChild(this.compileNote);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    this.camera.position.set(12, 14, 18);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.05;

    // 周りの景色の映り込み・環境光（室内向けの柔らかい環境）
    this.makeEnvironment();

    // ウォークスルー用の高画質描画（壁際や家具の下の陰影）
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 2, thickness: 1, scale: 1.2, samples: 8 });
    this.gtao.updatePdMaterial({ samples: 8, rings: 2, radius: 4 });
    this.gtao.blendIntensity = 1;
    // 陰影は画面の半分の解像度で計算する（画面と同じ解像度・サンプル 16 では、2 階 LDK で 1 回の描画に約 250ms かかって重かった。2026-10-24）
    const aoFullSize = this.gtao.setSize.bind(this.gtao);
    this.gtao.setSize = (w: number, h: number) => aoFullSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    // 陰影（AO）の計算では、クリックを受けるだけの見えない板（opacity 0）も隠す。
    // 隠さないと、ロールスクリーンを巻き上げても見えない板の足元の床が暗い帯になる
    const ao = this.gtao as unknown as { _overrideVisibility: () => void; _visibilityCache: THREE.Object3D[] };
    const hideLinesOnly = ao._overrideVisibility.bind(ao);
    ao._overrideVisibility = () => {
      hideLinesOnly();
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if ((o as THREE.Mesh).isMesh && o.visible && m && !Array.isArray(m) && m.transparent && m.opacity === 0) {
          o.visible = false;
          ao._visibilityCache.push(o);
        }
      });
    };
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());

    this.world.scale.setScalar(MM);
    this.scene.add(this.world);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: '#a9b59a', roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.005;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(WEB ? 2048 : 4096, WEB ? 2048 : 4096);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.roomLights, this.selection);
    if (WEB) {
      this.webFill.intensity = 0.9;
      this.scene.add(this.webFill);
    }
    // 止まっている間は描き直さない（PC 版も。2026-10-24 クロスを選ぶパネルのスクロールまで重かった）。
    // 3D を触っている間・キーを押した・パネルをクリックした後 2 秒は描き続ける（パネルのスクロールでは描かない）
    const poke = () => (this.lastActive = performance.now());
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'wheel']) this.renderer.domElement.addEventListener(ev, poke, { passive: true });
    for (const ev of ['keydown', 'keyup', 'resize', 'click', 'change']) window.addEventListener(ev, poke, { passive: true });
    this.selection.visible = false;

    this.setupPointer();
    this.setupKeys();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.applyTime();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------- 間取りの反映 ----------

  /** 今の 3D（クロス表などで面を測るのに使う） */
  getBuilt(): BuiltPlan | null {
    return this.built;
  }

  setPlan(plan: Plan): string[] {
    this.lastPlan = plan;
    const first = !this.built;
    // 扉・引出し・ロールスクリーンの開け閉めを覚えておき、作り直したあとも同じにする（クロスを張り替えるたびに扉が閉まっていた。2026-10-25）
    const opened = new Map<string, boolean[]>();
    for (const [id, g] of this.built?.furniture ?? []) {
      const list: boolean[] = [];
      g.traverse((o) => {
        const d = o.userData.door as DoorState | undefined;
        if (d) list.push(!!d.open);
      });
      if (list.length) opened.set(id, list);
    }
    this.movingDoors.clear();
    if (this.built) {
      this.world.remove(this.built.root);
      disposeTree(this.built.root);
    }
    this.built = buildPlan(plan, [this.clipPlane]);
    // Web 版（スマホ・iPad）は軽くするため、スイッチの回路と人感センサーは使わない（照明は時間帯の通り）
    this.circuits = WEB ? [] : (plan.circuits ?? []);
    this.lightCircuit.clear();
    for (const c of this.circuits) for (const l of c.lights) this.lightCircuit.set(l, c.id);
    this.furnitureFloor.clear();
    plan.floors.forEach((f, i) => f.furniture.forEach((x) => this.furnitureFloor.set(x.id, i)));
    this.sensors.clear();
    for (const f of plan.floors)
      for (const x of f.furniture) if (x.sensor && !WEB) this.sensors.set(x.id, new THREE.Vector3(x.x * MM, (f.elevation + (x.z ?? 0)) * MM, x.y * MM));
    this.world.add(this.built.root);
    this.looseIds = new Set(plan.floors.flatMap((f) => f.furniture.filter((x) => x.loose || LOOSE_FURNITURE_TYPES.has(x.type)).map((x) => x.id)));
    this.clickLights = new Set(plan.floors.flatMap((f) => f.furniture.filter((x) => CLICK_LIGHT_TYPES.has(x.type)).map((x) => x.id)));
    this.applyFurnitureVisible();
    // 照明器具の光は、器具のある部屋（と戸のない開口でつながった部屋）の中だけに届く
    this.lightRegions.setPlan(plan);
    plan.floors.forEach((f, i) =>
      f.furniture.forEach((x) => {
        const g = this.built!.furniture.get(x.id);
        if (!g) return;
        const room = this.lightRegions.roomAt(i, x.x, x.y);
        g.traverse((o) => {
          if (!(o as THREE.Light).isLight) return;
          o.userData.lrFloor = i;
          o.userData.lrRoom = room;
        });
      }),
    );
    this.walkTargets = [...this.built.floors.flatMap((f) => f.floorMeshes.filter((m) => m.visible)), ...[...this.built.furniture.values()].filter((g) => g.userData.walkable)];
    this.ground.position.y = (plan.groundLevel ?? 0) * MM - 0.005;
    if (typeof this.floorView === 'number') this.floorView = Math.min(this.floorView, plan.floors.length - 1);
    // 照明の位置計算などで使うので、追加した直後にワールド座標を確定させる
    this.world.updateMatrixWorld(true);
    for (const [id, list] of opened) {
      let k = 0;
      this.built.furniture.get(id)?.traverse((o) => {
        const d = o.userData.door as DoorState | undefined;
        if (!d || k >= list.length) return;
        d.open = list[k++];
        d.t = d.open ? 1 : 0;
        poseDoor(o, d);
      });
    }
    this.collision.setPlan(plan, this.built.furniture, this.looseIds);
    // 作り直したあと（画像の素材の読み込みも待って）しばらくは描き続ける
    this.lastActive = performance.now() + 3000;
    this.applyVisibility();
    this.rebuildRoomLights(plan);
    this.fitSun();
    if (first) this.frameAll();
    this.select(this.selectedId);
    return this.built.warnings;
  }

  /** 部屋ごとの照明。小さな部屋や吹き抜けには付けない（照明が多いと重くなる） */
  private rebuildRoomLights(plan: Plan) {
    this.roomLights.clear();
    this.lightRegions.markDirty();
    const daylight = roomDaylight(plan);
    this.built!.floors.forEach((floor, index) => {
      // 照明器具を置いた部屋は、その器具だけで照らす
      const fixtures = plan.floors[index].furniture.filter((f) => this.built!.furniture.get(f.id)?.getObjectByProperty('isLight', true));
      // Web 版は部屋ごとの光を作らず、家全体の 1 つの明るさ（webFill）で代わりにする
      if (WEB) return;
      for (const mesh of floor.floorMeshes) {
        const box = new THREE.Box3().setFromObject(mesh);
        const size = box.getSize(new THREE.Vector3());
        if (size.x * size.z < 2 || !mesh.visible) continue;
        const room = plan.floors[index].rooms.find((r) => r.id === mesh.userData.roomId);
        // 器具を置いた部屋も、床や壁で跳ね返った光（部屋全体をうっすら明るくする分）を足す。器具の数に応じて強くする
        // 跳ね返りの強さは、部屋の器具の光束の合計（lm）に比べる（60W 相当 700lm 1 台で 5）
        const inRoom = room ? fixtures.filter((f) => pointInPolygon([f.x, f.y], room.polygon)) : [];
        const lm = inRoom.reduce((sum, f) => sum + (f.lumen ?? 700), 0);
        const c = box.getCenter(new THREE.Vector3());
        const light = new THREE.PointLight(this.effTime === 'day' ? '#fff4ea' : '#ffd6a0', inRoom.length ? Math.min(30, (lm / 700) * 5) : 30, 6, 2);
        light.userData.base = light.intensity;
        light.userData.fixtures = inRoom.map((f) => ({ id: f.id, lm: f.lumen ?? 700 }));
        // 跳ね返りの光は部屋の真ん中の高さ（床から 1.3m）から。天井の近くに置くと天井だけが白く飛ぶ
        const fy = inRoom.length ? box.max.y + 1.3 : floor.group.position.y * MM + mesh.userData.lightHeight * MM;
        light.position.set(c.x, fy, c.z);
        light.userData.floorIndex = index;
        light.userData.lrFloor = index;
        light.userData.lrRoom = room?.id;
        // 窓から入る昼の光の量（0〜1.5。窓のない部屋は 0 か、戸のない開口でつながった隣の部屋から少し）
        const dl = room ? daylight.get(room.id) : undefined;
        light.userData.day = dl?.day ?? 0;
        // 昼は窓の所（窓の光）、照明だけのときは部屋の真ん中（跳ね返りの光）に置く
        light.userData.nightPos = light.position.clone();
        light.userData.dayPos = dl?.at ? new THREE.Vector3(dl.at[0] * MM, floor.group.position.y * MM + ((room?.level ?? 0) + dl.at[2]) * MM, dl.at[1] * MM) : light.position.clone();
        this.roomLights.add(light);
      }
    });
    this.applyTime();
    this.applyVisibility();
  }


  private fitSun() {
    const b = this.worldBounds();
    const c = b.getCenter(new THREE.Vector3());
    const r = b.getSize(new THREE.Vector3()).length() / 2 + 2;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = 0.5;
    cam.far = r * 4;
    cam.updateProjectionMatrix();
    this.sun.target.position.copy(c);
    this.updateSunPosition();
  }

  private updateSunPosition() {
    const c = this.sun.target.position;
    const r = this.sun.shadow.camera.right;
    // 南（+Z）寄りから差し込む。夕方は西（−X）から低く
    const dir = this.effTime === 'evening' ? new THREE.Vector3(-1, 0.35, 0.5) : new THREE.Vector3(-0.4, 1.1, 1);
    this.sun.position.copy(c).addScaledVector(dir.normalize(), r * 2);
  }

  private worldBounds(): THREE.Box3 {
    const b = this.built?.bounds.clone() ?? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(10000, 2400, 10000));
    b.min.multiplyScalar(MM);
    b.max.multiplyScalar(MM);
    return b;
  }

  frameAll() {
    const b = this.worldBounds();
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3()).length();
    this.orbit.target.copy(c).setY(this.focusHeight());
    this.camera.position.copy(this.orbit.target).add(new THREE.Vector3(size * 0.4, size * 0.85, size * 0.85));
    this.orbit.update();
  }

  /** 俯瞰で注目する高さ（m）。階を選んでいればその階の床、外観なら建物の中ほど */
  private focusHeight(): number {
    const floors = this.built?.floors ?? [];
    if (this.floorView === 'all') return this.worldBounds().getCenter(new THREE.Vector3()).y * 0.6;
    return (floors[this.floorView]?.group.position.y ?? 0) * MM;
  }

  // ---------- 表示設定 ----------

  /** startAt の y は目の高さ（m） */
  setMode(mode: ViewMode, startAt?: THREE.Vector3, yaw = 0) {
    this.mode = mode;
    this.orbit.enabled = mode === 'orbit';
    if (mode === 'walk') {
      const p = startAt ?? this.worldBounds().getCenter(new THREE.Vector3()).setY(this.eyeHeight);
      this.eyeY = p.y;
      this.camera.position.copy(p);
      this.yaw = yaw; // 0 = 北（−Z）を向く、π = 南を向く
      this.pitch = 0;
      this.camera.fov = 70;
      this.selection.visible = false;
    } else {
      this.camera.fov = 50;
      this.frameAll();
      this.walkInfoKey = '';
      this.events.onWalkInfo(null);
      this.select(this.selectedId);
    }
    this.camera.updateProjectionMatrix();
    this.applyVisibility();
    // 時間帯と照明はウォークスルーのときだけ（俯瞰はいつも昼・照明なしで軽くする）。色の確認の明るさも
    this.applyTime();
    this.setColorCheck(this.colorCheckOn);
  }

  /** 実際に使う時間帯。俯瞰はいつも昼 */
  private get effTime(): TimeOfDay {
    return this.mode === 'walk' ? this.time : 'day';
  }

  getMode() {
    return this.mode;
  }

  setTime(time: TimeOfDay) {
    this.time = time;
    this.applyTime();
  }

  setCutaway(on: boolean) {
    this.cutaway = on;
    this.applyVisibility();
  }

  setLightsOn(on: boolean) {
    this.lightsOn = on;
    this.applyTime();
  }

  setHighQuality(on: boolean) {
    this.highQuality = on;
  }

  /** 色の確認: 照明や時間帯に関係なく、白い光で全体を均一に明るくする（クロスの色味を見る用・一時的） */
  setColorCheck(on: boolean) {
    this.colorCheckOn = on;
    if (!this.colorCheckLight.parent) this.scene.add(this.colorCheckLight);
    // ウォークスルーのときだけ効かせる
    this.colorCheckLight.intensity = on && this.mode === 'walk' ? 2.2 : 0;
  }
  private colorCheckOn = false;

  /** 身長（cm）から目の高さを変える。ウォークスルー中なら今の床からの高さをそのまま変える */
  setStature(cm: number) {
    const floorY = this.eyeY - this.eyeHeight;
    this.eyeHeight = eyeHeightFor(cm);
    this.eyeY = floorY + this.eyeHeight;
  }

  setInvertLook(on: boolean) {
    this.invertLook = on;
  }

  setLabels(on: boolean) {
    this.showLabels = on;
    this.applyVisibility();
  }

  /** 置き家具（ソファ・ベッド・テーブル・いすなど）を出す・消す。造作・照明・スイッチなどは消さない */
  setFurnitureVisible(on: boolean) {
    this.showFurniture = on;
    this.applyFurnitureVisible();
  }
  private showFurniture = true;
  private looseIds = new Set<string>();
  /** クリックで照明をつけ消しする家具（レンジフード）と、今ついているもの */
  private clickLights = new Set<string>();
  private clickOn = new Set<string>();
  /** ウォークスルーで壁・閉まったドア・造作の家具をすり抜けない（オフにすると今までどおりすり抜ける） */
  private collision = new Collision();
  private collideOn = true;
  setCollision(on: boolean) {
    this.collideOn = on;
  }
  private applyFurnitureVisible() {
    if (!this.built) return;
    for (const id of this.looseIds) {
      const g = this.built.furniture.get(id);
      if (g) g.visible = this.showFurniture;
    }
    // 造作の収納の中に置いた物（ティッシュ・ゴミ箱・洗濯かご）
    for (const g of this.built.furniture.values()) g.traverse((o) => {
      if (o.userData.looseItem) o.visible = this.showFurniture;
    });
    this.lastActive = performance.now();
  }

  /** 俯瞰で見る階。その階より上は隠し、その階の壁を低く切って中を見せる */
  setFloorView(view: number | 'all') {
    // 視点の角度と距離はそのままで、見る高さだけ選んだ階に合わせる
    const before = this.focusHeight();
    this.floorView = view;
    const dy = this.focusHeight() - before;
    this.orbit.target.y += dy;
    this.camera.position.y += dy;
    this.applyVisibility();
    this.select(this.selectedId);
  }

  private applyVisibility() {
    if (!this.built) return;
    const walk = this.mode === 'walk';
    const floors = this.built.floors;
    const exterior = !walk && this.floorView === 'all';
    const top = walk || this.floorView === 'all' ? floors.length - 1 : this.floorView;
    floors.forEach((f, i) => {
      const isTop = i === top;
      f.group.visible = i <= top;
      for (const c of f.ceilings) c.visible = walk;
      for (const c of f.caps) c.visible = walk || exterior || !isTop;
      for (const l of f.labels) l.visible = this.showLabels && !walk && !exterior && isTop;
    });
    // 壁の材質は clipPlane を共有しているので、高さを変えるだけで断面表示を切り替えられる
    const cut = !walk && !exterior && this.cutaway;
    const elevation = floors[top]?.group.position.y ?? 0;
    this.clipPlane.constant = cut ? elevation * MM + 1.2 : 1000;
    this.built.root.traverse((o) => {
      if (o.userData.hideWhenCut) o.visible = !cut;
    });
    this.applyLights();
    if (!walk) for (const l of this.roomLights.children) if (l.visible) l.visible = (l.userData.floorIndex as number) <= top;
  }

  /** 部屋の中の照り返し（環境光）。描画が止まって戻ったときも作り直す */
  private makeEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment?.dispose();
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }

  /** 夕方・夜、または「昼も照明をつける」のとき */
  private get lit() {
    return this.mode === 'walk' && (this.lightsOn || this.time !== 'day');
  }

  /** 回路がついているか */
  circuitOn(id: string): boolean {
    return this.circuitState.get(id) ?? this.lit;
  }

  /** 照明（家具の id）がついているか。回路のない照明は時間帯に従う。人感センサー付きは、ウォークスルーでは人（自分）が近くにいる間だけ */
  private lightOn(id: string): boolean {
    // 俯瞰では照明をつけない（照明はウォークスルーだけ）
    if (this.mode !== 'walk') return false;
    // クリックでつけ消しする照明（レンジフード）は、クリックしたときだけ
    if (this.clickLights.has(id)) return this.clickOn.has(id);
    const c = this.lightCircuit.get(id);
    const on = c ? this.circuitOn(c) : this.lit;
    if (on && this.mode === 'walk' && this.sensors.has(id)) return (this.sensorTimer.get(id) ?? 0) > 0;
    return on;
  }

  /** 人感センサーの見張り。近く（床の上で半径 SENSOR_RANGE）にいればつけ、離れて SENSOR_HOLD 秒で消す */
  private updateSensors(dt: number) {
    if (!this.sensors.size) return;
    const p = this.camera.position;
    const feet = p.y - this.eyeHeight;
    let changed = false;
    for (const [id, s] of this.sensors) {
      const before = (this.sensorTimer.get(id) ?? 0) > 0;
      const near = Math.hypot(p.x - s.x, p.z - s.z) < SENSOR_RANGE && feet > s.y - 3.2 && feet < s.y + 0.3;
      const t = near ? SENSOR_HOLD : Math.max(0, (this.sensorTimer.get(id) ?? 0) - dt);
      this.sensorTimer.set(id, t);
      if (before !== t > 0) changed = true;
    }
    if (changed) this.applyLights();
  }

  /** 回路をつけ消しする。つけたら true */
  toggleCircuit(id: string): boolean {
    const on = !this.circuitOn(id);
    this.circuitState.set(id, on);
    this.applyLights();
    return on;
  }

  /** 照明器具の光と光る部分、部屋の跳ね返りの光を、回路・時間帯・今いる階に合わせる */
  private applyLights() {
    if (!this.built) return;
    this.lastActive = performance.now();
    const walk = this.mode === 'walk';
    for (const [id, g] of this.built.furniture) {
      const on = this.lightOn(id);
      // ウォークスルーでは今いる階の照明だけを計算する（光源が多いと重い。前は上下の階も入れていた）
      const near = !walk || (this.furnitureFloor.get(id) ?? 0) === this.walkFloor;
      g.traverse((o) => {
        if (o.userData.fixture) o.visible = on && near;
        // 部屋の中の照明器具の光は、器具の値の一部だけにする（そのままだと夜に照明をつけると画面の 4 分の 1 が白く飛んだ。2026-10-25）
        const light = o as THREE.Light;
        if (light.isLight && o.userData.lrRoom !== undefined) {
          if (o.userData.full === undefined) o.userData.full = light.intensity;
          light.intensity = (o.userData.full as number) * ((light as THREE.SpotLight).isSpotLight ? FIXTURE_SPOT : (light as THREE.RectAreaLight).isRectAreaLight ? FIXTURE_AREA : FIXTURE_POINT);
        }
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m?.userData?.glow !== undefined) m.emissiveIntensity = on ? m.userData.glow : 0;
      });
    }
    // 跳ね返りの光（2026-10-22 に夜を半分に弱めた。前は 1 で、照明をつけると実物より明るすぎた）
    const scale = (this.effTime === 'night' ? 0.5 : 1 / 3) * BOUNCE;
    this.roomLights.visible = true;
    for (const l of this.roomLights.children as THREE.PointLight[]) {
      const fx = (l.userData.fixtures as { id: string; lm: number }[] | undefined) ?? [];
      const total = fx.reduce((s, f) => s + f.lm, 0);
      const onLm = fx.filter((f) => this.lightOn(f.id)).reduce((s, f) => s + f.lm, 0);
      // 照明器具のない部屋（車庫など）は、ウォークスルーでは跳ね返りの光を足さない（部屋の真ん中の天井が光の玉のように光っていた。2026-10-25）
      const frac = fx.length ? onLm / total : this.lit && !walk ? 1 : 0;
      // 昼・夕方は窓から入る光（ウォークスルーのときだけ。俯瞰は家全体を均一に明るく見せる）
      const sky = walk ? (this.effTime === 'day' ? DAYLIGHT : this.effTime === 'evening' ? DAYLIGHT * 0.35 : 0) * ((l.userData.day as number) ?? 0) : 0;
      const art = ((l.userData.base as number) ?? 30) * scale * frac;
      if (sky > 0) {
        // 窓の光は窓の少し外に置き、窓から離れるほどゆるやかに弱める（decay 1・7m まで）。
        // 距離で弱まらない光にすると、部屋の境で明るさが段差のように切れて見えた（2026-10-25）
        l.decay = 1;
        l.distance = 7;
        l.userData.lrSpread = true;
        l.intensity = sky + art * 0.05;
        l.position.copy(l.userData.dayPos as THREE.Vector3);
      } else {
        l.decay = 2;
        l.distance = 6;
        l.userData.lrSpread = false;
        l.intensity = art;
        l.position.copy(l.userData.nightPos as THREE.Vector3);
      }
      const i = l.userData.floorIndex as number;
      l.visible = l.intensity > 0 && (walk ? i === this.walkFloor : true);
    }
    this.prepareLights();
  }

  /** 照明の組み合わせ（種類ごとの数・影の有無）が変わったら、シェーダーを裏で組み立てる */
  private prepareLights() {
    if (this.compiling) return;
    const shown = (o: THREE.Object3D | null) => {
      for (; o; o = o.parent) if (!o.visible) return false;
      return true;
    };
    const count: Record<string, number> = {};
    this.scene.traverse((o) => {
      const l = o as THREE.Light;
      if (!l.isLight || !shown(l)) return;
      const k = `${l.type}${l.castShadow ? '*' : ''}`;
      count[k] = (count[k] ?? 0) + 1;
    });
    const key = Object.keys(count).sort().map((k) => `${k}${count[k]}`).join(',');
    if (key === this.lightKey) return;
    this.lightKey = key;
    this.compiling = true;
    this.compileNote.style.display = 'block';
    this.renderer
      .compileAsync(this.scene, this.camera)
      .catch(() => undefined)
      .finally(() => {
        this.compiling = false;
        this.compileNote.style.display = 'none';
        this.lastActive = performance.now();
        // 組み立てている間に照明がまた変わっていたら、もう一度
        this.prepareLights();
      });
  }

  /** 見えている階の中のオブジェクトだけを返す */
  private visibleFloors() {
    return (this.built?.floors ?? []).filter((f) => f.group.visible);
  }

  private applyTime() {
    const t = this.effTime;
    // 夜も太陽は消さずに弱い月明かりにする（消すと影の設定が変わって描画が乱れる環境がある）
    this.sun.color.set(t === 'night' ? '#9fb3d9' : t === 'evening' ? '#ffb27a' : '#fff6ea');
    this.sun.intensity = t === 'night' ? 0.15 : t === 'evening' ? 1.8 : 2.6;
    this.hemi.color.set(t === 'night' ? '#2b3550' : t === 'evening' ? '#f0c3a0' : '#dfe9f5');
    // 下向きの面（天井）は床や壁からの照り返しで明るく見えるので、地面側の色も明るめにする。
    // 昼は色みのないグレー（前はベージュ #cfc6b6 で、天井だけ茶色く見えた。2026-10-22）
    this.hemi.groundColor.set(t === 'night' ? '#3a3328' : t === 'evening' ? '#cfc6b6' : '#d4d3d0');
    // 部屋の跳ね返りの光も、昼はほぼ白（夕方・夜は電球色）
    for (const l of this.roomLights.children as THREE.PointLight[]) l.color.set(t === 'day' ? '#fff4ea' : '#ffd6a0');
    // ウォークスルーでは、家じゅう一律に当たる空の光と映り込みを弱め、部屋ごとの窓の光（applyLights）で明るさを出す。
    // 前は昼 0.8・0.45 で、窓のない WIC・シューズクローク・廊下まで LDK と同じ明るさだった（2026-10-24）。俯瞰と Web 版は今までどおり
    const dim = this.mode === 'walk' && !WEB;
    this.hemi.intensity = t === 'night' ? 0.15 : t === 'evening' ? (dim ? 0.35 : 0.7) : dim ? 0.5 : 0.8;
    this.scene.environmentIntensity = t === 'night' ? 0.04 : t === 'evening' ? (dim ? 0.12 : 0.3) : dim ? 0.15 : 0.45;
    this.applyLights();
    this.scene.background = new THREE.Color(t === 'night' ? '#121826' : t === 'evening' ? '#e9b48f' : '#cfe0ee');
    this.renderer.toneMappingExposure = 1;
    this.updateSunPosition();
  }

  // ---------- 選択 ----------

  select(id: string | null) {
    this.selectedId = id;
    const g = id ? this.built?.furniture.get(id) : undefined;
    if (g && this.mode === 'orbit') {
      this.selection.box.setFromObject(g);
      this.selection.visible = true;
    } else {
      this.selection.visible = false;
    }
  }

  /** 部屋に入ってウォークスルーにする。家具と重ならない立ち位置を選ぶ */
  walkInto(roomId: string) {
    const floor = this.built?.floors.flatMap((f) => f.floorMeshes).find((f) => f.userData.roomId === roomId);
    if (!floor) return;
    this.walkFloor = floor.userData.floorIndex;
    const eye = floor.getWorldPosition(new THREE.Vector3()).y + this.eyeHeight;
    const box = new THREE.Box3().setFromObject(floor);
    const size = box.getSize(new THREE.Vector3());
    const obstacles = [...this.built!.furniture.values()].map((g) => new THREE.Box3().setFromObject(g).expandByScalar(0.25));
    // [x の割合, z の割合, 向き]。北寄りなら南を、南寄りなら北を見渡す
    const candidates: [number, number, number][] = [
      [0.5, 0.2, Math.PI], [0.5, 0.8, 0], [0.3, 0.2, Math.PI], [0.7, 0.2, Math.PI],
      [0.3, 0.8, 0], [0.7, 0.8, 0], [0.5, 0.5, Math.PI], [0.2, 0.5, Math.PI], [0.8, 0.5, Math.PI],
      // 大きな家具（車など）でふさがっているときは壁際に立つ
      [0.5, 0.06, Math.PI], [0.5, 0.94, 0], [0.1, 0.5, Math.PI], [0.9, 0.5, Math.PI],
    ];
    for (const [fx, fz, yaw] of candidates) {
      const p = new THREE.Vector3(box.min.x + size.x * fx, box.min.y + 0.5, box.min.z + size.z * fz);
      // L字の部屋などで外に出ないよう、真下に床があるか確かめる
      this.raycaster.set(new THREE.Vector3(p.x, p.y + 1, p.z), new THREE.Vector3(0, -1, 0));
      if (!this.raycaster.intersectObject(floor, false).length) continue;
      if (obstacles.some((o) => o.containsPoint(p))) continue;
      this.setMode('walk', p.setY(eye), yaw);
      return;
    }
    this.setMode('walk', box.getCenter(new THREE.Vector3()).setY(eye), Math.PI);
  }

  // ---------- マウス・キー操作 ----------

  private pointer(e: MouseEvent): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private hitFurniture(ndc: THREE.Vector2): { id: string; point: THREE.Vector3 } | null {
    if (!this.built) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const visible = [...this.built.furniture.values()].filter((g) => g.visible && g.parent?.visible);
    const hits = this.raycaster.intersectObjects(visible, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.furnitureId) o = o.parent;
      if (o) return { id: o.userData.furnitureId, point: h.point };
    }
    return null;
  }

  /** クリックした所の部屋。屋根や上の階の床下に当たったら null */
  private hitRoom(ndc: THREE.Vector2): THREE.Mesh | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const floors = this.visibleFloors();
    const targets = floors.flatMap((f) => [...f.floorMeshes, ...f.caps.filter((c) => c.visible)]);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit && hit.object.userData.roomId ? (hit.object as THREE.Mesh) : null;
  }

  private setupPointer() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    let look: { x: number; y: number } | null = null;

    // 俯瞰は見るだけ（家具はドラッグで動かさない）。クリックした家具・部屋を選んでパネルに出す
    // 3D の画面を押したら、キー操作がこの画面に届くようにする（パネルの欄から外し、iPad などでも画面にフォーカスを移す）
    el.tabIndex = -1;
    el.style.outline = 'none';
    el.addEventListener('pointerdown', (e) => {
      if (document.activeElement instanceof HTMLElement && document.activeElement !== el) document.activeElement.blur();
      el.focus({ preventScroll: true });
      down = { x: e.clientX, y: e.clientY };
      if (this.mode === 'walk') {
        look = { x: e.clientX, y: e.clientY };
        el.setPointerCapture(e.pointerId);
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!look) return;
      const k = this.invertLook ? -0.004 : 0.004;
      this.yaw -= (e.clientX - look.x) * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - look.y) * k, -1.3, 1.3);
      look = { x: e.clientX, y: e.clientY };
    });

    el.addEventListener('pointerup', (e) => {
      const clicked = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4;
      look = null;
      down = null;
      if (!clicked || !this.built || e.button !== 0) return;
      const ndc = this.pointer(e);
      if (this.mode === 'walk') {
        this.walkClick(ndc);
        return;
      }
      const hit = this.hitFurniture(ndc);
      if (hit) {
        this.events.onSelectFurniture(hit.id);
        return;
      }
      const room = this.hitRoom(ndc);
      this.events.onSelectFurniture(null);
      if (room) this.events.onSelectRoom(room.userData.roomId);
    });

    el.addEventListener('dblclick', (e) => {
      if (this.mode !== 'orbit' || !this.built) return;
      const room = this.hitRoom(this.pointer(e));
      if (room) this.walkInto(room.userData.roomId);
    });
  }

  /** ウォークスルーで画面の点（NDC）をクリックした（スペースキーは画面の真ん中の＋） */
  private walkClick(ndc: THREE.Vector2) {
    if (!this.built) return;
    const target = this.targetAt(ndc);
    // スイッチなら、押したボタンの回路をつけ消しする
    if (target?.kind === 'furniture' && this.events.onPressSwitch) {
      const button = this.switchButtonAt(ndc, target.furnitureId);
      if (button !== null) {
        this.events.onPressSwitch(target.furnitureId, button);
        return;
      }
    }
    // 扉（引き戸・開き戸・収納の扉）なら開け閉めする
    const g = target?.kind === 'furniture' ? this.built.furniture.get(target.furnitureId) : undefined;
    // クリックで照明をつけ消しする家具（レンジフード）
    if (target?.kind === 'furniture' && this.clickLights.has(target.furnitureId)) {
      const id = target.furnitureId;
      if (this.clickOn.has(id)) this.clickOn.delete(id);
      else this.clickOn.add(id);
      this.applyLights();
      this.events.onPickSurface(target);
      return;
    }
    // 扉なら開け閉めし、パネルに「ドアを試す」を出す
    if (g && this.togglePartAt(ndc, g)) return;
    if (g && this.toggleDoors(g)) {
      this.events.onPickSurface(target);
      return;
    }
    this.events.onPickSurface(target);
  }

  private setupKeys() {
    const isTyping = () => {
      const a = document.activeElement;
      // チェックボックスやボタンを押したあとでも歩けるように、文字を打つ欄だけを除く
      return (a instanceof HTMLInputElement && ['text', 'number', 'search'].includes(a.type)) || a instanceof HTMLSelectElement || a instanceof HTMLTextAreaElement;
    };
    // iPad のキーボードや日本語入力中は code が空になることがあるので、key からも決める
    const KEY_CODES: Record<string, string> = { w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Shift: 'ShiftLeft' };
    const codeOf = (e: KeyboardEvent) => (e.code && e.code !== 'Unidentified' ? e.code : (KEY_CODES[e.key] ?? KEY_CODES[e.key.toLowerCase()] ?? e.key));
    window.addEventListener('keydown', (e) => {
      if (isTyping()) return;
      const code = codeOf(e);
      // スペースキー: ウォークスルーで画面の真ん中（＋）をクリックしたのと同じ（扉の開け閉め・スイッチ・クロスを試す）
      if ((code === 'Space' || e.key === ' ') && this.mode === 'walk') {
        e.preventDefault();
        if (!e.repeat) this.walkClick(new THREE.Vector2(0, 0));
        return;
      }
      this.keys.add(code);
      // 矢印キーで画面がスクロールしないように
      if (this.mode === 'walk' && code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(codeOf(e)));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** 画面のボタン（スマホの移動ボタン）で、キーを押している状態にする */
  setVirtualKey(code: string, on: boolean) {
    if (on) this.keys.add(code);
    else this.keys.delete(code);
  }

  /** クリックした所の扉・引出し（part の物）だけを開け閉めする。なければ false */
  private togglePartAt(ndc: THREE.Vector2, g: THREE.Object3D): boolean {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(g, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && o !== g && !o.userData.door) o = o.parent;
    const d = o?.userData.door as DoorState | undefined;
    if (!o || !d?.part) return false;
    d.open = !d.open;
    this.movingDoors.add(o);
    return true;
  }

  /** 家具の中の扉をすべて開け閉めする。扉がなければ false */
  private toggleDoors(g: THREE.Object3D): boolean {
    let found = false;
    g.traverse((o) => {
      const d = o.userData.door as DoorState | undefined;
      // 1 つずつ開ける扉・引出し（part）は、クリックした物だけを動かす（本体をクリックしても全部は開けない）
      if (!d || d.part) return;
      found = true;
      d.open = !d.open;
      this.movingDoors.add(o);
    });
    return found;
  }

  /** 開け閉め中の扉を少しずつ動かす（0.4 秒くらいで開く） */
  private animateDoors(dt: number) {
    const moved = this.movingDoors.size > 0;
    for (const o of this.movingDoors) {
      const d = o.userData.door as DoorState;
      const goal = d.open ? 1 : 0;
      d.t += Math.sign(goal - d.t) * Math.min(Math.abs(goal - d.t), dt * 2.5);
      poseDoor(o, d);
      if (d.t === goal) this.movingDoors.delete(o);
    }
    // 扉が動いたら当たり判定の箱も動かす
    if (moved) this.collision.updateDoors();
  }

  private tick() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.animateDoors(dt);
    if (this.mode === 'walk') {
      const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1.4) * dt;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const move = new THREE.Vector3();
      if (this.keys.has('KeyW')) move.add(fwd);
      if (this.keys.has('KeyS')) move.sub(fwd);
      // 矢印キーの上下は見上げる・見下ろす（左右は向きを変える）
      if (this.keys.has('ArrowUp')) this.pitch = Math.min(1.3, this.pitch + 1.2 * dt);
      if (this.keys.has('ArrowDown')) this.pitch = Math.max(-1.3, this.pitch - 1.2 * dt);
      if (this.keys.has('KeyD')) move.add(right);
      if (this.keys.has('KeyA')) move.sub(right);
      if (this.keys.has('ArrowLeft')) this.yaw += 1.5 * dt;
      if (this.keys.has('ArrowRight')) this.yaw -= 1.5 * dt;
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(speed);
        if (this.collideOn) {
          const feet = this.eyeY - this.eyeHeight;
          this.collision.move(this.camera.position, move.x, move.z, feet, this.eyeY + 0.1);
        } else this.camera.position.add(move);
        this.followGround(dt);
      }
      this.camera.position.y = this.eyeY;
      this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
      // 立っている部屋と見ている物は 0.2 秒ごとに調べる（毎フレームだと重い）
      this.walkInfoTimer -= dt;
      if (this.walkInfoTimer <= 0) {
        this.updateSensors(0.2 - this.walkInfoTimer);
        this.walkInfoTimer = 0.2;
        this.updateWalkInfo();
      }
    } else {
      this.orbit.update();
    }
    if (!WEB) this.lightRegions.update(this.scene);
    // 照明のシェーダーを裏で組み立てている間は描かない（描くとその場で組み立てが始まって画面が固まる）
    if (this.compiling) return;
    // 止まっている間は描き直さない（カメラが動いた・扉が動いている・触ってから 2 秒の間だけ描く）
    {
      const c = this.camera;
      const cam = `${c.position.toArray().join(',')}|${c.quaternion.toArray().join(',')}|${c.fov}|${c.aspect}`;
      const busy = cam !== this.lastCam || this.movingDoors.size > 0 || performance.now() - this.lastActive < 2000;
      this.lastCam = cam;
      if (!busy) return;
    }
    // 壁を切る断面表示と相性が悪いので、陰影の後処理はウォークスルーのときだけ
    if (this.mode === 'walk' && this.highQuality) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  /** 足元の床や階段の段の高さに合わせて目の高さを変える（45cm までの段なら上り下りできる） */
  private followGround(dt: number) {
    const feet = this.eyeY - this.eyeHeight;
    const p = this.camera.position;
    this.raycaster.set(new THREE.Vector3(p.x, feet + 0.45, p.z), new THREE.Vector3(0, -1, 0));
    this.raycaster.far = 3;
    const hit = this.raycaster.intersectObjects(this.walkTargets, true)[0];
    this.raycaster.far = Infinity;
    if (!hit) return;
    const target = hit.point.y + this.eyeHeight;
    this.eyeY += (target - this.eyeY) * Math.min(1, dt * 12);
    // 立っている階が変わったら、その階の照明に切り替える
    const floors = this.built?.floors ?? [];
    let index = 0;
    floors.forEach((f, i) => {
      if (hit.point.y >= f.group.position.y * MM - 0.3) index = i;
    });
    if (index !== this.walkFloor) {
      this.walkFloor = index;
      this.applyVisibility();
    }
  }

  private updateWalkInfo() {
    if (!this.built) return;
    // 足元の床
    const floors = this.built.floors[this.walkFloor]?.floorMeshes ?? [];
    this.raycaster.set(this.camera.position, new THREE.Vector3(0, -1, 0));
    const under = this.raycaster.intersectObjects(floors, false)[0];
    const roomId = (under?.object.userData.roomId as string | undefined) ?? null;
    // 画面の中央に見えている物（見えていない物・照明の光源は飛ばす）。向きを変えた直後なので行列を更新してから調べる
    const target = this.targetAt(new THREE.Vector2(0, 0));
    const key = JSON.stringify([roomId, target]);
    if (key === this.walkInfoKey) return;
    this.walkInfoKey = key;
    this.events.onWalkInfo({ roomId, target });
  }

  /** 画面の点（NDC）がスイッチのどのボタンか。スイッチでなければ null（プレートの縁なら一番近いボタン） */
  private switchButtonAt(ndc: THREE.Vector2, id: string): number | null {
    const g = this.built?.furniture.get(id);
    if (!g || g.userData.furnitureType !== 'switch') return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(g, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && o !== g && o.userData.button === undefined) o = o.parent;
    if (o && o.userData.button !== undefined) return o.userData.button as number;
    // ボタンの間やプレートの縁を押したときは、高さが一番近いボタン
    if (!hit) return 0;
    let best = 0;
    let bestD = Infinity;
    g.traverse((k) => {
      if (k.userData.button === undefined) return;
      const p = k.getWorldPosition(new THREE.Vector3());
      const dd = Math.abs(p.y - hit.point.y);
      if (dd < bestD) [best, bestD] = [k.userData.button as number, dd];
    });
    return best;
  }

  /** 画面の点（NDC）に見えている物。見えていない物・照明の光源は飛ばす */
  private targetAt(ndc: THREE.Vector2): WalkTarget | null {
    if (!this.built) return null;
    // 向きを変えた直後でもよいように、行列を更新してから調べる
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    for (const h of this.raycaster.intersectObject(this.built.root, true)) {
      if (!isShown(h.object)) continue;
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.info && !o.userData.furnitureId) o = o.parent;
      if (!o) continue;
      return o.userData.furnitureId ? { kind: 'furniture', furnitureId: o.userData.furnitureId } : (o.userData.info as SurfaceInfo);
    }
    return null;
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  /** 今の画面を PNG で保存する */
  screenshot(filename: string) {
    const a = document.createElement('a');
    a.href = this.renderer.domElement.toDataURL('image/png');
    a.download = filename;
    a.click();
  }

  /**
   * 今のカメラの絵を、光の跳ね返りまで計算して描く（three-gpu-pathtracer）。samples 回重ねたら PNG の data URL を返す。
   * 部屋ごとの跳ね返りの光（roomLights）は本物の跳ね返りと二重になるので消し、空は上が青・下が地面の色のグラデーションにする。
   * 鏡（Reflector）は金属の鏡の素材に置き換える。描いている間はふだんの描画を止める
   */
  async pathTrace(samples: number, onProgress?: (done: number) => void): Promise<string> {
    const { WebGLPathTracer, GradientEquirectTexture, DenoiseMaterial } = await import('three-gpu-pathtracer');
    this.renderer.setAnimationLoop(null);
    const scene = this.scene;
    const saved = {
      env: scene.environment, bg: scene.background, envI: scene.environmentIntensity,
      room: this.roomLights.visible, sel: this.selection.visible, exposure: this.renderer.toneMappingExposure,
    };
    const mirrorMat = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 1, roughness: 0.02 });
    const mirrors: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh & { isReflector?: boolean };
      if (m.isReflector) {
        mirrors.push([m, m.material]);
        m.material = mirrorMat;
      }
    });
    const sky = new GradientEquirectTexture(512);
    sky.topColor.set('#8fb6e3');
    sky.bottomColor.set('#cfcabd');
    sky.update();
    scene.environment = sky;
    scene.background = sky;
    scene.environmentIntensity = this.effTime === 'day' ? 1 : this.effTime === 'evening' ? 0.3 : 0.02;
    this.roomLights.visible = false;
    this.selection.visible = false;
    // 部屋の中は窓からの光だけなので、写真の露出のように明るく撮る
    this.renderer.toneMappingExposure = this.effTime === 'day' ? 2.4 : 1.6;
    const pt = new WebGLPathTracer(this.renderer);
    pt.minSamples = 0;
    pt.renderDelay = 0;
    pt.fadeDuration = 0;
    pt.rasterizeScene = false;
    pt.bounces = 6;
    pt.filterGlossyFactor = 0.5;
    try {
      pt.setScene(scene, this.camera);
      while (pt.samples < samples) {
        pt.renderSample();
        onProgress?.(Math.floor(pt.samples));
        await new Promise((r) => requestAnimationFrame(r));
      }
      // 残ったざらつきを、輪郭を残してぼかす（smart denoise）
      const denoiseMat = new DenoiseMaterial({ map: pt.target.texture, blending: THREE.NoBlending });
      // 元のシェーダーは色に不透明度を掛ける（下描きの不透明度が 0 のとき真っ黒になる）ので、不透明度を使わない形に直す
      denoiseMat.fragmentShader = denoiseMat.fragmentShader
        .replace(/(centrPx|walkPx)\.rgb \*= \1\.a;/g, '$1.a = 1.0;')
        .replace('gl_FragColor.a *= opacity;', 'gl_FragColor.a = 1.0;');
      denoiseMat.uniforms.sigma.value = 4;
      denoiseMat.uniforms.threshold.value = 0.06;
      const denoise = new FullScreenQuad(denoiseMat);
      this.renderer.setRenderTarget(null);
      denoise.render(this.renderer);
      const url = this.renderer.domElement.toDataURL('image/png');
      denoise.material.dispose();
      denoise.dispose();
      return url;
    } finally {
      pt.dispose();
      sky.dispose();
      mirrorMat.dispose();
      for (const [m, mat] of mirrors) m.material = mat;
      scene.environment = saved.env;
      scene.background = saved.bg;
      scene.environmentIntensity = saved.envI;
      this.roomLights.visible = saved.room;
      this.selection.visible = saved.sel;
      this.renderer.toneMappingExposure = saved.exposure;
      this.renderer.setAnimationLoop(() => this.tick());
    }
  }
}

/** 親も含めて表示されているか */
function isShown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      // 素材カタログのマテリアルはキャッシュして使い回すので捨てない
      // 屋根のように面ごとに素材が違う物は配列
      const ms = (Array.isArray(o.material) ? o.material : [o.material]) as THREE.Material[];
      for (const m of ms) if (!m.userData.shared) m.dispose();
    }
    // 鏡は映り込み用の描画先を持っている
    const r = o as THREE.Object3D & { isReflector?: boolean; dispose?: () => void };
    if (r.isReflector) r.dispose?.();
  });
}
