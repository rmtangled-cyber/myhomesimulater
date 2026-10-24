// 電灯コンセント図（各階）を SVG で書き出す: node scripts/electrical-plan.mjs [間取りの名前]
// 出力は notes/electrical/<階>.svg と、全部の階を印刷できる 電灯コンセント図.html（src/electricalPlan.ts を Vite で読み込んで使う）
import { createServer } from 'vite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const name = process.argv[2] ?? 'my-house';
const plan = JSON.parse(readFileSync(`plans/${name}.json`, 'utf8'));
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { electricalSvg, electricalHtml } = await server.ssrLoadModule('/src/electricalPlan.ts');
  const date = new Date().toLocaleDateString('sv-SE');
  mkdirSync('notes/electrical', { recursive: true });
  plan.floors.forEach((floor, i) => {
    const file = `notes/electrical/${i + 1}F.svg`;
    writeFileSync(file, electricalSvg(plan, i, { date }));
    console.log(file, floor.name);
  });
  writeFileSync('notes/electrical/電灯コンセント図.html', electricalHtml(plan, { date }));
} finally {
  await server.close();
}
