import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';

const PLANS_DIR = path.resolve(import.meta.dirname, 'plans');
const TEXTURES_DIR = path.resolve(import.meta.dirname, 'public', 'textures');
const TEXTURE_RE = /^[\p{L}\p{N}_.-]+\.(jpe?g|png|webp)$/iu;
const NAME_RE = /^[\p{L}\p{N}_-]+$/u;

/**
 * plans/*.json を読み書きする開発サーバー用の API。
 * ファイルが外から書き換えられたら（Claude が編集したときなど）、ブラウザへ通知する。
 */
function planApi(): Plugin {
  return {
    name: 'plan-api',
    configureServer(server) {
      server.watcher.add(PLANS_DIR);
      server.watcher.on('change', (file) => {
        if (path.dirname(file) === PLANS_DIR && file.endsWith('.json')) {
          server.ws.send({ type: 'custom', event: 'plan-changed', data: { name: path.basename(file, '.json') } });
        }
      });

      // 素材の画像を public/textures/ に保存する
      server.middlewares.use('/api/textures', async (req, res) => {
        const name = decodeURIComponent((req.url ?? '/').replace(/^\//, '').split('?')[0]);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (req.method !== 'PUT' || !TEXTURE_RE.test(name) || name.startsWith('.')) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'invalid request' }));
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        await fs.mkdir(TEXTURES_DIR, { recursive: true });
        await fs.writeFile(path.join(TEXTURES_DIR, name), Buffer.concat(chunks));
        res.end(JSON.stringify({ path: `textures/${name}` }));
      });

      server.middlewares.use('/api/plans', async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };
        try {
          const name = decodeURIComponent((req.url ?? '/').replace(/^\//, '').split('?')[0]);
          if (!name) {
            if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
            const files = (await fs.readdir(PLANS_DIR)).filter((f) => f.endsWith('.json'));
            return send(200, files.map((f) => f.slice(0, -5)).sort());
          }
          if (!NAME_RE.test(name)) return send(400, { error: 'invalid plan name' });
          const file = path.join(PLANS_DIR, `${name}.json`);
          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.end(await fs.readFile(file, 'utf8'));
          }
          if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            const plan = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            await fs.writeFile(file, JSON.stringify(plan, null, 2) + '\n', 'utf8');
            return send(200, { ok: true });
          }
          return send(405, { error: 'method not allowed' });
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          return send(err.code === 'ENOENT' ? 404 : 500, { error: err.message });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [planApi()],
});
