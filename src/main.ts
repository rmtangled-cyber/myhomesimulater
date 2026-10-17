import './style.css';
import { getFurnitureType } from './furniture';
import { centroid } from './geometry';
import { PlanStore, type SaveStatus } from './store';
import type { Furniture, Plan, Room } from './types';
import { describeTarget, Panel, type PanelState, type Selection } from './ui';
import { exportPlan } from './planExport';
import { Viewer, type WalkInfo } from './viewer';
import { WEB, WEB_START_ROOMS, WEB_FLOOR } from './env';

const store = new PlanStore();

/** 見る人ごとの設定（保存できない環境では既定値） */
function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function loadNumber(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // 保存できなくても今の画面では効く
  }
}
const ui: Omit<PanelState, 'plan' | 'planName'> = {
  plans: [],
  selection: null,
  floor: 0,
  floorView: 'all',
  mode: 'orbit',
  time: 'day',
  cutaway: true,
  labels: true,
  lightsOn: false,
  // Web 版（スマホ）は軽くするため、陰影の後処理を切っておく
  highQuality: !WEB,
  invertLook: loadFlag('invertLook'),
  stature: loadNumber('stature', 160),
  walkRoomId: null,
  picked: null,
  pressed: null,
  status: 'saved',
  warnings: [],
};

function findRoom(plan: Plan, id: string): { room: Room; floor: number } | undefined {
  for (const [i, f] of plan.floors.entries()) {
    const room = f.rooms.find((r) => r.id === id);
    if (room) return { room, floor: i };
  }
}

function findFurniture(plan: Plan, id: string): { item: Furniture; floor: number } | undefined {
  for (const [i, f] of plan.floors.entries()) {
    const item = f.furniture.find((x) => x.id === id);
    if (item) return { item, floor: i };
  }
}

// ウォークスルー中に画面の中央に出す照準と、見ている物の名前
const hud = document.createElement('div');
hud.className = 'walk-hud';
hud.hidden = true;
hud.innerHTML = '<div class="crosshair"></div><div class="walk-target"></div>';
document.getElementById('viewport')!.append(hud);

function onWalkInfo(info: WalkInfo | null) {
  hud.hidden = !info;
  const text = info?.target && store.plan ? describeTarget(store.plan, info.target) : '';
  const label = hud.querySelector<HTMLElement>('.walk-target')!;
  label.textContent = text;
  label.hidden = !text;
  const roomId = info?.roomId ?? null;
  if (roomId !== ui.walkRoomId) {
    ui.walkRoomId = roomId;
    render();
  }
}

/** クロスを貼った箱（ふかし壁・折り上げの立ち上がりなど）。壁と同じくクリックでクロスを張り替えられる */
function isWallBox(id: string): boolean {
  const f = findFurniture(store.plan, id)?.item;
  return !!f && f.type === 'box' && !!f.material?.startsWith('cross-');
}

const viewer = new Viewer(document.getElementById('viewport')!, {
  onWalkInfo,
  // ウォークスルーで壁・天井をクリックしたら、パネルに「クロスを試す」を出す
  onPickSurface: (target) => {
    ui.picked =
      target?.kind === 'wall' && target.zone
        ? { kind: 'zone', roomId: target.roomId, zoneId: target.zone, materialId: target.materialId }
        : target?.kind === 'wall'
        ? { kind: 'wall', roomId: target.roomId, edge: target.edge, side: target.side, materialId: target.materialId }
        : target?.kind === 'ceiling' || target?.kind === 'floor'
          ? { kind: target.kind, roomId: target.roomId }
          : target?.kind === 'jamb' && target.openingId
            ? { kind: 'jamb', openingId: target.openingId, materialId: target.materialId ?? '' }
            : target?.kind === 'jamb' && target.capKey !== undefined && target.floor !== undefined
              ? { kind: 'cap', floor: target.floor, capKey: target.capKey, materialId: target.materialId ?? '' }
            : target?.kind === 'furniture' && isWallBox(target.furnitureId)
              ? { kind: 'furniture', furnitureId: target.furnitureId }
              : null;
    render();
  },
  // スイッチを押したら、その回路の照明をつけ消しし、どこと連動しているかをパネルに出す
  onPressSwitch: WEB ? undefined : (switchId, button) => {
    const c = (store.plan.circuits ?? []).find((x) => x.switches.some((s) => s.id === switchId && (s.button ?? 0) === button));
    const on = c ? viewer.toggleCircuit(c.id) : false;
    ui.pressed = { switchId, button, circuitId: c?.id ?? null, on };
    ui.picked = null;
    render();
  },
  onSelectFurniture: (id) => select(id ? { kind: 'furniture', id } : null),
  onSelectRoom: (id) => select({ kind: 'room', id }),
});

function setFloorView(view: number | 'all') {
  // ウォークスルー中に階を選んだら、ウォークスルーのまま、その階の決まった部屋へ移る（外観は俯瞰に戻る）
  if (ui.mode === 'walk' && view !== 'all') {
    const rooms = store.plan.floors[view]?.rooms ?? [];
    const start = rooms.find((r) => r.id === WEB_START_ROOMS[view]) ?? rooms.find((r) => !r.void);
    if (start) {
      ui.floor = view;
      viewer.walkInto(start.id);
      render();
      return;
    }
  }
  ui.floorView = view;
  if (view !== 'all') ui.floor = view;
  viewer.setFloorView(view);
  if (ui.mode === 'walk') {
    viewer.setMode('orbit');
    ui.mode = 'orbit';
  }
  render();
}

const panel = new Panel(document.getElementById('panel')!, {
  setMode: (mode) => {
    viewer.setMode(mode);
    ui.mode = mode;
    render();
  },
  setTime: (time) => {
    viewer.setTime(time);
    ui.time = time;
    render();
  },
  setCutaway: (on) => {
    viewer.setCutaway(on);
    ui.cutaway = on;
  },
  setLabels: (on) => {
    viewer.setLabels(on);
    ui.labels = on;
  },
  setLightsOn: (on) => {
    viewer.setLightsOn(on);
    ui.lightsOn = on;
  },
  setHighQuality: (on) => {
    viewer.setHighQuality(on);
    ui.highQuality = on;
  },
  setInvertLook: (on) => {
    viewer.setInvertLook(on);
    ui.invertLook = on;
    saveFlag('invertLook', on);
  },
  setStature: (cm) => {
    viewer.setStature(cm);
    ui.stature = cm;
    try {
      localStorage.setItem('stature', String(cm));
    } catch {
      // 保存できなくても今の画面では効く
    }
    render();
  },
  addImageMaterial,
  setFloorView,
  switchPlan: (name) => openPlan(name),
  duplicatePlan: async () => {
    const name = prompt('新しい案の名前（英数字・日本語・_ -）', `${store.name}-2`)?.trim();
    if (!name) return;
    await store.saveAs(name);
    ui.plans = await store.list();
    render();
  },
  select,
  // Web 版で階を選んだら、その階の決まった部屋に立つ
  openWebFloor: (i) => {
    viewer.walkInto(WEB_START_ROOMS[i] ?? store.plan.floors[i].rooms[0].id);
    ui.mode = 'walk';
    render();
  },
  walkInto: (id) => {
    viewer.walkInto(id);
    ui.mode = 'walk';
    render();
  },
  updateRoom: (id, fn) =>
    store.edit((p) => {
      const r = findRoom(p, id)?.room;
      if (r) fn(r);
    }),
  updateFloor: (index, fn) =>
    store.edit((p) => {
      const f = p.floors[index];
      if (f) fn(f);
    }),
  updateOpening: (id, fn) =>
    store.edit((p) => {
      const o = p.floors.flatMap((f) => f.openings).find((x) => x.id === id);
      if (o) fn(o);
    }),
  updateFurniture: (id, fn) =>
    store.edit((p) => {
      const f = findFurniture(p, id)?.item;
      if (f) fn(f);
    }),
  addFurniture: (type) => {
    const t = getFurnitureType(type);
    const floor = store.plan.floors[ui.floor];
    const sel = ui.selection;
    const room = sel?.kind === 'room' ? floor.rooms.find((r) => r.id === sel.id) : undefined;
    const [x, y] = centroid(room?.polygon ?? floor.rooms.flatMap((r) => r.polygon));
    const f: Furniture = { id: newId(type), type, name: t.label, x: Math.round(x), y: Math.round(y), rotation: 0, ...t.defaults };
    if (room?.level) f.z = room.level;
    store.edit((p) => p.floors[ui.floor].furniture.push(f));
    select({ kind: 'furniture', id: f.id });
  },
  duplicateFurniture: (id) => {
    const found = findFurniture(store.plan, id);
    if (!found) return;
    const f = { ...found.item, id: newId(found.item.type), x: found.item.x + 300, y: found.item.y + 300 };
    store.edit((p) => p.floors[found.floor].furniture.push(f));
    select({ kind: 'furniture', id: f.id });
  },
  removeFurniture,
  exportPlan: () => exportPlan(store.plan, `${store.name}-図面-${new Date().toISOString().slice(0, 10)}.png`),
  screenshot: () => viewer.screenshot(`${store.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`),
  undo: () => store.undo(),
  redo: () => store.redo(),
});

/** 画像ファイルを public/textures/ に保存し、素材として登録する */
async function addImageMaterial(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    alert('JPEG・PNG・WebP の画像を選んでください');
    return;
  }
  const name = prompt('素材の名前（品番など）', file.name.replace(/\.[^.]+$/, ''))?.trim();
  if (!name) return;
  const size = prompt('画像1枚が実物の何 mm 分か（例: 300。横と縦が違うときは 600x300）', '300')?.trim();
  if (!size) return;
  const [tw, th] = size.split(/[x×*,\s]+/).map(Number);
  if (!(tw > 0)) {
    alert('大きさは数字で入れてください（例: 300）');
    return;
  }
  const isFloor = confirm('床材として使いますか？\n\nOK → 床\nキャンセル → 壁・天井');
  const slug = name.replace(/[^\p{L}\p{N}_-]+/gu, '-');
  const fileName = `${slug}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const res = await fetch(`/api/textures/${encodeURIComponent(fileName)}`, { method: 'PUT', body: file });
  if (!res.ok) {
    alert('画像を保存できませんでした');
    return;
  }
  const id = `img-${slug}`;
  store.edit((p) => {
    p.materials = [
      ...(p.materials ?? []).filter((m) => m.id !== id),
      // 同じ名前で差し替えたときに古い画像が表示されないよう、版を付ける
      { id, name, categories: [isFloor ? 'floor' : 'wall'], image: `textures/${fileName}?v=${Date.now()}`, tile: [tw, th > 0 ? th : tw] },
    ];
  });
  ui.status = 'saved';
  ui.statusMessage = `素材「${name}」を追加しました。${isFloor ? '床' : '壁・天井'}の選択欄から選べます`;
  render();
}

function removeFurniture(id: string) {
  store.edit((p) => {
    for (const f of p.floors) f.furniture = f.furniture.filter((x) => x.id !== id);
  });
  select(null);
}

function newId(type: string): string {
  const used = new Set(store.plan.floors.flatMap((f) => f.furniture.map((x) => x.id)));
  let n = 1;
  while (used.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}

function select(sel: Selection) {
  ui.selection = sel;
  // 選んだ物がある階を編集対象にする
  if (sel) {
    const floor = sel.kind === 'room' ? findRoom(store.plan, sel.id)?.floor : findFurniture(store.plan, sel.id)?.floor;
    if (floor !== undefined) ui.floor = floor;
  }
  viewer.select(sel?.kind === 'furniture' ? sel.id : null);
  render();
}

/** ウォークスルーの移動ボタン（スマホなどキーボードのない画面用）。押している間だけ進む */
const touchPad = document.createElement('div');
touchPad.className = 'touch-pad';
touchPad.innerHTML = [
  ['ArrowLeft', '↺', '左を向く'],
  ['KeyW', '▲', '前へ'],
  ['ArrowRight', '↻', '右を向く'],
  ['KeyA', '◀', '左へ'],
  ['KeyS', '▼', '後ろへ'],
  ['KeyD', '▶', '右へ'],
]
  .map(([code, label, title]) => `<button type="button" data-key="${code}" aria-label="${title}" title="${title}">${label}</button>`)
  .join('');
for (const b of touchPad.querySelectorAll<HTMLButtonElement>('button')) {
  const code = b.dataset.key!;
  const on = (e: PointerEvent) => {
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    viewer.setVirtualKey(code, true);
  };
  const off = () => viewer.setVirtualKey(code, false);
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('lostpointercapture', off);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}
document.getElementById('viewport')!.append(touchPad);
const showTouchPad = WEB || matchMedia('(pointer: coarse)').matches;

function render() {
  if (!store.plan) return;
  touchPad.hidden = !(showTouchPad && ui.mode === 'walk');
  panel.render({ ...ui, plan: store.plan, planName: store.name });
}

viewer.setInvertLook(ui.invertLook);
viewer.setHighQuality(ui.highQuality);
viewer.setStature(ui.stature);
viewer.setTime(ui.time);
viewer.setLightsOn(ui.lightsOn);

store.subscribe((plan, cause) => {
  if (cause === 'load') ui.statusMessage = undefined;
  if (cause === 'load' && ui.floor >= plan.floors.length) ui.floor = 0;
  if (typeof ui.floorView === 'number' && ui.floorView >= plan.floors.length) ui.floorView = 0;
  ui.warnings = viewer.setPlan(plan);
  // 消えた家具・部屋の選択は外す
  const sel = ui.selection;
  if (sel && !(sel.kind === 'furniture' ? findFurniture(plan, sel.id) : findRoom(plan, sel.id))) ui.selection = null;
  viewer.select(ui.selection?.kind === 'furniture' ? ui.selection.id : null);
  render();
});

store.onStatus = (status: SaveStatus, message?: string) => {
  ui.status = status;
  ui.statusMessage = message;
  render();
};

async function openPlan(name: string) {
  ui.selection = null;
  await store.load(name);
  // 平屋なら最初から中を、複数階なら外観を見せる（Web 版は軽くするため 1 階から）
  setFloorView(store.plan.floors.length > 1 && !WEB ? 'all' : 0);
  try {
    localStorage.setItem('lastPlan', name);
  } catch {
    // 保存できない環境でも動かす
  }
  if (!WEB) history.replaceState(null, '', `?plan=${encodeURIComponent(name)}`);
  // Web 版は俯瞰なし。その階の決まった部屋に立って始める
  if (WEB) {
    const rooms = store.plan.floors[WEB_FLOOR]?.rooms ?? store.plan.floors[0].rooms;
    const start = rooms.find((r) => r.id === WEB_START_ROOMS[WEB_FLOOR]) ?? rooms.find((r) => !r.void);
    if (start) {
      viewer.walkInto(start.id);
      ui.mode = 'walk';
      render();
    }
  }
}

window.addEventListener('keydown', (e) => {
  const a = document.activeElement;
  if (a instanceof HTMLInputElement || a instanceof HTMLSelectElement || a instanceof HTMLTextAreaElement) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ') {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
    return;
  }
  if (mod && e.code === 'KeyY') {
    e.preventDefault();
    store.redo();
    return;
  }
  const sel = ui.selection;
  if (e.code === 'Escape') {
    if (ui.mode === 'walk' && !WEB) {
      viewer.setMode('orbit');
      ui.mode = 'orbit';
    }
    select(null);
    return;
  }
  if (sel?.kind !== 'furniture' || ui.mode !== 'orbit') return;
  if (e.code === 'KeyR') {
    const step = e.shiftKey ? 15 : 90;
    store.edit((p) => {
      const f = findFurniture(p, sel.id)?.item;
      if (f) f.rotation = (((f.rotation + step) % 360) + 360) % 360;
    });
  } else if (e.code === 'Delete' || e.code === 'Backspace') {
    removeFurniture(sel.id);
  }
});

// Claude などがファイルを書き換えたら読み込み直す
if (import.meta.hot) {
  import.meta.hot.on('plan-changed', (data: { name: string }) => {
    if (data.name === store.name) store.reloadIfChanged();
    else store.list().then((p) => ((ui.plans = p), render()));
  });
}

(async () => {
  try {
    ui.plans = await store.list();
    let last: string | null = null;
    try {
      last = localStorage.getItem('lastPlan');
    } catch {
      // 読めなくても最初の案を開く
    }
    const wanted = new URLSearchParams(location.search).get('plan') ?? last;
    await openPlan(wanted && ui.plans.includes(wanted) ? wanted : ui.plans[0]);
  } catch (e) {
    document.getElementById('panel')!.innerHTML = `<section class="warnings"><h2>読み込みエラー</h2><p>${(e as Error).message}</p><p>npm run dev で起動していますか？</p></section>`;
  }
})();

// 開発中にブラウザのコンソールや自動テストから触れるようにする
if (import.meta.env.DEV || WEB) Object.assign(window, { viewer, store });
