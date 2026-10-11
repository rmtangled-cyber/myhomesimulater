// 間取りデータの型。plans/*.json はこの形で書く。
// 座標はすべて mm。平面図で x = 右（東）、y = 下（南）。高さは各階の床（FL）が 0。

export type Point = [number, number];

export type Side = 'north' | 'east' | 'south' | 'west';

export interface Room {
  /** すべての階を通して重ならない ID */
  id: string;
  name: string;
  /** 壁芯で囲んだ部屋の外形（時計回りでも反時計回りでもよい） */
  polygon: Point[];
  /** 床材の素材ID */
  floor: string;
  /** 壁クロスの素材ID */
  wall: string;
  /** 天井クロスの素材ID。空文字なら天井なし（上が吹き抜け・階段のとき） */
  ceiling: string;
  /** 面ごとのアクセントクロス（例: { "north": "cross-navy" }） */
  accent?: Partial<Record<Side, string>>;
  /** この階の FL からの床の高さ（土間・車庫は −150 や −560 など） */
  level?: number;
  /** 天井高（省略時は階の ceilingHeight）。床（level）から測る */
  ceilingHeight?: number;
  /** 床を張らない（階段の吹き抜けなど） */
  void?: boolean;
}

export type OpeningType = 'window' | 'door' | 'opening';

export interface Opening {
  id: string;
  type: OpeningType;
  /** 開口部の中心点（壁芯の上の点） */
  at: Point;
  width: number;
  height: number;
  /** この階の FL から開口部下端までの高さ（ドア・掃き出し窓は 0） */
  sill: number;
}

export interface Furniture {
  /** すべての階を通して重ならない ID */
  id: string;
  /** 形の種類（furniture.ts の FURNITURE_TYPES を参照） */
  type: string;
  name: string;
  /** 家具の中心点 */
  x: number;
  y: number;
  /** この階の FL から置く高さ（車庫の車なら −560 など）。省略時は 0 */
  z?: number;
  /** 幅・奥行き・高さ */
  w: number;
  d: number;
  h: number;
  /** 平面図で時計回りの角度（度）。0 のとき正面が南（下）を向く */
  rotation: number;
  color: string;
}

export interface Floor {
  id: string;
  name: string;
  /** 1階の FL からこの階の FL までの高さ */
  elevation: number;
  /** 階高（この階の FL から上の階の FL まで） */
  height: number;
  /** 標準の天井高 */
  ceilingHeight: number;
  rooms: Room[];
  openings: Opening[];
  furniture: Furniture[];
}

export interface Plan {
  name: string;
  /** グリッドの間隔（尺モジュールなら 910） */
  grid: number;
  /** 壁の厚さ */
  wallThickness: number;
  /** 外壁の素材ID */
  exterior: string;
  /** 地面（GL）の高さ。1階 FL からの差で、ふつうは負の値 */
  groundLevel?: number;
  floors: Floor[];
}
