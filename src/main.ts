import './style.css';
import { getFurnitureType } from './furniture';
import { centroid } from './geometry';
import { PlanStore, type SaveStatus } from './store';
import type { Furniture, Plan, Room } from './types';
import { Panel, type PanelState, type Selection } from './ui';
import { Viewer } from './viewer';

const store = new PlanStore();
const ui: Omit<PanelState, 'plan' | 'planName'> = {
  plans: [],
  selection: null,
  floor: 0,
  floorView: 'all',
  mode: 'orbit',
  time: 'day',
  cutaway: true,
  labels: true,
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

const viewer = new Viewer(document.getElementById('viewport')!, {
  onSelectFurniture: (id) => select(id ? { kind: 'furniture', id } : null),
  onSelectRoom: (id) => select({ kind: 'room', id }),
  onMoveFurniture: (id, x, y) =>
    store.edit((p) => {
      const f = findFurniture(p, id)?.item;
      if (f) Object.assign(f, { x, y });
    }),
});

function setFloorView(view: number | 'all') {
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
  screenshot: () => viewer.screenshot(`${store.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`),
  undo: () => store.undo(),
  redo: () => store.redo(),
});

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

function render() {
  if (!store.plan) return;
  panel.render({ ...ui, plan: store.plan, planName: store.name });
}

store.subscribe((plan, cause) => {
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
  // 平屋なら最初から中を、複数階なら外観を見せる
  setFloorView(store.plan.floors.length > 1 ? 'all' : 0);
  try {
    localStorage.setItem('lastPlan', name);
  } catch {
    // 保存できない環境でも動かす
  }
  history.replaceState(null, '', `?plan=${encodeURIComponent(name)}`);
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
    if (ui.mode === 'walk') {
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
if (import.meta.env.DEV) Object.assign(window, { viewer, store });
