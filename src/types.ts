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
  /** 部屋名を図面と 3D に出さない（隣の部屋の一部のような小さな区切り） */
  noLabel?: boolean;
  /** 壁 1 面ごとのクロス（キーは polygon の辺の番号。i 番目の点から i+1 番目の点への辺）。accent・wall より優先 */
  edges?: Record<string, string>;
  /** 巾木を付けない（浴室・車庫・ポーチなど） */
  noBaseboard?: boolean;
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
  /** 窓の種類。fix は開かない窓（障子なし）。省略時は横長なら横すべり出し、それ以外は引き違い／縦長 */
  style?: 'fix' | 'slide';
  /** 開口部まわりの面（壁の厚みの面）のクロス。省略時は隣の壁と同じ */
  jamb?: string;
  /** 片引き戸の戸袋。戸がある部屋（slideRoom）の側の壁を、戸を引く向き（slideTo）に開口部の幅だけ slideDepth（既定 40）削る */
  slideRoom?: string;
  slideTo?: Side;
  slideDepth?: number;
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
  /** 面材の素材ID（大理石調のカウンターなど）。指定すると color の代わりにこの素材を貼る */
  material?: string;
  /** 左右を反転する（引き戸・開き戸の取手を反対側にするなど） */
  flip?: boolean;
  /** 数の指定がある家具で使う（可動棚の棚板の枚数、ロッドの本数など） */
  count?: number;
  /** キッチンの下台の扉・引出しの割り付け（左からの幅。負の数は 1 枚扉、60 未満はフィラー） */
  modules?: number[];
  /** 片引き戸（壁を削った戸袋に引き込む）。レールや床のガイドは枠・戸袋の中で見えない */
  pocket?: boolean;
  /** 開き戸の開く向き。1 = 正面（+z）の側へ開く（省略時）、-1 = 背面の側へ開く */
  swing?: 1 | -1;
  /** 両開きの扉の開く角度（度）。[正面から見て左の扉, 右の扉]。省略時は 105°（鏡などに当たる側は開き角度制限付きの丁番で 90° にする） */
  doorAngles?: [number, number];
  /** 照明の明るさ（全光束 lm）。製品の定格光束。省略時は器具の種類ごとの目安 */
  lumen?: number;
  /** 照明の光の広がり（度）。省略時は器具の種類ごとの目安 */
  beam?: number;
  /** 照明の色温度（K）。2700 = 電球色、3500 = 温白色、5000 = 昼白色 */
  kelvin?: number;
  /** 人感センサー付きの照明。スイッチが入っていても、ウォークスルーで近づいた時だけつき、離れると少しして消える */
  sensor?: boolean;
  /** L 字ソファのカウチの前への出幅（mm） */
  chaise?: number;
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
  /** この階の外壁の素材ID（省略時は plan.exterior） */
  exterior?: string;
  rooms: Room[];
  openings: Opening[];
  furniture: Furniture[];
}

export type MaterialCategory = 'floor' | 'wall' | 'exterior';

/** 画像から作る素材（メーカーの見本画像など）。画像は public/textures/ に置く */
export interface CustomMaterial {
  /** 素材ID（room.floor などで指定する） */
  id: string;
  /** パネルに出す名前（品番など） */
  name: string;
  categories: MaterialCategory[];
  /** public/ からの相対パス（例: "textures/SP2540.jpg"） */
  image: string;
  /** 画像1枚が表す実寸 [横, 縦] mm */
  tile: [number, number];
  /** 表面の粗さ 0（つやあり）〜1（つやなし）。省略時 0.9 */
  roughness?: number;
  /** 凹凸の強さ。省略時 1.5、0 で平ら */
  bump?: number;
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
  /** 画像から作った素材 */
  materials?: CustomMaterial[];
  floors: Floor[];
  /** 照明の回路（どのスイッチでどの照明がつくか）。2 か所以上のスイッチがある回路は 3 路スイッチ */
  circuits?: Circuit[];
}

/** 照明の回路。lights の照明を、switches のどのスイッチからでもつけ消しできる */
export interface Circuit {
  id: string;
  name: string;
  /** つけ消しする照明（家具の id）。換気扇など照明でない物の回路は空 */
  lights: string[];
  /** この回路のスイッチ。button は何番目のスイッチか（0 が一番上） */
  switches: { id: string; button?: number }[];
}
