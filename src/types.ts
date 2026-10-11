// 間取りデータの型。plans/*.json はこの形で書く。
// 座標はすべて mm。平面図で x = 右（東）、y = 下（南）。

export type Point = [number, number];

export type Side = 'north' | 'east' | 'south' | 'west';

export interface Room {
  id: string;
  name: string;
  /** 壁芯で囲んだ部屋の外形（時計回りでも反時計回りでもよい） */
  polygon: Point[];
  /** 床材の素材ID */
  floor: string;
  /** 壁クロスの素材ID */
  wall: string;
  /** 天井クロスの素材ID */
  ceiling: string;
  /** 面ごとのアクセントクロス（例: { "north": "cross-navy" }） */
  accent?: Partial<Record<Side, string>>;
}

export type OpeningType = 'window' | 'door' | 'opening';

export interface Opening {
  id: string;
  type: OpeningType;
  /** 開口部の中心点（壁芯の上の点） */
  at: Point;
  width: number;
  height: number;
  /** 床から開口部下端までの高さ（ドア・掃き出し窓は 0） */
  sill: number;
}

export interface Furniture {
  id: string;
  /** 形の種類（furniture.ts の FURNITURE_TYPES を参照） */
  type: string;
  name: string;
  /** 家具の中心点 */
  x: number;
  y: number;
  /** 幅・奥行き・高さ */
  w: number;
  d: number;
  h: number;
  /** 平面図で時計回りの角度（度）。0 のとき正面が南（下）を向く */
  rotation: number;
  color: string;
}

export interface Plan {
  name: string;
  /** グリッドの間隔（尺モジュールなら 910） */
  grid: number;
  /** 天井高 */
  ceilingHeight: number;
  /** 壁の厚さ */
  wallThickness: number;
  /** 外壁の素材ID */
  exterior: string;
  rooms: Room[];
  openings: Opening[];
  furniture: Furniture[];
}
