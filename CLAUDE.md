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

- 単位はすべて **mm**。平面図の座標で **x = 右（東）**、**y = 下（南）**。原点は左上（北西）
- グリッドは 910mm（尺モジュール）。部屋の頂点はなるべく 910 の倍数（455 の倍数）にそろえる
- **壁は書かない**。`rooms[].polygon`（壁芯で囲んだ外形）の辺から自動で作られる。隣り合う部屋は辺を共有させる
- 部屋どうしの間に壁を作りたくない場合は、そこに `type: "opening"` の開口部を置く
- `openings[].at` は開口部の中心で、**壁芯の線の上の点**にする（例: y=8190 の南の壁なら `[x, 8190]`）
  - `door`（室内ドア枠）・`window`（サッシとガラス）・`opening`（枠なしの開口）
  - 掃き出し窓・ドアは `sill: 0`。腰窓は `sill: 900, height: 1100` くらい
- `rooms[].accent` は方角ごとのアクセントクロス。`{ "north": "cross-navy" }` なら、その部屋の北側の壁だけ張り替える
- 家具の `x, y` は中心。`rotation` は平面図で時計回りの角度で、0 のとき正面が南を向く（90 = 西向き、180 = 北向き、270 = 東向き）
- 家具の `id` は他と重ならないようにする（`<type>-<連番>` が慣例）

素材ID・家具の種類は `src/materials.ts` の `MATERIALS` と `src/furniture.ts` の `FURNITURE_TYPES` が一覧。
存在しない素材IDはマゼンタで表示され、パネルに警告が出る。

### 素材ID（よく使うもの）

- 床: `floor-oak` `floor-walnut` `floor-white-ash` `floor-gray-oak` `floor-cherry` `floor-tile-white` `floor-tile-stone` `floor-cushion-white` `floor-tatami`
- 壁・天井: `cross-white` `cross-offwhite` `cross-greige` `cross-light-gray` `cross-charcoal` `cross-navy` `cross-sage` `cross-terracotta` `cross-dusty-pink` `cross-concrete` `cross-wood-oak` `cross-wood-walnut` `wall-tile-white`
- 外壁: `exterior-siding-white` `exterior-siding-black` `exterior-plaster-beige` `cross-concrete`

### 家具の種類

`sofa` `dining-table` `low-table` `chair` `bed` `tv-board` `storage` `kitchen` `island-kitchen` `desk` `rug` `plant` `box`

## ユーザーと一緒に編集するときの約束

- ユーザーはブラウザで `npm run dev` を開いたまま作業していることが多い。`plans/*.json` を保存すると、ブラウザにすぐ反映される
- ユーザーが画面で動かした内容もこのファイルに保存されている。**編集する前に必ずファイルを読み直す**（古い内容で上書きしない）
- JSON は 2スペースのインデントで書く（アプリの保存形式と同じにして差分を読みやすくする）
- 大きな変更（間取りの変更など）を試すときは、元の案を残して `plans/` に別のファイル（例: `b-plan.json`）を作る
- 家具を置くときは、壁・ドアの前・他の家具と重ならないよう、部屋の外形と開口部の位置から計算する。壁の内側の面は壁芯から `wallThickness / 2`（60mm）内側
- 画面の色は実物と違う。最終決定は実物のサンプルで確認するよう、必要に応じて伝える

## 確認方法

- 型チェック: `npm run typecheck`
- ビルド: `npm run build`
- 見た目の確認: 開発サーバーを起動し、Playwright（Chromium は `/opt/pw-browsers` にある）でスクリーンショットを撮る。
  ソフトウェア描画では `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` を付けて起動する。
  開発モードでは `window.viewer` と `window.store` からアプリを操作できる（例: `viewer.walkInto('ldk')`、`viewer.setTime('night')`）
