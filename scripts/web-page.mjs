// Web 版（dist-web）の index.html から、claude.ai の Artifact に載せるページ（web.html）を作る。
// Artifact のページは <html> や <head> を書かず、中身だけを書く。CSS はページに埋め込み、JS は assets/ のファイルを読む
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '..', 'dist-web');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"/g)].map((m) => fs.readFileSync(path.join(dir, m[1]), 'utf8')).join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*src="\.\/([^"]+)"/g)].map((m) => m[1]);
const page = `<title>マイホームシミュレーター</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
html, body { height: 100%; }
body { background: var(--bg); color: var(--text); }
</style>
<div id="app">
  <div id="viewport"></div>
  <aside id="panel"><p style="padding: 16px">読み込み中…</p></aside>
</div>
${js.map((f) => `<script type="module" src="${f}"></script>`).join('\n')}
`;
fs.writeFileSync(path.join(dir, 'web.html'), page);
console.log('dist-web/web.html', js);
