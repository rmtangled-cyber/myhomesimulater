import './style.css';
import { getFurnitureType } from './furniture';
import { centroid } from './geometry';
import { PlanStore, type SaveStatus } from './store';
import type { Furniture } from './types';
import { Panel, type PanelState, type Selection } from './ui';
import { Viewer } from './viewer';

const store = new PlanStore();
const ui: Omit<PanelState, 'plan' | 'planName'> = {
  plans: [],
  selection: null,
  mode: 'orbit',
  time: 'day',
  cutaway: true,
  labels: true,
  status: 'saved',
  warnings: [],
};

const viewer = new Viewer(document.getElementById('viewport')!, {
  onSelectFurniture: (id) => select(id ? { kind: 'furniture', id } : null),
  onSelectRoom: (id) => select({ kind: 'room', id }),
  onMoveFurniture: (id, x, y) =>
    store.edit((p) => {
      const f = p.furniture.find((f) => f.id === id);
      if (f) Object.assign(f, { x, y });
    }),
});

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
      const r = p.rooms.find((r) => r.id === id);
      if (r) fn(r);
    }),
  updateFurniture: (id, fn) =>
    store.edit((p) => {
      const f = p.furniture.find((f) => f.id === id);
      if (f) fn(f);
    }),
  addFurniture: (type) => {
    const t = getFurnitureType(type);
    const sel = ui.selection;
    const room = sel?.kind === 'room' ? store.plan.rooms.find((r) => r.id === sel.id) : undefined;
    const [x, y] = centroid(room?.polygon ?? store.plan.rooms.flatMap((r) => r.polygon));
    const f: Furniture = { id: newId(type), type, name: t.label, x: Math.round(x), y: Math.round(y), rotation: 0, ...t.defaults };
    store.edit((p) => p.furniture.push(f));
    select({ kind: 'furniture', id: f.id });
  },
  duplicateFurniture: (id) => {
    const src = store.plan.furniture.find((f) => f.id === id);
    if (!src) return;
    const f = { ...src, id: newId(src.type), x: src.x + 300, y: src.y + 300 };
    store.edit((p) => p.furniture.push(f));
    select({ kind: 'furniture', id: f.id });
  },
  removeFurniture: (id) => {
    store.edit((p) => (p.furniture = p.furniture.filter((f) => f.id !== id)));
    select(null);
  },
  screenshot: () => viewer.screenshot(`${store.name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`),
  undo: () => store.undo(),
  redo: () => store.redo(),
});

function newId(type: string): string {
  const used = new Set(store.plan.furniture.map((f) => f.id));
  let n = 1;
  while (used.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}

function select(sel: Selection) {
  ui.selection = sel;
  viewer.select(sel?.kind === 'furniture' ? sel.id : null);
  render();
}

function render() {
  if (!store.plan) return;
  panel.render({ ...ui, plan: store.plan, planName: store.name });
}

store.subscribe((plan) => {
  ui.warnings = viewer.setPlan(plan);
  // 消えた家具・部屋の選択は外す
  const sel = ui.selection;
  if (sel && !(sel.kind === 'furniture' ? plan.furniture : plan.rooms).some((x) => x.id === sel.id)) ui.selection = null;
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
  localStorage.setItem('lastPlan', name);
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
      const f = p.furniture.find((f) => f.id === sel.id);
      if (f) f.rotation = (((f.rotation + step) % 360) + 360) % 360;
    });
  } else if (e.code === 'Delete' || e.code === 'Backspace') {
    store.edit((p) => (p.furniture = p.furniture.filter((f) => f.id !== sel.id)));
    select(null);
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
    const wanted = new URLSearchParams(location.search).get('plan') ?? localStorage.getItem('lastPlan');
    await openPlan(wanted && ui.plans.includes(wanted) ? wanted : ui.plans[0]);
  } catch (e) {
    document.getElementById('panel')!.innerHTML = `<section class="warnings"><h2>読み込みエラー</h2><p>${(e as Error).message}</p><p>npm run dev で起動していますか？</p></section>`;
  }
})();

// 開発中にブラウザのコンソールや自動テストから触れるようにする
if (import.meta.env.DEV) Object.assign(window, { viewer, store });
