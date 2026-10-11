// テクスチャ生成用の、継ぎ目なく繰り返せるノイズ。

export type Rand = () => number;

/**
 * 継ぎ目のないバリューノイズを重ねた fbm。値はおよそ 0〜1。
 * cellsX, cellsY は一番粗いオクターブで、テクスチャの幅・高さに格子がいくつ並ぶか（整数）。
 */
export function fbm(
  w: number,
  h: number,
  rand: Rand,
  opts: { cellsX: number; cellsY?: number; octaves?: number; persistence?: number },
): Float32Array {
  const out = new Float32Array(w * h);
  const octaves = opts.octaves ?? 5;
  const persistence = opts.persistence ?? 0.5;
  let cx = Math.max(1, Math.round(opts.cellsX));
  let cy = Math.max(1, Math.round(opts.cellsY ?? opts.cellsX));
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const grid = new Float32Array(cx * cy);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    for (let y = 0; y < h; y++) {
      const gy = (y / h) * cy;
      const y0 = Math.floor(gy);
      const ty = smooth(gy - y0);
      const r0 = (y0 % cy) * cx;
      const r1 = ((y0 + 1) % cy) * cx;
      for (let x = 0; x < w; x++) {
        const gx = (x / w) * cx;
        const x0 = Math.floor(gx);
        const tx = smooth(gx - x0);
        const c0 = x0 % cx;
        const c1 = (x0 + 1) % cx;
        const a = grid[r0 + c0] + (grid[r0 + c1] - grid[r0 + c0]) * tx;
        const b = grid[r1 + c0] + (grid[r1 + c1] - grid[r1 + c0]) * tx;
        out[y * w + x] += (a + (b - a) * ty) * amp;
      }
    }
    total += amp;
    amp *= persistence;
    cx *= 2;
    cy *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function smooth(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 高さマップから法線マップ（タンジェント空間）を作る。strength が大きいほど凹凸が強い */
export function normalMapFromHeight(height: Float32Array, w: number, h: number, strength: number): ImageData {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const up = ((y - 1 + h) % h) * w;
    const down = ((y + 1) % h) * w;
    for (let x = 0; x < w; x++) {
      const left = (x - 1 + w) % w;
      const right = (x + 1) % w;
      const dx = (height[y * w + right] - height[y * w + left]) * strength;
      // キャンバスの y は下向き、UV の v は上向きなので符号を反転する
      const dy = (height[up + x] - height[down + x]) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      d[i] = (-dx / len) * 127.5 + 127.5;
      d[i + 1] = (-dy / len) * 127.5 + 127.5;
      d[i + 2] = (1 / len) * 127.5 + 127.5;
      d[i + 3] = 255;
    }
  }
  return img;
}
