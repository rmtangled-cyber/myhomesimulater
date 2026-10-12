# マイホームシミュレーター

注文住宅の間取り・床材・クロス・家具を、ブラウザの 3D で試しながら決めるためのアプリ。
ユーザーと Claude が **同じ間取りファイル（`plans/*.json`）を一緒に編集する** のが基本の使い方。

## 構成

- Vite + TypeScript + three.js（フレームワークなし）。`npm run dev` で起動
- `plans/*.json` — 間取りデータ。1ファイル = 1つの案。**唯一の正しいデータ**
- `vite.config.ts` — `plans/` を読み書きする開発サーバー API（`/api/plans`）。ファイルの変更を検知してブラウザへ通知する
- `src/types.ts` — 間取りデータの型
- `src/builder.ts` — 間取りデータ → 3D モデル（壁・開口部・床・天井・クロス・家具）
- `src/geometry.ts` — 部屋の外形から壁を求める計算など
- `src/materials.ts` — 素材カタログ（テクスチャはキャンバスで生成し、実寸で貼る）
- `src/furniture.ts` — 家具の種類と形
- `src/viewer.ts` — カメラ・照明・マウス操作
- `src/store.ts` — 保存・元に戻す・外部の変更の読み込み
- `src/ui.ts` — 右側の操作パネル

## 間取りファイルの書き方

- 単位はすべて **mm**。平面図の座標で **x = 右（東）**、**y = 下（南）**。原点は左上（北西）。全部の階で同じ座標を使う
  - 「北・東・南・西」は図面の上・右・下・左のこと（実際の方位とずれていてもよい）
- `floors[]` が階。`elevation` は 1階 FL からの床の高さ、`height` は階高（上の階の FL まで）、`ceilingHeight` は標準の天井高
- `groundLevel` は地面（GL）の高さを 1階 FL からの差で書く（基礎が 560 なら `-560`）
- 外壁は `exterior`（全体）。階ごとに違うときは `floors[].exterior` で上書きする
- グリッドは 910mm（尺モジュール）。部屋の頂点はなるべく 910 の倍数（455 の倍数）にそろえる
- **壁は書かない**。各階の `rooms[].polygon`（壁芯で囲んだ外形）の辺から自動で作られる。隣り合う部屋は辺を共有させる
- 部屋どうしの間に壁を作りたくない場合は、そこに `type: "opening"` の開口部を置く（`height` を階高にすると梁も消える）
- 部屋の `id` と家具の `id` は **全部の階を通して重ならない** ようにする（`1f-hall`、`sofa-2` など）
- 部屋のオプション
  - `level`: 階の FL からの床の高さ（玄関土間 `-150`、車庫 `-560` など）
  - `ceilingHeight`: その部屋だけ天井高が違うとき（`level` から測る）
  - `ceiling: ""`: 天井なし（上が吹き抜けや階段のとき）
  - `void: true`: 床を張らない（階段の吹き抜け）。下の階の部屋は `ceiling: ""` にする
- `openings[].at` は開口部の中心で、**壁芯の線の上の点**にする（例: y=8190 の南の壁なら `[x, 8190]`）
  - `door`（室内ドア枠）・`window`（サッシとガラス）・`opening`（枠なしの開口）
  - `sill` は階の FL から測る。掃き出し窓・ドアは `0`、腰窓は `sill: 900, height: 1100` くらい。土間側は `-150` など
- `rooms[].accent` は方角ごとのアクセントクロス。`{ "north": "cross-navy" }` なら、その部屋の北側の壁だけ張り替える
- 家具の `x, y` は中心。`rotation` は平面図で時計回りの角度で、0 のとき正面が南を向く（90 = 西向き、180 = 北向き、270 = 東向き）
- 家具の `z` は階の FL から置く高さ（車庫の車なら `-560`）
- 家具の `count` は数の指定（`open-shelf` の棚板の枚数、`rod-screen` のロッドの本数、`entry-door` は 1 で片開き）
- 家具の `material` に素材IDを書くと、色の代わりにその素材を実寸で貼る（大理石調のカウンター `"material": "aica-tj10235k"` など。箱の形の部分に効く）
- 階段は家具の `stairs`。`d` が上る方向の長さ、`h` が上の階までの高さで、正面（上り口）から奥へ上る

素材ID・家具の種類は `src/materials.ts` の `MATERIALS` と `src/furniture.ts` の `FURNITURE_TYPES` が一覧。
存在しない素材IDはマゼンタで表示され、パネルに警告が出る。

### 素材ID（よく使うもの）

- 床: `floor-oak` `floor-walnut` `floor-white-ash` `floor-gray-oak` `floor-cherry` `floor-tile-white` `floor-tile-stone` `floor-tile-charcoal` `floor-tile-concrete-300` `floor-tile-mortar` `floor-cushion-white` `floor-concrete` `floor-tatami`
- 壁・天井: `cross-white` `cross-offwhite` `cross-greige` `cross-light-gray` `cross-charcoal` `cross-navy` `cross-sage` `cross-terracotta` `cross-dusty-pink` `cross-plaster-white` `cross-stone-lightgray` `cross-stone-charcoal` `cross-concrete` `cross-wood-oak` `cross-wood-walnut` `wall-tile-white`
- 外壁: `exterior-ekg103fk`（ニチハ エピMGライトグレーV） `exterior-charmrock`（ニチハ モエンエクセラード60 シャルムロック プレミアム） `exterior-lightgray` `exterior-siding-white` `exterior-siding-black` `exterior-plaster-beige` `cross-concrete`
- 実際に使う品番（色は見本チップより施工例の写真に寄せて作ったもの）
  - 壁（サンゲツ）: `cross-sp2540`（石目調ライトグレー） `cross-sp2563`（コンクリート柄・淡色） `cross-sp2562`（織物調ダークブラウン） `cross-hf3122`（モルタル調グレー・ハードウォール） `cross-th34102`（石目調ライトグレー） `cross-th34190`（木目調・神代杉）
  - 床（LIXIL）: `floor-ipf300-con2`（コンテⅡ 300角） `floor-lassissa-mortar`（ラシッサDフロア耐水 ラフモルタル柄） `floor-lassissa-lightgray`（同 ライトグレイ柄） `floor-lassissa-sandblack`（同 サンドブラック柄）
  - 浴室（TOTO サザナ）: `panel-sazana-greyishwalnut`（壁 グレイッシュウォルナット） `floor-sazana-raggray`（ほっカラリ床 ライトグレー・ラグ調）
  - その他: `panel-bath-woodgray`（ユニットバスの壁・汎用） `cross-black`（黒い天井・軒天）
  - 家具の面材（`material` 用）: `aica-tj10235k` `aica-tj10240k` `aica-fj901zd`（AICA 大理石調） `concrete-counter`

### 家具の種類

`sofa` `dining-table` `low-table` `chair` `bed` `tv-board` `storage` `kitchen` `island-kitchen` `desk` `rug` `plant` `stairs`（踏板のみ） `stairs-box`（箱型） `car` `rod-screen`（ロッド手すり・格子） `open-shelf`（可動棚・前に黒い支柱あり） `wall-shelf`（可動棚・壁のレールだけで支柱なし） `art` `mirror` `round-mirror` `box`

建具: `sliding-door` `mirror-sliding-door`（上吊りの引き戸。床にレールはなく下が 12mm 空く。開口部の横の壁に沿って置き、h は天井（レール）まで）

水まわり: `basin`（洗面ボウル。h ≤ 30 でアンダーボウル） `faucet`（水栓） `bathtub` `washer`（ドラム式） `iron-bar`（L字のタオル干し）

外まわり: `entry-door`（玄関ドア・親子ドア。開口部の中心に置く） `post-box`（埋込ポスト） `intercom` `camera`（防犯カメラ） `utility-pole`（電柱・街路灯付き。z を GL に）

照明器具（夕方・夜、または「昼も照明をつける」で点灯。器具を置いた部屋は自動の照明が消え、器具の光だけになる）:
`bracket-light` `wall-light`（上下配光） `down-bracket`（下向きの壁付け・表札灯） `downlight`（z を天井高に） `line-light`（間接照明。下向きに光る。光は 1.8m ほどしか届かない） `pendant-light`

壁付けの物（ブラケット・アート・ミラーなど）は背面を壁に付ける。壁の内側の面は壁芯から 60mm 内側なので、中心は「壁芯 ± (60 + d/2)」に置く。

### 画像から作る素材

`plans/*.json` の `materials` に登録すると、画像を素材として使える（画像は `public/textures/` に置く）。
画面の「＋ 画像から素材を追加」からも登録できる。

```json
"materials": [
  { "id": "img-SP2540", "name": "SP2540", "categories": ["wall"], "image": "textures/SP2540.jpg", "tile": [300, 300] }
]
```

`tile` は画像1枚が表す実寸（mm）。見本写真は鏡写しで繰り返して継ぎ目を目立たなくしている。

## ユーザーと一緒に編集するときの約束

- ユーザーはブラウザで `npm run dev` を開いたまま作業していることが多い。`plans/*.json` を保存すると、ブラウザにすぐ反映される
- ユーザーが画面で動かした内容もこのファイルに保存されている。**編集する前に必ずファイルを読み直す**（古い内容で上書きしない）
- JSON は 2スペースのインデントで書く（アプリの保存形式と同じにして差分を読みやすくする）
- 大きな変更（間取りの変更など）を試すときは、元の案を残して `plans/` に別のファイル（例: `my-house-b.json`）を作る
- `plans/my-house.json` はユーザーの実際の家（木造3階建て）。施工会社の図面から書き起こしたもので、寸法は図面の通り芯に合わせてある。図面から読み取れなかった所（開口部の正確な位置など）は推定なので、ユーザーに確認してから直す
- **寸法は施工会社（ワンダーハウス）の図面が正しい。** 部屋の大きさ・廊下の幅・壁の厚さ・開口部の位置と幅は図面に合わせる。ユーザーが作ったスライドのスクショは仕上げ・家具・照明のイメージとして使い、寸法が図面と食い違うときは図面を優先する。図面で決まっていない細かい仕様は、その都度ユーザーに聞く
- 図面に書かれている施主名・住所などの個人情報はリポジトリに書かない
- 1階はユーザーのイメージ図（スクリーンショット）に合わせてある。品番の対応:
  - 玄関・ホールの壁 SP2540、階段とアートの壁 HF3122、シューズクローク・洗面室の壁 SP2563
  - 玄関土間とシューズクロークの床 LIXIL コンテⅡ IPF-300/CON-2。そのほかの床はラシッサDフロア耐水で、1階 ラフモルタル柄・2階 ライトグレイ柄・3階 サンドブラック柄
  - 外壁: 1階 ニチハ EKG103FK エピMGライトグレーV、2・3階 ニチハ モエンエクセラード60 シャルムロック プレミアム
  - 洗面脱衣室: 両側の壁 TH34190、正面の壁と天井 TH34102、カウンター AICA TJ-10235K、腰壁 FJ-901ZD、下の棚 TJ-10240K、置き型ボウル・黒い壁付け水栓・ピタミラー（下に間接照明）
  - 1階 WIC: 壁 SP2562（西と南の壁は SP2540）、入口はホール側に引く吊り引き戸（WIC 側がミラー）、棚は壁付けレールの可動棚（支柱なし）、テープライトは北と東の枕棚の下に続ける、D270 の可動棚、枕棚＋テープライト、ハンガーパイプ上下（1980・900）
  - 浴室: TOTO サザナ HT シリーズ S タイプ 1620（見積もり: 壁 グレイッシュウォルナット、床 ライトグレー・ラグ調、浴槽とエプロン ジュエリーホワイトN、平天井 壁高さ 2150、スッキリ棚水栓 シルバー）
  - 洗面脱衣室のカウンター: AICA セルサス TJ-10235K（アールグレイマーブル）、腰壁 セラール FJ-901ZD（グラニット パラディソ／ダーク）、下の棚 TJ-10240K。ボウルは右寄り、洗濯機の上に L 字のアイアンバー
  - アートの壁: シューズクロークの東の壁のうち、ミラー引き戸より北の部分（ホールと玄関に面する所）が HF3122。アートは下端 1030、その真上にブラケットライト（1850）。玄関の西の壁も HF3122
  - 玄関まわりの配置は図面で確認済み: 玄関の土間は奥行き 910（y 4777.5〜5687.5）。その南の壁に親子扉（YKK AP ヴェナート D30 C10 カームブラック）があり、扉の外は車庫から 190 上がって入る幅約 1000 のポーチ（`1f-porch`、FL −370）。ポーチの南の外壁にくもり窓
  - シューズクロークと玄関の間はミラー付の引き戸（幅 620 の開口。戸はシューズクローク側で北へ引く。玄関の西の壁は内側 790 しかないため）。上がり框の下とフロートベンチの下に間接照明
  - 外まわり: 宅配ボックス NastaBox+POST、インターホン Nasta KS-ND02A、表札灯 KOIZUMI AU54604、車庫の間接照明と防犯カメラ、家の前の電柱
- シューズクローク: ホール側から見て、奥（南）に D450、玄関側（東）に D450 の3段、西の壁に D300（1500 まで）。ハンガーパイプと吊戸棚は西の壁の北半分
- 表札の名前など個人情報は 3D にも書かない
- 家の中の引き戸はすべて上吊り（吊り戸）。`sliding-door` / `mirror-sliding-door` で置き、開口部は `opening`（枠なし）にする。戸は天井から 2400 下げる（天井が高い所や土間側では下が空く。シューズクロークは土間から 150 空く）
- 天井はすべて SP2540（浴室はユニットバスの天井、車庫は黒、ポーチは外なので除く）
- 家の中のドアはすべてハイドア（高さ 2400 = 天井まで）。新しく室内ドアを足すときも `height: 2400` にする（浴室のドアはユニットバスの製品なので除く）
- 家具を置くときは、壁・ドアの前・他の家具と重ならないよう、部屋の外形と開口部の位置から計算する。壁の内側の面は壁芯から `wallThickness / 2`（60mm）内側
- 画面の色は実物と違う。最終決定は実物のサンプルで確認するよう、必要に応じて伝える

## 確認方法

- 型チェック: `npm run typecheck`
- ビルド: `npm run build`
- 見た目の確認: 開発サーバーを起動し、Playwright（Chromium は `/opt/pw-browsers` にある）でスクリーンショットを撮る。
  ソフトウェア描画では `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` を付けて起動する。
  開発モードでは `window.viewer` と `window.store` からアプリを操作できる（例: `viewer.walkInto('2f-ldk')`、`viewer.setFloorView(1)`、`viewer.setTime('night')`）
