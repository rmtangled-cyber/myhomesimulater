// 右側の操作パネル。状態から HTML を作り直し、操作は data-action で受け取る。

import { FURNITURE_TYPES, getFurnitureType } from './furniture';
import { materialsFor, swatchUrl, type MaterialCategory } from './materials';
import type { SaveStatus } from './store';
import type { Furniture, Plan, Room, Side } from './types';
import type { TimeOfDay, ViewMode } from './viewer';

export type Selection = { kind: 'furniture'; id: string } | { kind: 'room'; id: string } | null;

export interface PanelState {
  plan: Plan;
  planName: string;
  plans: string[];
  selection: Selection;
  mode: ViewMode;
  time: TimeOfDay;
  cutaway: boolean;
  labels: boolean;
  status: SaveStatus;
  statusMessage?: string;
  warnings: string[];
}

export interface PanelActions {
  setMode(mode: ViewMode): void;
  setTime(time: TimeOfDay): void;
  setCutaway(on: boolean): void;
  setLabels(on: boolean): void;
  switchPlan(name: string): void;
  duplicatePlan(): void;
  select(sel: Selection): void;
  walkInto(roomId: string): void;
  updateRoom(id: string, fn: (r: Room) => void): void;
  updateFurniture(id: string, fn: (f: Furniture) => void): void;
  addFurniture(type: string): void;
  duplicateFurniture(id: string): void;
  removeFurniture(id: string): void;
  screenshot(): void;
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
    this.el.innerHTML = [this.header(), this.viewSection(), this.selectionSection(), this.roomsSection(), this.addSection(), this.warningsSection(), this.helpSection()].join('');
    this.el.scrollTop = scroll;
  }

  private header(): string {
    const s = this.state;
    const opts = s.plans.map((p) => `<option value="${esc(p)}" ${p === s.planName ? 'selected' : ''}>${esc(p)}</option>`).join('');
    return `
      <header>
        <h1>${esc(s.plan.name)}</h1>
        <div class="row">
          <select data-change="plan" title="間取り案を切り替え">${opts}</select>
          <button data-action="duplicate-plan" title="今の案をコピーして新しい案を作る">案を複製</button>
        </div>
        <div class="status ${s.status}">${STATUS_TEXT[s.status]}${s.statusMessage ? `：${esc(s.statusMessage)}` : ''}</div>
      </header>`;
  }

  private viewSection(): string {
    const s = this.state;
    const seg = (group: string, items: [string, string][], current: string) =>
      `<div class="seg">${items.map(([v, l]) => `<button data-action="${group}" data-value="${v}" class="${v === current ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    return `
      <section>
        <h2>表示</h2>
        ${seg('mode', [['orbit', '俯瞰'], ['walk', 'ウォークスルー']], s.mode)}
        ${seg('time', [['day', '昼'], ['evening', '夕方'], ['night', '夜（照明）']], s.time)}
        <div class="row">
          <label><input type="checkbox" data-change="cutaway" ${s.cutaway ? 'checked' : ''}> 壁を低く切る</label>
          <label><input type="checkbox" data-change="labels" ${s.labels ? 'checked' : ''}> 部屋名</label>
        </div>
        <div class="row">
          <button data-action="undo" title="Ctrl+Z">↶ 元に戻す</button>
          <button data-action="redo" title="Ctrl+Shift+Z">↷ やり直す</button>
          <button data-action="screenshot">📷 画像を保存</button>
        </div>
      </section>`;
  }

  private selectionSection(): string {
    const sel = this.state.selection;
    if (!sel) return `<section class="selected empty"><h2>選択中</h2><p class="hint">家具や床をクリックすると、ここで編集できます。</p></section>`;
    if (sel.kind === 'furniture') {
      const f = this.state.plan.furniture.find((x) => x.id === sel.id);
      return f ? this.furnitureEditor(f) : '';
    }
    const r = this.state.plan.rooms.find((x) => x.id === sel.id);
    return r ? this.roomEditor(r) : '';
  }

  private furnitureEditor(f: Furniture): string {
    const num = (field: keyof Furniture, label: string, step = 10) =>
      `<label class="num">${label}<input type="number" step="${step}" data-furn="${field}" value="${f[field]}"></label>`;
    return `
      <section class="selected">
        <h2>選択中の家具 <small>${esc(getFurnitureType(f.type).label)}</small></h2>
        <label class="wide">名前<input type="text" data-furn="name" value="${esc(f.name)}"></label>
        <div class="grid3">
          ${num('x', 'X（東へ）')}${num('y', 'Y（南へ）')}${num('rotation', '回転°', 15)}
          ${num('w', '幅')}${num('d', '奥行')}${num('h', '高さ')}
        </div>
        <div class="row">
          <label class="color">色 <input type="color" data-furn="color" value="${esc(f.color)}"></label>
          <button data-action="rotate" data-value="90">↻ 90°</button>
          <button data-action="dup-furn">複製</button>
          <button data-action="remove-furn" class="danger">削除</button>
        </div>
        <p class="hint">ドラッグで移動、R で90°回転、Delete で削除。単位は mm。</p>
      </section>`;
  }

  private roomEditor(r: Room): string {
    return `
      <section class="selected">
        <h2>選択中の部屋</h2>
        <label class="wide">名前<input type="text" data-room="name" value="${esc(r.name)}"></label>
        <h3>床</h3>${materialSelect('floor', r.floor, 'data-room="floor"')}
        <h3>壁</h3>${materialSelect('wall', r.wall, 'data-room="wall"')}
        <h3>天井</h3>${materialSelect('wall', r.ceiling, 'data-room="ceiling"')}
        <h3>アクセントクロス</h3>
        ${SIDES.map(([side, label]) => `<div class="accent"><span>${label}の壁</span>${materialSelect('wall', r.accent?.[side] ?? '', `data-accent="${side}"`, true)}</div>`).join('')}
        <div class="row"><button data-action="walk-into" data-value="${esc(r.id)}">この部屋に入る</button></div>
      </section>`;
  }

  private roomsSection(): string {
    const sel = this.state.selection;
    const items = this.state.plan.rooms
      .map((r) => `<li><button data-action="select-room" data-value="${esc(r.id)}" class="${sel?.kind === 'room' && sel.id === r.id ? 'on' : ''}">${esc(r.name)}</button></li>`)
      .join('');
    return `<section><h2>部屋</h2><ul class="chips">${items}</ul></section>`;
  }

  private addSection(): string {
    const opts = FURNITURE_TYPES.map((t) => `<option value="${t.type}">${esc(t.label)}</option>`).join('');
    const list = this.state.plan.furniture
      .map((f) => {
        const on = this.state.selection?.kind === 'furniture' && this.state.selection.id === f.id;
        return `<li><button data-action="select-furn" data-value="${esc(f.id)}" class="${on ? 'on' : ''}"><i style="background:${esc(f.color)}"></i>${esc(f.name)}</button></li>`;
      })
      .join('');
    return `
      <section>
        <h2>家具</h2>
        <div class="row"><select id="add-type">${opts}</select><button data-action="add-furn">＋ 追加</button></div>
        <ul class="chips">${list}</ul>
      </section>`;
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
          <dt>ウォークスルー</dt><dd>W A S D・矢印キー: 移動（Shift で速く） / ドラッグ: 見回す</dd>
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
      case 'undo': return a.undo();
      case 'redo': return a.redo();
      case 'screenshot': return a.screenshot();
      case 'duplicate-plan': return a.duplicatePlan();
      case 'select-room': return a.select({ kind: 'room', id: v });
      case 'select-furn': return a.select({ kind: 'furniture', id: v });
      case 'walk-into': return a.walkInto(v);
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
