// 右側の操作パネル。状態から HTML を作り直し、操作は data-action で受け取る。

import { WEB } from './env';
import { FURNITURE_TYPES, getFurnitureType } from './furniture';
import { pointInPolygon } from './geometry';
import { CANDIDATE_FLOORS, CANDIDATE_WALLPAPERS, getMaterialDef, materialsFor, swatchUrl, type MaterialCategory } from './materials';
import type { SaveStatus } from './store';
import type { Furniture, Opening, Plan, Room, Side } from './types';
import type { TimeOfDay, ViewMode, WalkTarget } from './viewer';

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
  picked: { kind: 'wall'; roomId: string; edge: number; side: Side; materialId: string } | { kind: 'ceiling' | 'floor'; roomId: string } | { kind: 'jamb'; openingId: string; materialId: string } | { kind: 'furniture'; furnitureId: string } | null;
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
        ? seg('floor-view', [...floors.map((f, i): [string, string] => [String(i), f.name]), ['all', '外観']], s.mode === 'walk' ? '' : String(s.floorView))
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
    let title = '';
    let current = '';
    if (p.kind === 'furniture') {
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
          <dt>ウォークスルー</dt><dd>W A S D・矢印キー: 移動（Shift で速く） / ドラッグ: 見回す（向きは「見回す向きを逆にする」で変えられます） / Esc: 俯瞰に戻る</dd>
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
      if (picked.kind === 'furniture') {
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
