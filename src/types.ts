// 間取りデータの型。plans/*.json はこの形で書く。
// 座標はすべて mm。平面図で x = 右（東）、y = 下（南）。高さは各階の床（FL）が 0。

export type Point = [number, number];

export type Side = 'north' | 'east' | 'south' | 'west';

/** 壁 1 面のうち、ある範囲だけ別のクロスを貼る所（キッチンの背面の、下がり天井の端から端まで など） */
/** 開口部まわりの面の部分。a・b は左右の側面、h は上（と窓の下）の面 */
export type JambPart = 'a' | 'b' | 'h';

export interface WallZone {
  id: string;
  name: string;
  /** polygon の辺の番号 */
  edge: number;
  /** 範囲の両端（平面図の座標。辺の上に投影して使う） */
  start: Point;
  end: Point;
  material: string;
}

export interface Room {
  /** 壁の一部だけ別のクロスを貼る所（クリックで張り替えられる） */
  zones?: WallZone[];
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
  /** 開口部まわりの面（壁の厚みの面）のクロス。省略時は壁の厚みの真ん中で分けて、それぞれの側の部屋の壁のクロス */
  jamb?: string;
  /** 開口部まわりの面を 1 面ずつ。キーは「面|側の部屋 ID」（面は a = 壁の線の始まりの側の側面、b = 終わりの側の側面、h = 上・下の面。
   *  壁の厚みの真ん中で分けた、その部屋の側の半分）か、面だけ（両側の半分とも）。jamb より優先 */
  jambFaces?: Record<string, string>;
  /** 室内ドアの枠の色（ラフィスのライン枠。白が標準、黒はオプション） */
  frame?: 'white' | 'black' | 'none' | 'calm';
  /** frame: 'calm'（KAMIYA CALM の細い枠と天井の上枠）の色。扉の色に合わせる */
  frameColor?: string;
  /** 片引き戸の戸袋。戸がある部屋（slideRoom）の側の壁を、戸を引く向き（slideTo）に開口部の幅だけ slideDepth（既定 40）削る */
  slideRoom?: string;
  slideTo?: Side;
  slideDepth?: number;
  /** 戸袋の長さ（既定は開口部の幅 + 80）。壁が足りないときに短くする */
  slideLength?: number;
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
  /** kitchen-cabinet: 引出しではなく開き戸（1 モジュール 1 枚。左半分は左吊り、右半分は右吊り） */
  hinged?: boolean;
  /** 引き戸: 開けたときに動く長さ（既定は戸の幅 − 60）。戸袋が短いとき */
  travel?: number;
  /** resin-shelf: 棚板の枚数（横に何枚に分けるか）。省略時は幅 800 ごと */
  boards?: number;
  /**
   * kitchen-cabinet: モジュールごとの前板の高さ（上から mm）。正 = 引出し、負 = 開かない板（シンクの前の幕板など）、0 = そこから下は扉のない空洞（シンク下のフリースペース）。
   * 合計が h に足りない分は足元の台輪（奥へ引っ込む）。合計が h なら床まで（フロアスライド）。モジュールの数だけ並べる（フィラーの分は空の配列でよい）
   */
  fronts?: number[][];
  /** lighting-rail に吊るす器具: spot（スポットライト・省略時）・pendant（ペンダントライト） */
  fixture?: 'spot' | 'pendant';
  /** fire-roll-screen（三協アルミ FIRECUT-RS）のスクリーン色。省略時は frost */
  screen?: 'shut' | 'mesh' | 'frost';
  /** 開き戸のドアストッパー（LIXIL ラフィス）。secret = シークレットドアストッパー（扉の下に内蔵・床に丸い部品）、cylinder = シリンダー式外付ドアストッパー（扉の下に小さな箱） */
  stopper?: 'secret' | 'cylinder';
  /** ドアストッパーの色（商品コードの頭 2 文字: YY・AC・AD・MM・DD・RA・BD・BE） */
  stopperColor?: string;
  /** 片引き戸（壁を削った戸袋に引き込む）。レールや床のガイドは枠・戸袋の中で見えない */
  pocket?: boolean;
  /** 開き戸の開く向き。1 = 正面（+z）の側へ開く（省略時）、-1 = 背面の側へ開く */
  swing?: 1 | -1;
  /** 両開きの扉の開く角度（度）。[正面から見て左の扉, 右の扉]。省略時は 105°（鏡などに当たる側は開き角度制限付きの丁番で 90° にする） */
  doorAngles?: [number, number];
  /** 扉の取手・引手の色（ラフィス: アイアンブラック・シャインニッケル・プレシャスホワイト） */
  handle?: 'black' | 'nickel' | 'white';
  /** 室内ドアの商品シリーズ（ウォークスルーの「ドアを試す」の色の候補）。省略時は LIXIL ラフィス、calm は神谷コーポレーション フルハイトドア CALM */
  doorSeries?: 'raffis' | 'calm';
  /** コンセントに有線 LAN のポート（モジュラージャック）を付ける */
  lan?: boolean;
  /** ケージなどに上から掛ける布の面（家具の向きで: top・back（背面）・left（正面から見て右手…ではなく家具の −x 側）・right） */
  coverSides?: ('top' | 'back' | 'left' | 'right')[];
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
  /** 壁の切れ目の面（開口部に属さない、壁の厚みの面）のクロス。キーは面の位置（"x,y"、その面の側の 20mm 外の点を 10mm 単位で丸めた座標） */
  jambs?: Record<string, string>;
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
  /** 壁の厚さ（壁芯から両側へ半分ずつ。室内側の面はここまで） */
  wallThickness: number;
  /**
   * 外壁の外側に足す厚み（mm）。外に面した壁だけ、外の面を壁の厚みの半分よりさらに外へ出す
   * （構造用面材・通気胴縁・外壁材のぶん）。窓のサッシは外寄りに付く
   */
  claddingThickness?: number;
  /** 外壁の素材ID */
  exterior: string;
  /** 地面（GL）の高さ。1階 FL からの差で、ふつうは負の値 */
  groundLevel?: number;
  /** 画像から作った素材 */
  materials?: CustomMaterial[];
  floors: Floor[];
  /** 照明の回路（どのスイッチでどの照明がつくか）。2 か所以上のスイッチがある回路は 3 路スイッチ */
  circuits?: Circuit[];
  /** 屋根（片流れ）。壁の上にかぶせ、低い側の軒先に雨どいを付ける */
  roofs?: Roof[];
  /** 基礎の高さ（GL から、ふつう 400）。1 階の外壁の下に基礎と土台水切りを描く */
  foundationHeight?: number;
}

/** 片流れの屋根 */
export interface Roof {
  id: string;
  /** どの階の上にかぶせるか（floors の番号） */
  floor: number;
  /** 屋根をかける範囲（壁芯の外形） */
  polygon: Point[];
  /** 低い側（雨どいの側） */
  low: Side;
  /** 勾配（0.05 = 0.5/10） */
  slope: number;
  /** 軒の出（壁の外の面から、mm） */
  eave: number;
  /** 屋根の厚み（鼻隠しの高さ） */
  thickness: number;
  material: string;
  /** 竪樋の位置（平面図の座標）。下に低い屋根があればそこまで、なければ地面まで */
  downpipes?: Point[];
  /** 太陽光パネル。屋根の真ん中に cols × rows 枚を並べる（屋根の勾配なりに、屋根から 100 浮かせる） */
  solar?: {
    name: string;
    /** パネル 1 枚の寸法 [幅, 長さ, 厚み]（mm）。長さを屋根の流れの向きに置く */
    size: [number, number, number];
    cols: number;
    rows: number;
    /** パネルどうしのすき間（mm） */
    gap?: number;
  };
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
