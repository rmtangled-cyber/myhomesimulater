// 電灯コンセント図と平面図（各階）を書き出す: node scripts/electrical-plan.mjs [間取りの名前]
// 出力: notes/electrical/<階>.svg、全部の階を印刷できる notes/electrical/電灯コンセント図.html と notes/平面図.html、
// iPad で見る Artifact 用の dist-docs/electrical.html・dist-docs/plan.html（src/electricalPlan.ts を Vite で読み込んで使う）
import { createServer } from 'vite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** 印刷用の HTML を Artifact 用にする（doctype・head・body のタグを外し、画面の幅に合わせて縮める） */
function forArtifact(html, title) {
  return html
    .replace(/^<!doctype html><html lang="ja"><head><meta charset="utf-8">/, '')
    .replace(/<title>.*?<\/title>/, `<title>${title}</title>`)
    .replace('</head><body>', '')
    .replace('</body></html>', '')
    .replace('</style>', 'html,body{background:#888}section{width:auto;max-width:420mm;height:auto;margin:12px auto}section svg{width:100%;height:auto}body{padding:0 max(12px,env(safe-area-inset-left,0px))}</style>');
}

const name = process.argv[2] ?? 'my-house';
const plan = JSON.parse(readFileSync(`plans/${name}.json`, 'utf8'));
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { electricalSvg, electricalHtml, floorPlanHtml } = await server.ssrLoadModule('/src/electricalPlan.ts');
  const date = new Date().toLocaleDateString('sv-SE');
  mkdirSync('notes/electrical', { recursive: true });
  mkdirSync('dist-docs', { recursive: true });
  plan.floors.forEach((floor, i) => {
    const file = `notes/electrical/${i + 1}F.svg`;
    writeFileSync(file, electricalSvg(plan, i, { date }));
    console.log(file, floor.name);
  });
  const electrical = electricalHtml(plan, { date });
  const floorPlan = floorPlanHtml(plan, { date });
  writeFileSync('notes/electrical/電灯コンセント図.html', electrical);
  writeFileSync('notes/平面図.html', floorPlan);
  writeFileSync('dist-docs/electrical.html', forArtifact(electrical, '電灯コンセント図'));
  writeFileSync('dist-docs/plan.html', forArtifact(floorPlan, '我が家の平面図'));
} finally {
  await server.close();
}
