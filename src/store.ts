// 編集中の間取りを持ち、保存・元に戻す・外部の変更の読み込みを受け持つ。

import { WEB } from './env';
import type { Plan } from './types';

export type SaveStatus = 'saved' | 'saving' | 'error' | 'reloaded';

type Listener = (plan: Plan, cause: 'edit' | 'load') => void;

export class PlanStore {
  plan!: Plan;
  name = '';
  private listeners: Listener[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** 最後にサーバーと一致していた内容。自分の保存による変更通知を無視するのに使う */
  private lastSynced = '';
  private saveTimer: number | undefined;
  onStatus: (s: SaveStatus, message?: string) => void = () => {};

  subscribe(fn: Listener) {
    this.listeners.push(fn);
  }

  private emit(cause: 'edit' | 'load') {
    for (const fn of this.listeners) fn(this.plan, cause);
  }

  async list(): Promise<string[]> {
    if (WEB) return ['my-house'];
    const res = await fetch('/api/plans');
    return res.json();
  }

  async load(name: string) {
    let text: string;
    if (WEB) {
      // Web 版はビルドに埋め込んだ間取りを使う
      text = JSON.stringify((await import('../plans/my-house.json')).default);
    } else {
      const res = await fetch(`/api/plans/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`${name} を読み込めませんでした (${res.status})`);
      text = await res.text();
    }
    this.name = name;
    this.plan = JSON.parse(text) as Plan;
    this.lastSynced = JSON.stringify(this.plan);
    this.undoStack = [];
    this.redoStack = [];
    this.emit('load');
  }

  /** ファイルが外で書き換えられたときに呼ぶ。中身が同じなら何もしない */
  async reloadIfChanged() {
    const res = await fetch(`/api/plans/${encodeURIComponent(this.name)}`);
    if (!res.ok) return;
    let next: Plan;
    try {
      next = JSON.parse(await res.text());
    } catch {
      this.onStatus('error', 'ファイルの JSON が壊れています（直るまで前の状態を表示します）');
      return;
    }
    const json = JSON.stringify(next);
    if (json === this.lastSynced) return;
    // 自分の保存が書き込まれただけ（保存の応答より先に通知が届くことがある）
    if (json === JSON.stringify(this.plan)) {
      this.lastSynced = json;
      return;
    }
    this.undoStack.push(JSON.stringify(this.plan));
    this.redoStack = [];
    this.plan = next;
    this.lastSynced = json;
    this.onStatus('reloaded');
    this.emit('load');
  }

  /** 間取りを変更する。fn の中で plan を直接書き換えてよい */
  edit(fn: (plan: Plan) => void) {
    this.undoStack.push(JSON.stringify(this.plan));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    fn(this.plan);
    this.emit('edit');
    this.scheduleSave();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.plan));
    this.plan = JSON.parse(prev);
    this.emit('edit');
    this.scheduleSave();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.plan));
    this.plan = JSON.parse(next);
    this.emit('edit');
    this.scheduleSave();
  }

  private scheduleSave() {
    this.onStatus('saving');
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(this.name), 400);
  }

  async save(name: string) {
    // Web 版は保存しない（試した変更はその画面の中だけ）
    if (WEB) return this.onStatus('saved');
    const json = JSON.stringify(this.plan);
    try {
      const res = await fetch(`/api/plans/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      });
      if (!res.ok) throw new Error(String(res.status));
      if (name === this.name) this.lastSynced = json;
      this.onStatus('saved');
    } catch (e) {
      this.onStatus('error', `保存できませんでした: ${(e as Error).message}`);
    }
  }

  /** 今の内容を別名で保存して、そちらに切り替える（案の複製） */
  async saveAs(name: string) {
    window.clearTimeout(this.saveTimer);
    this.plan.name = name;
    await this.save(name);
    await this.load(name);
  }
}
