// 3D 表示。カメラ（俯瞰／ウォークスルー）、照明、家具のドラッグ操作を受け持つ。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { pointInPolygon } from './geometry';
import { buildPlan, type BuiltPlan, type SurfaceInfo } from './builder';
import type { Plan } from './types';

export type ViewMode = 'orbit' | 'walk';
export type TimeOfDay = 'day' | 'evening' | 'night';

/** ウォークスルーで画面の中央に見えている物 */
export type WalkTarget = SurfaceInfo | { kind: 'furniture'; furnitureId: string };

export interface WalkInfo {
  /** 今立っている部屋 */
  roomId: string | null;
  target: WalkTarget | null;
}

export interface ViewerEvents {
  /** 家具をクリックした（null は何もない所） */
  onSelectFurniture: (id: string | null) => void;
  onSelectRoom: (id: string) => void;
  /** 家具をドラッグし終えた（位置は mm） */
  onMoveFurniture: (id: string, x: number, y: number) => void;
  /** ウォークスルーで立っている部屋・見ている物が変わった（俯瞰に戻ると null） */
  onWalkInfo: (info: WalkInfo | null) => void;
}

const MM = 0.001;
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
  private walkInfoTimer = 0;
  private composer: EffectComposer;
  private gtao: GTAOPass;

  constructor(
    private container: HTMLElement,
    private events: ViewerEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    this.camera.position.set(12, 14, 18);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.maxPolarAngle = Math.PI / 2 - 0.05;

    // 周りの景色の映り込み・環境光（室内向けの柔らかい環境）
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    // ウォークスルー用の高画質描画（壁際や家具の下の陰影）
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 2, thickness: 1, scale: 1.2 });
    this.gtao.blendIntensity = 1;
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
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.roomLights, this.selection);
    this.selection.visible = false;

    this.setupPointer();
    this.setupKeys();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.applyTime();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------- 間取りの反映 ----------

  setPlan(plan: Plan): string[] {
    const first = !this.built;
    if (this.built) {
      this.world.remove(this.built.root);
      disposeTree(this.built.root);
    }
    this.built = buildPlan(plan, [this.clipPlane]);
    this.world.add(this.built.root);
    this.ground.position.y = (plan.groundLevel ?? 0) * MM - 0.005;
    if (typeof this.floorView === 'number') this.floorView = Math.min(this.floorView, plan.floors.length - 1);
    // 照明の位置計算などで使うので、追加した直後にワールド座標を確定させる
    this.world.updateMatrixWorld(true);
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
    this.built!.floors.forEach((floor, index) => {
      // 照明器具を置いた部屋は、その器具だけで照らす
      const fixtures = plan.floors[index].furniture.filter((f) => this.built!.furniture.get(f.id)?.getObjectByProperty('isLight', true));
      for (const mesh of floor.floorMeshes) {
        const box = new THREE.Box3().setFromObject(mesh);
        const size = box.getSize(new THREE.Vector3());
        if (size.x * size.z < 2 || !mesh.visible) continue;
        const room = plan.floors[index].rooms.find((r) => r.id === mesh.userData.roomId);
        if (room && fixtures.some((f) => pointInPolygon([f.x, f.y], room.polygon))) continue;
        const c = box.getCenter(new THREE.Vector3());
        const light = new THREE.PointLight('#ffd6a0', 30, 6, 2);
        light.position.set(c.x, floor.group.position.y * MM + mesh.userData.lightHeight * MM, c.z);
        light.userData.floorIndex = index;
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
    const dir = this.time === 'evening' ? new THREE.Vector3(-1, 0.35, 0.5) : new THREE.Vector3(-0.4, 1.1, 1);
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
    for (const l of this.roomLights.children) {
      const i = l.userData.floorIndex as number;
      l.visible = walk ? i === this.walkFloor : i <= top;
    }
  }

  /** 見えている階の中のオブジェクトだけを返す */
  private visibleFloors() {
    return (this.built?.floors ?? []).filter((f) => f.group.visible);
  }

  private applyTime() {
    const t = this.time;
    // 夜も太陽は消さずに弱い月明かりにする（消すと影の設定が変わって描画が乱れる環境がある）
    this.sun.color.set(t === 'night' ? '#9fb3d9' : t === 'evening' ? '#ffb27a' : '#fff6ea');
    this.sun.intensity = t === 'night' ? 0.15 : t === 'evening' ? 1.8 : 2.6;
    this.hemi.color.set(t === 'night' ? '#2b3550' : t === 'evening' ? '#f0c3a0' : '#dfe9f5');
    // 下向きの面（天井）は床や壁からの照り返しで明るく見えるので、地面側の色も明るめにする
    this.hemi.groundColor.set(t === 'night' ? '#3a3328' : '#cfc6b6');
    this.hemi.intensity = t === 'night' ? 0.15 : t === 'evening' ? 0.7 : 0.8;
    this.scene.environmentIntensity = t === 'night' ? 0.04 : t === 'evening' ? 0.3 : 0.45;
    const lit = this.lightsOn || t !== 'day';
    this.roomLights.visible = lit;
    for (const l of this.roomLights.children as THREE.PointLight[]) l.intensity = t === 'night' ? 30 : 10;
    // 照明器具の光源と、光る部分
    this.built?.root.traverse((o) => {
      if (o.userData.fixture) o.visible = lit;
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m?.userData?.glow !== undefined) m.emissiveIntensity = lit ? m.userData.glow : 0;
    });
    this.scene.background = new THREE.Color(t === 'night' ? '#121826' : t === 'evening' ? '#e9b48f' : '#cfe0ee');
    this.renderer.toneMappingExposure = t === 'night' ? 1.1 : 1;
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
    const visible = [...this.built.furniture.values()].filter((g) => g.parent?.visible);
    const hits = this.raycaster.intersectObjects(visible, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.furnitureId) o = o.parent;
      if (o) return { id: o.userData.furnitureId, point: h.point };
    }
    return null;
  }

  /** 高さ y（m）の水平面とマウスの交点 */
  private groundPoint(ndc: THREE.Vector2, y: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p);
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
    let drag: { id: string; group: THREE.Group; offset: THREE.Vector3; baseY: number; moved: boolean } | null = null;
    let look: { x: number; y: number } | null = null;

    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
      if (this.mode === 'walk') {
        look = { x: e.clientX, y: e.clientY };
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      const ndc = this.pointer(e);
      const hit = this.hitFurniture(ndc);
      if (hit) {
        const group = this.built!.furniture.get(hit.id)!;
        const pos = group.getWorldPosition(new THREE.Vector3());
        const gp = this.groundPoint(ndc, pos.y);
        drag = { id: hit.id, group, offset: gp ? pos.clone().sub(gp) : new THREE.Vector3(), baseY: pos.y, moved: false };
        this.orbit.enabled = false;
        el.setPointerCapture(e.pointerId);
        this.events.onSelectFurniture(hit.id);
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (look) {
        const k = this.invertLook ? -0.004 : 0.004;
        this.yaw -= (e.clientX - look.x) * k;
        this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - look.y) * k, -1.3, 1.3);
        look = { x: e.clientX, y: e.clientY };
        return;
      }
      if (!drag) {
        el.style.cursor = this.mode === 'orbit' && this.hitFurniture(this.pointer(e)) ? 'grab' : '';
        return;
      }
      const gp = this.groundPoint(this.pointer(e), drag.baseY);
      if (!gp) return;
      const p = gp.add(drag.offset);
      // 10mm 単位にそろえる
      const x = Math.round(p.x / MM / 10) * 10;
      const z = Math.round(p.z / MM / 10) * 10;
      drag.group.position.x = x;
      drag.group.position.z = z;
      drag.moved = true;
      el.style.cursor = 'grabbing';
      this.select(drag.id);
    });

    el.addEventListener('pointerup', (e) => {
      const clicked = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4;
      look = null;
      if (drag) {
        if (drag.moved) this.events.onMoveFurniture(drag.id, drag.group.position.x, drag.group.position.z);
        drag = null;
        this.orbit.enabled = this.mode === 'orbit';
        el.style.cursor = '';
        return;
      }
      if (clicked && this.mode === 'orbit' && this.built && e.button === 0) {
        const room = this.hitRoom(this.pointer(e));
        this.events.onSelectFurniture(null);
        if (room) this.events.onSelectRoom(room.userData.roomId);
      }
      down = null;
    });

    el.addEventListener('dblclick', (e) => {
      if (this.mode !== 'orbit' || !this.built) return;
      const room = this.hitRoom(this.pointer(e));
      if (room) this.walkInto(room.userData.roomId);
    });
  }

  private setupKeys() {
    const isTyping = () => {
      const a = document.activeElement;
      return a instanceof HTMLInputElement || a instanceof HTMLSelectElement || a instanceof HTMLTextAreaElement;
    };
    window.addEventListener('keydown', (e) => {
      if (isTyping()) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private tick() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.mode === 'walk') {
      const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1.4) * dt;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const move = new THREE.Vector3();
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(fwd);
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(fwd);
      if (this.keys.has('KeyD')) move.add(right);
      if (this.keys.has('KeyA')) move.sub(right);
      if (this.keys.has('ArrowLeft')) this.yaw += 1.5 * dt;
      if (this.keys.has('ArrowRight')) this.yaw -= 1.5 * dt;
      if (move.lengthSq() > 0) this.camera.position.addScaledVector(move.normalize(), speed);
      this.camera.position.y = this.eyeY;
      this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
      // 立っている部屋と見ている物は 0.2 秒ごとに調べる（毎フレームだと重い）
      this.walkInfoTimer -= dt;
      if (this.walkInfoTimer <= 0) {
        this.walkInfoTimer = 0.2;
        this.updateWalkInfo();
      }
    } else {
      this.orbit.update();
    }
    // 壁を切る断面表示と相性が悪いので、陰影の後処理はウォークスルーのときだけ
    if (this.mode === 'walk' && this.highQuality) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  private updateWalkInfo() {
    if (!this.built) return;
    // 足元の床
    const floors = this.built.floors[this.walkFloor]?.floorMeshes ?? [];
    this.raycaster.set(this.camera.position, new THREE.Vector3(0, -1, 0));
    const under = this.raycaster.intersectObjects(floors, false)[0];
    const roomId = (under?.object.userData.roomId as string | undefined) ?? null;
    // 画面の中央に見えている物（見えていない物・照明の光源は飛ばす）。向きを変えた直後なので行列を更新してから調べる
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    let target: WalkTarget | null = null;
    for (const h of this.raycaster.intersectObject(this.built.root, true)) {
      if (!isShown(h.object)) continue;
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.info && !o.userData.furnitureId) o = o.parent;
      if (!o) continue;
      target = o.userData.furnitureId ? { kind: 'furniture', furnitureId: o.userData.furnitureId } : (o.userData.info as SurfaceInfo);
      break;
    }
    const key = JSON.stringify([roomId, target]);
    if (key === this.walkInfoKey) return;
    this.walkInfoKey = key;
    this.events.onWalkInfo({ roomId, target });
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
      const m = o.material as THREE.Material;
      if (!m.userData.shared) m.dispose();
    }
    // 鏡は映り込み用の描画先を持っている
    const r = o as THREE.Object3D & { isReflector?: boolean; dispose?: () => void };
    if (r.isReflector) r.dispose?.();
  });
}
