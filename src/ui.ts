// 右側の操作パネル。状態から HTML を作り直し、操作は data-action で受け取る。

import { WEB } from './env';
import { FURNITURE_TYPES, STOPPER_COLORS, getFurnitureType } from './furniture';
import { pointInPolygon } from './geometry';
import { CALM_COLORS, CALM_HEX, CANDIDATE_FLOORS, CANDIDATE_WALLPAPERS, RAFFIS_COLORS, getMaterialDef, materialsFor, swatchUrl, type MaterialCategory } from './materials';
import type { SaveStatus } from './store';
import type { Floor, Furniture, Opening, Plan, Room, Side } from './types';
import type { TimeOfDay, ViewMode, WalkTarget } from './viewer';

/** ロールスクリーン・縦型ブラインドの色（商品が決まるまでの一般的な色） */
const SCREEN_COLORS: [string, string][] = [
  ['#f2f1ec', 'ホワイト'],
  ['#e8e2d3', 'アイボリー'],
  ['#cbbfa8', 'ベージュ'],
  ['#c9c9c6', 'ライトグレー'],
  ['#8e8f8f', 'グレー'],
  ['#4a4b4d', 'ダークグレー'],
  ['#232324', 'ブラック'],
  ['#6b5546', 'ブラウン'],
];

/** 三協アルミ FIRECUT-RS の枠の色（商品色）。色は公式の名前からの目安 */
const FIRECUT_FRAMES: [string, string][] = [
  ['#a69f92', 'シャンパングレイ（UC）'],
  ['#232324', 'ブラック（KC）'],
  ['#f2f2f0', 'ホワイト（WH）'],
  ['#b8babb', 'サンシルバー（SLC）'],
];

export type Selection = { kind: 'furniture'; id: string } | { kind: 'room'; id: string } | null;

export interface PanelState {
  plan: Plan;
  planName: string;
  plans: string[];
  selection: Selection;
  /** 部屋・家具の一覧を出し、家具を追加する階 */
  floor: number;
  /** 俯瞰で表示している階 */
  floorView: number | 'all';
  mode: ViewMode;
  time: TimeOfDay;
  cutaway: boolean;
  labels: boolean;
  lightsOn: boolean;
  highQuality: boolean;
  /** ウォークスルーで見回すドラッグの向きを逆にする */
  invertLook: boolean;
  /** ウォークスルーの目の高さを決める身長（cm） */
  stature: number;
  /** ウォークスルーで立っている部屋 */
  walkRoomId: string | null;
  /** ウォークスルーでクリックした壁・天井（クロスを試す対象） */
  /** ウォークスルーで押したスイッチ（どの回路をつけ消ししたか） */
  pressed: { switchId: string; button: number; circuitId: string | null; on: boolean } | null;
  picked: { kind: 'wall'; roomId: string; edge: number; side: Side; materialId: string } | { kind: 'ceiling' | 'floor'; roomId: string } | { kind: 'jamb'; openingId: string; materialId: string } | { kind: 'furniture'; furnitureId: string } | { kind: 'cap'; floor: number; capKey: string; materialId: string } | { kind: 'zone'; roomId: string; zoneId: string; materialId: string } | { kind: 'door'; furnitureId: string } | null;
  status: SaveStatus;
  statusMessage?: string;
  warnings: string[];
}

export interface PanelActions {
  setMode(mode: ViewMode): void;
  setTime(time: TimeOfDay): void;
  setCutaway(on: boolean): void;
  setLabels(on: boolean): void;
  setLightsOn(on: boolean): void;
  setHighQuality(on: boolean): void;
  setInvertLook(on: boolean): void;
  setStature(cm: number): void;
  addImageMaterial(file: File): void;
  setFloorView(view: number | 'all'): void;
  switchPlan(name: string): void;
  duplicatePlan(): void;
  select(sel: Selection): void;
  walkInto(roomId: string): void;
  /** Web 版で別の階のページへ移る */
  openWebFloor(index: number): void;
  updateRoom(id: string, fn: (r: Room) => void): void;
  /** 階の設定を変える（壁の切れ目の面のクロスなど） */
  updateFloor(index: number, fn: (f: Floor) => void): void;
  updateOpening(id: string, fn: (o: Opening) => void): void;
  updateFurniture(id: string, fn: (f: Furniture) => void): void;
  addFurniture(type: string): void;
  duplicateFurniture(id: string): void;
  removeFurniture(id: string): void;
  screenshot(): void;
  exportPlan(): void;
  undo(): void;
  redo(): void;
}

const SIDES: [Side, string][] = [
  ['north', '北'],
  ['east', '東'],
  ['south', '南'],
  ['west', '西'],
];

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: '保存済み',
  saving: '保存中…',
  error: 'エラー',
  reloaded: 'ファイルの変更を読み込みました',
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 素材IDをパネルに出す名前（品番など）にする */
export const materialLabel = (id: string) => getMaterialDef(id)?.name ?? id;

const SIDE_NAME: Record<Side, string> = { north: '北', east: '東', south: '南', west: '西' };
const OPENING_NAME = { window: '窓', door: 'ドア枠', opening: '開口' } as const;

/** ウォークスルーで画面の中央に見えている物の説明 */
export function describeTarget(plan: Plan, t: WalkTarget): string {
  const room = (id: string) => plan.floors.flatMap((f) => f.rooms).find((r) => r.id === id)?.name ?? '';
  switch (t.kind) {
    case 'wall':
      return `壁（${room(t.roomId)}・${SIDE_NAME[t.side]}）　${materialLabel(t.materialId)}`;
    case 'floor':
      return `床（${room(t.roomId)}）　${materialLabel(t.materialId)}`;
    case 'ceiling':
      return `天井（${room(t.roomId)}）　${materialLabel(t.materialId)}`;
    case 'exterior':
      return `外壁　${materialLabel(t.materialId)}`;
    case 'jamb':
      return `開口部まわりの壁（隣の壁と同じクロス）${t.materialId ? `　${materialLabel(t.materialId)}` : ''}`;
    case 'opening': {
      const o = plan.floors.flatMap((f) => f.openings).find((x) => x.id === t.openingId);
      return o ? `${OPENING_NAME[o.type]}（幅 ${o.width} × 高さ ${o.height}）` : '';
    }
    case 'furniture': {
      const f = plan.floors.flatMap((fl) => fl.furniture).find((x) => x.id === t.furnitureId);
      return f ? `${f.name}${f.material ? `　${materialLabel(f.material)}` : ''}` : '';
    }
  }
}

function materialSelect(category: MaterialCategory, value: string, attrs: string, allowNone = false): string {
  const list = materialsFor(category);
  const known = list.some((m) => m.id === value);
  const options = [
    allowNone ? `<option value="">（なし）</option>` : '',
    !known && value ? `<option value="${esc(value)}" selected>？ ${esc(value)}</option>` : '',
    ...list.map((m) => `<option value="${m.id}" ${m.id === value ? 'selected' : ''}>${esc(m.name)}</option>`),
  ].join('');
  const swatch = value && known ? `<img class="swatch" src="${swatchUrl(value)}" alt="">` : `<span class="swatch none"></span>`;
  return `<div class="mat-row">${swatch}<select ${attrs}>${options}</select></div>`;
}

export class Panel {
  private state!: PanelState;

  constructor(
    private el: HTMLElement,
    private actions: PanelActions,
  ) {
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('change', (e) => this.onChange(e));
  }

  render(state: PanelState) {
    this.state = state;
    const scroll = this.el.scrollTop;
    // ウォークスルー中は、立っている部屋の情報だけを出す
    const lists = state.mode === 'walk' ? [this.walkSection()] : WEB ? [this.roomsSection()] : [this.roomsSection(), this.addSection()];
    this.el.innerHTML = [this.header(), this.viewSection(), this.selectionSection(), ...lists, this.warningsSection(), this.helpSection()].join('');
    this.el.scrollTop = scroll;
  }

  private header(): string {
    const s = this.state;
    const opts = s.plans.map((p) => `<option value="${esc(p)}" ${p === s.planName ? 'selected' : ''}>${esc(p)}</option>`).join('');
    return `
      <header>
        <h1>${esc(s.plan.name)}</h1>
        <div class="row">
          ${WEB ? '' : `<select data-change="plan" title="間取り案を切り替え">${opts}</select>`}
          ${WEB ? '' : `<button data-action="duplicate-plan" title="今の案をコピーして新しい案を作る">案を複製</button>`}
        </div>
        <div class="status ${s.status}">${WEB ? 'Web版（見るだけ）。試した変更はこの画面だけで、保存されません' : STATUS_TEXT[s.status]}${s.statusMessage ? `：${esc(s.statusMessage)}` : ''}</div>
      </header>`;
  }

  private viewSection(): string {
    const s = this.state;
    const seg = (group: string, items: [string, string][], current: string) =>
      `<div class="seg">${items.map(([v, l]) => `<button data-action="${group}" data-value="${v}" class="${v === current ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const floors = s.plan.floors;
    const floorSeg =
      floors.length > 1
        ? seg('floor-view', [...floors.map((f, i): [string, string] => [String(i), f.name]), ['all', '外観']], s.mode === 'walk' ? String(this.walkFloorIndex()) : String(s.floorView))
        : '';
    return `
      <section>
        <h2>表示</h2>
        ${WEB ? seg('web-floor', floors.map((f, i): [string, string] => [String(i), f.name]), String(this.walkFloorIndex())) : floorSeg}
        ${WEB ? '' : seg('mode', [['orbit', '俯瞰'], ['walk', 'ウォークスルー']], s.mode)}
        ${seg('time', [['day', '昼'], ['evening', '夕方'], ['night', '夜（照明）']], s.time)}
        <div class="row">
          <label><input type="checkbox" data-change="cutaway" ${s.cutaway ? 'checked' : ''}> 壁を低く切る</label>
          <label><input type="checkbox" data-change="labels" ${s.labels ? 'checked' : ''}> 部屋名</label>
        </div>
        <div class="row">
          <label title="夕方・夜は自動で点きます"><input type="checkbox" data-change="lights" ${s.lightsOn ? 'checked' : ''}> 昼も照明をつける</label>
          <label title="ウォークスルーで壁際や家具まわりの陰影を描きます（重い場合は外してください）"><input type="checkbox" data-change="hq" ${s.highQuality ? 'checked' : ''}> 高画質</label>
        </div>
        <div class="row">
          <label title="ウォークスルーでドラッグしたときに見回す向きを逆にします"><input type="checkbox" data-change="invert" ${s.invertLook ? 'checked' : ''}> 見回す向きを逆にする</label>
        </div>
        <div class="row">
          <label class="num stature" title="ウォークスルーの目の高さを、この身長の人に合わせます">身長 <input type="number" min="80" max="220" step="1" data-change="stature" value="${s.stature}"> cm</label>
          <span class="hint">目の高さ ${s.stature - 11}cm</span>
        </div>
        <div class="row">
          <button data-action="undo" title="Ctrl+Z">↶ 元に戻す</button>
          <button data-action="redo" title="Ctrl+Shift+Z">↷ やり直す</button>
          ${WEB ? '' : `<button data-action="screenshot">📷 画像を保存</button>
          <button data-action="export-plan" title="今の間取りの平面図（各階）を PNG で保存します">📐 図面出力</button>`}
        </div>
      </section>`;
  }

  private selectionSection(): string {
    const sel = this.state.selection;
    if (!sel) return `<section class="selected empty"><h2>選択中</h2><p class="hint">家具や床をクリックすると、ここで編集できます。</p></section>`;
    if (sel.kind === 'furniture') {
      const f = this.state.plan.floors.flatMap((fl) => fl.furniture).find((x) => x.id === sel.id);
      return f ? this.furnitureEditor(f) : '';
    }
    const r = this.state.plan.floors.flatMap((fl) => fl.rooms).find((x) => x.id === sel.id);
    return r ? this.roomEditor(r) : '';
  }

  private furnitureEditor(f: Furniture): string {
    const num = (field: keyof Furniture, label: string, step = 10) =>
      `<label class="num">${label}<input type="number" step="${step}" data-furn="${field}" value="${f[field] ?? 0}"></label>`;
    return `
      <section class="selected">
        <h2>選択中の家具 <small>${esc(getFurnitureType(f.type).label)}</small></h2>
        <label class="wide">名前<input type="text" data-furn="name" value="${esc(f.name)}"></label>
        <div class="grid3">
          ${num('x', 'X（東へ）')}${num('y', 'Y（南へ）')}${num('rotation', '回転°', 15)}
          ${num('w', '幅')}${num('d', '奥行')}${num('h', '高さ')}
          ${num('z', '床からの高さ')}
          ${['open-shelf', 'wall-shelf', 'resin-shelf', 'rod-screen', 'winder-stairs'].includes(f.type) ? num('count', f.type === 'rod-screen' ? '本数' : f.type === 'winder-stairs' ? '段数' : '棚板の枚数', 1) : ''}
        </div>
        <div class="row">
          <label class="color">色 <input type="color" data-furn="color" value="${esc(f.color)}"></label>
          <label title="引き戸・開き戸の取手を反対側にするなど"><input type="checkbox" data-furn-flip ${f.flip ? 'checked' : ''}> 左右反転</label>
          <button data-action="rotate" data-value="90">↻ 90°</button>
          <button data-action="dup-furn">複製</button>
          <button data-action="remove-furn" class="danger">削除</button>
        </div>
        ${getFurnitureType(f.type).hint ? `<p class="hint">${esc(getFurnitureType(f.type).hint!)}</p>` : ''}
        <p class="hint">位置や大きさは上の数字で変えられます（R で 90° 回転、Delete で削除）。単位は mm。</p>
      </section>`;
  }

  private roomEditor(r: Room): string {
    return `
      <section class="selected">
        <h2>選択中の部屋</h2>
        <label class="wide">名前<input type="text" data-room="name" value="${esc(r.name)}"></label>
        <h3>床</h3>${materialSelect('floor', r.floor, 'data-room="floor"')}
        <h3>壁</h3>${materialSelect('wall', r.wall, 'data-room="wall"')}
        <h3>天井</h3>${materialSelect('wall', r.ceiling, 'data-room="ceiling"', true)}
        <h3>アクセントクロス</h3>
        ${SIDES.map(([side, label]) => `<div class="accent"><span>${label}の壁</span>${materialSelect('wall', r.accent?.[side] ?? '', `data-accent="${side}"`, true)}</div>`).join('')}
        <div class="row">
          <button data-action="walk-into" data-value="${esc(r.id)}">この部屋に入る</button>
          ${WEB ? '' : `<button data-action="add-image" title="メーカーの見本画像などを素材として登録します">＋ 画像から素材を追加</button>
          <input type="file" id="image-file" accept="image/jpeg,image/png,image/webp" hidden>`}
        </div>
      </section>`;
  }

  private get floor() {
    return this.state.plan.floors[this.state.floor];
  }

  private floorTitle(title: string): string {
    return this.state.plan.floors.length > 1 ? `${title} <small>${esc(this.floor.name)}</small>` : title;
  }

  private roomsSection(): string {
    const sel = this.state.selection;
    const items = this.floor.rooms
      .map((r) => `<li><button data-action="select-room" data-value="${esc(r.id)}" class="${sel?.kind === 'room' && sel.id === r.id ? 'on' : ''}">${esc(r.name)}</button></li>`)
      .join('');
    return `<section><h2>${this.floorTitle('部屋')}</h2><ul class="chips">${items}</ul></section>`;
  }

  private addSection(): string {
    const opts = FURNITURE_TYPES.map((t) => `<option value="${t.type}">${esc(t.label)}</option>`).join('');
    const list = this.floor.furniture
      .map((f) => {
        const on = this.state.selection?.kind === 'furniture' && this.state.selection.id === f.id;
        return `<li><button data-action="select-furn" data-value="${esc(f.id)}" class="${on ? 'on' : ''}"><i style="background:${esc(f.color)}"></i>${esc(f.name)}</button></li>`;
      })
      .join('');
    return `
      <section>
        <h2>${this.floorTitle('家具')}</h2>
        <div class="row"><select id="add-type">${opts}</select><button data-action="add-furn">＋ 追加</button></div>
        <ul class="chips">${list}</ul>
      </section>`;
  }

  private walkSection(): string {
    const s = this.state;
    const jump = WEB
      ? `<section><h2>部屋へ移動</h2><select data-change="walk-room"><option value="">（部屋を選ぶ）</option>${s.plan.floors[this.walkFloorIndex()].rooms
          .filter((r) => !r.void && !r.noLabel)
          .map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`)
          .join('')}</select></section>`
      : '';
    return (WEB ? '' : this.switchSection()) + jump + this.walkRoom();
  }

  /** ウォークスルーで立っている階（部屋が分からなければ 1 階） */
  private walkFloorIndex(): number {
    const id = this.state.walkRoomId;
    const i = id ? this.state.plan.floors.findIndex((f) => f.rooms.some((r) => r.id === id)) : -1;
    return Math.max(0, i);
  }

  /** 押したスイッチの回路: つけ消しした照明と、同じ照明をつけ消しできるほかのスイッチ（3 路） */
  private switchSection(): string {
    const p = this.state.pressed;
    if (!p) return `<section><h2>スイッチ</h2><p class="hint">壁のスイッチをクリックすると、つながっている照明がつき消しします（ボタンが複数あるスイッチは、押したボタンの回路）。</p></section>`;
    const plan = this.state.plan;
    const where = (id: string) => {
      for (const f of plan.floors) {
        const x = f.furniture.find((y) => y.id === id);
        if (x) return { floor: f.name, name: x.name.replace('（標準）', '') };
      }
      return { floor: '', name: id };
    };
    const sw = where(p.switchId);
    const c = plan.circuits?.find((x) => x.id === p.circuitId);
    if (!c) return `<section><h2>スイッチ</h2><p>${esc(sw.name)}（上から ${p.button + 1} 番目）は、照明の回路が登録されていません。</p></section>`;
    const lights = c.lights.map((id) => where(id)).map((x) => `<li>${esc(x.floor)}・${esc(x.name)}</li>`).join('');
    const others = c.switches
      .filter((s) => !(s.id === p.switchId && (s.button ?? 0) === p.button))
      .map((s) => ({ ...where(s.id), button: s.button ?? 0 }))
      .map((x) => `<li>${esc(x.floor)}・${esc(x.name)}（上から ${x.button + 1} 番目）</li>`)
      .join('');
    return `
      <section class="switch-info">
        <h2>スイッチ <small>${c.switches.length > 1 ? `3 路（${c.switches.length} か所から操作）` : '1 か所から操作'}</small></h2>
        <h3>${esc(c.name)}：${p.on ? 'つけた' : '消した'}</h3>
        <p class="hint">押したスイッチ: ${esc(sw.floor)}・${esc(sw.name)}（上から ${p.button + 1} 番目）</p>
        ${lights ? `<h3>つけ消しする照明</h3><ul class="walk-items">${lights}</ul>` : '<p class="hint">照明ではない設備の回路です。</p>'}
        ${c.lights.some((id) => plan.floors.some((f) => f.furniture.some((x) => x.id === id && x.sensor))) ? `<p class="hint">人感センサー付きです。スイッチが入っている間、近づく（約 2.5m）とつき、離れて約 10 秒で消えます（実物の消えるまでの時間は設定で 30 秒〜数分）。</p>` : ''}
        ${others ? `<h3>同じ照明をつけ消しできるスイッチ</h3><ul class="walk-items">${others}</ul>` : ''}
      </section>`;
  }

  private walkRoom(): string {
    const s = this.state;
    const found = s.walkRoomId ? s.plan.floors.map((f) => ({ f, r: f.rooms.find((r) => r.id === s.walkRoomId) })).find((x) => x.r) : undefined;
    if (!found?.r) return `<section><h2>今いる場所</h2><p class="hint">部屋の外にいます。</p></section>`;
    const { f: floor, r } = found;
    const row = (label: string, id: string) => `<dt>${label}</dt><dd>${id ? esc(materialLabel(id)) : 'なし'}</dd>`;
    const accents = SIDES.filter(([side]) => r.accent?.[side]).map(([side, label]) => row(`${label}の壁`, r.accent![side]!)).join('');
    // 中心がこの部屋の中にある家具・設備
    const items = floor.furniture
      .filter((x) => pointInPolygon([x.x, x.y], r.polygon))
      .map((x) => `<li>${esc(x.name)}${x.material ? `<small>${esc(materialLabel(x.material))}</small>` : ''}</li>`)
      .join('');
    return `
      <section class="walk-room">
        <h2>今いる場所 <small>${esc(floor.name)}</small></h2>
        <h3>${esc(r.name)}</h3>
        <dl class="finish">${row('床', r.floor)}${row('壁', r.wall)}${accents}${row('天井', r.ceiling)}</dl>
        ${this.tryFinishes()}
        ${items ? `<h3>家具・設備</h3><ul class="walk-items">${items}</ul>` : ''}
        <p class="hint">画面の中央に見えている物の名前と品番は、画面の下に出ます。</p>
      </section>`;
  }

  /** ウォークスルーでクリックした面（壁 1 面・天井・開口部まわり）だけを、候補のクロスに張り替えて見比べる */
  private tryFinishes(): string {
    const p = this.state.picked;
    if (!p) return `<p class="hint">壁・天井・開口部まわりの面・床をクリックすると、その面だけ候補のクロス（床は床材）に張り替えて見比べられます。</p>`;
    const rooms = this.state.plan.floors.flatMap((f) => f.rooms);
    if (p.kind === 'door') return this.tryDoor(p.furnitureId);
    let title = '';
    let current = '';
    if (p.kind === 'zone') {
      const r = rooms.find((x) => x.id === p.roomId);
      const z = r?.zones?.find((x) => x.id === p.zoneId);
      if (!r || !z) return '';
      title = `${r.name}・${z.name}`;
      current = z.material;
    } else if (p.kind === 'cap') {
      title = `${this.state.plan.floors[p.floor]?.name ?? ''}・壁の切れ目の面`;
      current = this.state.plan.floors[p.floor]?.jambs?.[p.capKey] ?? p.materialId;
    } else if (p.kind === 'furniture') {
      const f = this.state.plan.floors.flatMap((x) => x.furniture).find((x) => x.id === p.furnitureId);
      if (!f) return '';
      title = f.name ?? '壁';
      current = f.material ?? '';
    } else if (p.kind === 'jamb') {
      title = '開口部まわりの面';
      current = this.state.plan.floors.flatMap((f) => f.openings).find((o) => o.id === p.openingId)?.jamb ?? p.materialId;
    } else {
      const r = rooms.find((x) => x.id === p.roomId);
      if (!r) return '';
      title = p.kind === 'wall' ? `${r.name}・${SIDES.find(([s]) => s === p.side)?.[1] ?? ''}の壁` : p.kind === 'floor' ? `${r.name}・床` : `${r.name}・天井`;
      current = p.kind === 'wall' ? (r.edges?.[String(p.edge)] ?? p.materialId) : p.kind === 'floor' ? r.floor : r.ceiling;
    }
    const candidates = p.kind === 'floor' ? CANDIDATE_FLOORS : CANDIDATE_WALLPAPERS;
    const options = candidates.map((id) => `<option value="${id}" ${id === current ? 'selected' : ''}>${esc(materialLabel(id))}</option>`).join('');
    const swatch = current && candidates.includes(current) ? `<img class="swatch" src="${swatchUrl(current)}" alt="">` : `<span class="swatch none"></span>`;
    return `
      <h3>${p.kind === 'floor' ? '床を試す' : 'クロスを試す'} <small>${esc(title)}</small></h3>
      <div class="mat-row">${swatch}<select data-walk-finish="1"><option value="">（選ぶ）</option>${options}</select></div>
      <p class="hint">クリックした面だけ張り替わります（ファイルにも保存）。前に戻すときは「↶ 元に戻す」。</p>`;
  }

  /** ウォークスルーでクリックした室内ドアの色柄・取手・枠を、ラフィスの選択肢に変えて見比べる（防火ロールスクリーンは枠とスクリーンの色） */
  private tryDoor(id: string): string {
    const floor = this.state.plan.floors.find((x) => x.furniture.some((f) => f.id === id));
    const f = floor?.furniture.find((x) => x.id === id);
    if (!floor || !f) return '';
    const calm = f.doorSeries === 'calm';
    const chip = (action: string, value: string, label: string, on: boolean, swatch = '') =>
      `<li><button data-action="${action}" data-value="${value}" class="${on ? 'on' : ''}">${swatch}${esc(label)}</button></li>`;
    if (f.type === 'roll-screen' || f.type === 'vertical-blind') {
      const dot = (c: string) => `<span class="swatch" style="display:inline-block;width:14px;height:14px;border:1px solid #999;background:${c};vertical-align:-2px;margin-right:4px"></span>`;
      const colors = SCREEN_COLORS.map(([c, l]) => chip('rs-color', c, l, f.color.toLowerCase() === c, dot(c))).join('');
      const roll = f.type === 'roll-screen';
      return `
      <h3>${roll ? 'ロールスクリーン' : '縦型ブラインド'}を試す <small>${esc(f.name ?? '')}</small></h3>
      <p class="hint">${roll ? 'クリックで下ろす・巻き上げる。' : 'クリックで羽根が回って開く・閉じる。'}商品は未定なので、色は一般的な色から選べます（商品が決まったら、その商品の色に変えます）。選ぶとこの${roll ? 'スクリーン' : 'ブラインド'}だけ変わります（ファイルにも保存）。</p>
      <h3>色</h3><ul class="chips">${colors}</ul>
      <p class="hint">画面の色は実物と違います。最後は実物のサンプルで確かめてください。</p>`;
    }
    if (f.type === 'fire-roll-screen') {
      const dot = (c: string) => `<span class="swatch" style="display:inline-block;width:14px;height:14px;border:1px solid #999;background:${c};vertical-align:-2px;margin-right:4px"></span>`;
      const frames = FIRECUT_FRAMES.map(([c, l]) => chip('fc-frame', c, l, f.color.toLowerCase() === c, dot(c))).join('');
      const scr = f.screen ?? 'frost';
      const screens = ([['shut', 'シャットホワイト（遮光率 99.9%）'], ['mesh', 'メッシュホワイト（遮光率 80.3%）'], ['frost', 'フロストホワイト（遮光率 69%）']] as const).map(([v, l]) => chip('fc-screen', v, l, scr === v)).join('');
      return `
      <h3>防火ロールスクリーンを試す <small>${esc(f.name ?? '')}</small></h3>
      <p class="hint">三協アルミ FIRECUT-RS（ファイアーカット-RS）。図面の「ファイヤーカット【込】」。窓の室内側に付ける防火設備のロールスクリーンです（商品は要確認）。クリックで下ろす・巻き上げる。選ぶとこのスクリーンだけ変わります（ファイルにも保存）。</p>
      <h3>枠の色</h3><ul class="chips">${frames}</ul>
      <h3>スクリーンの色</h3><ul class="chips">${screens}</ul>
      <p class="hint">画面の色は実物と違います。最後は実物のサンプルで確かめてください。</p>`;
    }
    const opening = calm ? undefined : doorFrameOf(floor, f);
    const list = calm ? CALM_COLORS : RAFFIS_COLORS;
    const colors = list.map((m) => chip('door-color', m, materialLabel(m).replace('ラフィス ', '').replace('CALM ', ''), f.material === m, `<img class="swatch" style="width:16px;height:16px" src="${swatchUrl(m)}" alt="">`)).join('');
    const handle = f.handle ?? 'black';
    const handles = ([['black', 'アイアンブラック'], ['nickel', 'シャインニッケル'], ['white', 'プレシャスホワイト']] as const).map(([v, l]) => chip('door-handle', v, l, handle === v)).join('');
    const frame = opening?.frame ?? 'white';
    const frames = opening
      ? ([['white', 'ホワイト（標準）'], ['black', 'ブラック（+2,000円）']] as const).map(([v, l]) => chip('door-frame', v, l, frame === v)).join('')
      : '';
    return `
      <h3>ドアを試す <small>${esc(f.name ?? '')}</small></h3>
      <p class="hint">${calm ? '神谷コーポレーション フルハイトドア CALM（枠の見えないドア）' : 'LIXIL ラフィス'}。${f.material && list.includes(f.material) ? '' : '今は仮の色です。'}選ぶとこのドアだけ変わります（ファイルにも保存）。</p>
      <h3>色柄</h3><ul class="chips">${colors}</ul>
      ${calm ? '<p class="hint">取手は CALM 専用のグレモン錠（ステンレス）だけで、ほかのハンドルは選べません。枠はなく、扉を壁の開口にぴったり合わせています（閉めるとタイト材ですき間がふさがる）。</p>' : `<h3>${f.type === 'swing-door' ? '取手（スクエア M）' : '引手'}</h3><ul class="chips">${handles}</ul>`}
      ${frames ? `<h3>枠</h3><ul class="chips">${frames}</ul>` : ''}
      ${f.type === 'swing-door' && !calm ? this.stopperChips(f, chip) : ''}
      <p class="hint">画面の色は実物と違います。最後は実物のサンプルで確かめてください。</p>`;
  }

  /** 開き戸のドアストッパー（LIXIL ラフィス カタログ p.192）の種類と色 */
  private stopperChips(f: Furniture, chip: (action: string, value: string, label: string, on: boolean, swatch?: string) => string): string {
    const kinds = ([['none', 'なし'], ['secret', 'シークレット（扉に内蔵・床側 1,000 円）'], ['cylinder', 'シリンダー式外付（本体側 2,000 円＋床側 1,000 円）']] as const)
      .map(([v, l]) => chip('door-stopper', v, l, (f.stopper ?? 'none') === v)).join('');
    const dot = (c: string) => `<span class="swatch" style="display:inline-block;width:14px;height:14px;border:1px solid #999;background:${c};vertical-align:-2px;margin-right:4px"></span>`;
    const colors = f.stopper
      ? Object.entries(STOPPER_COLORS).map(([k, [l, c]]) => chip('door-stopper-color', k, l, (f.stopperColor ?? 'BE') === k, dot(c))).join('')
      : '';
    return `<h3>ドアストッパー</h3><ul class="chips">${kinds}</ul>${colors ? `<ul class="chips">${colors}</ul>` : ''}<p class="hint">床の丸い部品（直径 36.4mm）は、扉を 90° 開いた所。扉が壁や家具に当たるのを防ぎ、マグネットで開いたまま仮に止められる。</p>`;
  }

  private warningsSection(): string {
    const w = this.state.warnings;
    if (!w.length) return '';
    return `<section class="warnings"><h2>⚠ 確認してください</h2><ul>${w.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`;
  }

  private helpSection(): string {
    return `
      <section class="help">
        <h2>操作</h2>
        <dl>
          <dt>俯瞰</dt><dd>左ドラッグ: 回転 / 右ドラッグ: 平行移動 / ホイール: ズーム / 床をダブルクリック: その部屋に入る</dd>
          <dt>ウォークスルー</dt><dd>W A S D: 前・左・後ろ・右へ移動（Shift で速く） / 矢印キー ←→: 向きを変える・↑↓: 見上げる・見下ろす / スペース: 画面の真ん中（＋）をクリックしたのと同じ / ドラッグ: 見回す（向きは「見回す向きを逆にする」で変えられます） / Esc: 俯瞰に戻る</dd>
        </dl>
      </section>`;
  }

  private onClick(e: Event) {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const v = btn.dataset.value ?? '';
    const a = this.actions;
    const sel = this.state.selection;
    switch (btn.dataset.action) {
      case 'mode': return a.setMode(v as ViewMode);
      case 'time': return a.setTime(v as TimeOfDay);
      case 'floor-view': return a.setFloorView(v === 'all' ? 'all' : Number(v));
      case 'undo': return a.undo();
      case 'redo': return a.redo();
      case 'screenshot': return a.screenshot();
      case 'export-plan': return a.exportPlan();
      case 'duplicate-plan': return a.duplicatePlan();
      case 'select-room': return a.select({ kind: 'room', id: v });
      case 'select-furn': return a.select({ kind: 'furniture', id: v });
      case 'walk-into': return a.walkInto(v);
      case 'door-color':
      case 'door-handle':
      case 'door-frame': {
        const p = this.state.picked;
        if (p?.kind !== 'door') return;
        if (btn.dataset.action === 'door-color') {
          a.updateFurniture(p.furnitureId, (f) => (f.material = v));
          // CALM は枠も扉の色に合わせる
          if (CALM_HEX[v]) {
            const fl = this.state.plan.floors.find((x) => x.furniture.some((f) => f.id === p.furnitureId));
            const df = fl?.furniture.find((x) => x.id === p.furnitureId);
            const op = fl && df ? doorFrameOf(fl, df) : undefined;
            if (op) a.updateOpening(op.id, (x) => (x.frameColor = CALM_HEX[v]));
          }
          return;
        }
        if (btn.dataset.action === 'door-handle') return a.updateFurniture(p.furnitureId, (f) => (v === 'black' ? delete f.handle : (f.handle = v as Furniture['handle'])));
        const floor = this.state.plan.floors.find((x) => x.furniture.some((f) => f.id === p.furnitureId));
        const f = floor?.furniture.find((x) => x.id === p.furnitureId);
        const o = floor && f ? doorFrameOf(floor, f) : undefined;
        if (o) a.updateOpening(o.id, (x) => (v === 'black' ? (x.frame = 'black') : delete x.frame));
        return;
      }
      case 'door-stopper':
      case 'door-stopper-color': {
        const p = this.state.picked;
        if (p?.kind !== 'door') return;
        if (btn.dataset.action === 'door-stopper') return a.updateFurniture(p.furnitureId, (f) => (v === 'none' ? (delete f.stopper, delete f.stopperColor) : (f.stopper = v as Furniture['stopper'])));
        return a.updateFurniture(p.furnitureId, (f) => (f.stopperColor = v));
      }
      case 'rs-color': {
        const p = this.state.picked;
        if (p?.kind !== 'door') return;
        return a.updateFurniture(p.furnitureId, (f) => (f.color = v));
      }
      case 'fc-frame':
      case 'fc-screen': {
        const p = this.state.picked;
        if (p?.kind !== 'door') return;
        if (btn.dataset.action === 'fc-frame') return a.updateFurniture(p.furnitureId, (f) => (f.color = v));
        return a.updateFurniture(p.furnitureId, (f) => (f.screen = v as Furniture['screen']));
      }
      case 'web-floor': return a.openWebFloor(Number(v));
      case 'add-image': {
        const input = this.el.querySelector<HTMLInputElement>('#image-file')!;
        input.onchange = () => input.files?.[0] && a.addImageMaterial(input.files[0]);
        input.click();
        return;
      }
      case 'add-furn': return a.addFurniture((this.el.querySelector('#add-type') as HTMLSelectElement).value);
      case 'rotate':
        if (sel?.kind === 'furniture') a.updateFurniture(sel.id, (f) => (f.rotation = (f.rotation + Number(v)) % 360));
        return;
      case 'dup-furn':
        if (sel?.kind === 'furniture') a.duplicateFurniture(sel.id);
        return;
      case 'remove-furn':
        if (sel?.kind === 'furniture') a.removeFurniture(sel.id);
        return;
    }
  }

  private onChange(e: Event) {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const a = this.actions;
    const sel = this.state.selection;
    const d = t.dataset;
    if (d.change === 'plan') return a.switchPlan(t.value);
    if (d.change === 'cutaway') return a.setCutaway((t as HTMLInputElement).checked);
    if (d.change === 'labels') return a.setLabels((t as HTMLInputElement).checked);
    if (d.change === 'lights') return a.setLightsOn((t as HTMLInputElement).checked);
    if (d.change === 'hq') return a.setHighQuality((t as HTMLInputElement).checked);
    if (d.change === 'invert') return a.setInvertLook((t as HTMLInputElement).checked);
    if (d.change === 'walk-room') {
      // 選んだらすぐキーで歩けるよう、欄から外す
      t.blur();
      if (t.value) a.walkInto(t.value);
      return;
    }
    if (d.change === 'stature') {
      const cm = Math.round(Number(t.value));
      if (cm >= 80 && cm <= 220) a.setStature(cm);
      return;
    }
    const picked = this.state.picked;
    if (d.walkFinish && t.value && picked) {
      const id = t.value;
      // キー操作で歩けるよう、選んだらフォーカスを外す
      t.blur();
      if (picked.kind === 'zone') {
        const { zoneId } = picked;
        a.updateRoom(picked.roomId, (r) => {
          const z = r.zones?.find((x) => x.id === zoneId);
          if (z) z.material = id;
        });
      } else if (picked.kind === 'cap') {
        const { floor, capKey } = picked;
        a.updateFloor(floor, (f) => (f.jambs = { ...(f.jambs ?? {}), [capKey]: id }));
      } else if (picked.kind === 'furniture') {
        a.updateFurniture(picked.furnitureId, (f) => (f.material = id));
      } else if (picked.kind === 'jamb') {
        a.updateOpening(picked.openingId, (o) => (o.jamb = id));
      } else if (picked.kind === 'ceiling') {
        a.updateRoom(picked.roomId, (r) => r.ceiling && (r.ceiling = id));
      } else if (picked.kind === 'floor') {
        a.updateRoom(picked.roomId, (r) => (r.floor = id));
      } else if (picked.kind === 'wall') {
        // クリックした壁 1 面だけ（部屋の壁・アクセントと同じなら指定を消す）
        const { side, edge } = picked;
        a.updateRoom(picked.roomId, (r) => {
          const edges = { ...(r.edges ?? {}) };
          const base = r.accent?.[side] ?? r.wall;
          if (id === base) delete edges[String(edge)];
          else edges[String(edge)] = id;
          if (Object.keys(edges).length) r.edges = edges;
          else delete r.edges;
        });
      }
      return;
    }
    if (sel?.kind === 'furniture' && 'furnFlip' in d) {
      const on = (t as HTMLInputElement).checked;
      a.updateFurniture(sel.id, (f) => (on ? (f.flip = true) : delete f.flip));
      return;
    }
    if (sel?.kind === 'furniture' && d.furn) {
      const field = d.furn as keyof Furniture;
      const value = t.type === 'number' ? Number(t.value) : t.value;
      if (typeof value === 'number' && !Number.isFinite(value)) return;
      a.updateFurniture(sel.id, (f) => ((f as unknown as Record<string, unknown>)[field] = value));
      return;
    }
    if (sel?.kind === 'room' && d.room) {
      const field = d.room as 'name' | 'floor' | 'wall' | 'ceiling';
      a.updateRoom(sel.id, (r) => (r[field] = t.value));
      return;
    }
    if (sel?.kind === 'room' && d.accent) {
      const side = d.accent as Side;
      a.updateRoom(sel.id, (r) => {
        const accent = { ...(r.accent ?? {}) };
        if (t.value) accent[side] = t.value;
        else delete accent[side];
        if (Object.keys(accent).length) r.accent = accent;
        else delete r.accent;
      });
    }
  }
}

/** 開き戸の扉の、枠のある開口部（同じ階の type: 'door' で、中心が扉の中心の近く） */
function doorFrameOf(floor: Plan['floors'][number], f: Furniture): Opening | undefined {
  if (f.type !== 'swing-door') return undefined;
  return floor.openings.find((o) => o.type === 'door' && Math.hypot(o.at[0] - f.x, o.at[1] - f.y) < 150);
}
