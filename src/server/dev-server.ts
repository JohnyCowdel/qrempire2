// Zero-dependency localhost server.
//   /                 -> public/index.html
//   /src/engine/*.ts  -> engine modules, types stripped on the fly, so the browser runs the SAME engine
//   /src/client/*.ts  -> client modules (same treatment)
//   /api/*            -> JSON view models from GameService
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import type { Bounds, EngineContext } from '../engine/index.ts';
import { MemoryRepository } from '../storage/memory.ts';
import { GameService } from './game-service.ts';
import { DEMO_CENTER, makeLocations, seedDemo } from './world.ts';

const PORT = Number(process.env.PORT ?? 5173);
const WORLD_SEED = Number(process.env.SEED ?? 42);
const ROOT = path.resolve(import.meta.dirname, '../..');
const BROWSER_DIRS = ['src/engine', 'src/client'].map((d) => path.join(ROOT, d) + path.sep);
const ASSETS_DIR = path.join(ROOT, 'assets') + path.sep;
const ASSET_TYPES: Record<string, string> = {
  '.stl': 'model/stl', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json',
};

const locations = makeLocations(WORLD_SEED, DEMO_CENTER, 60);
const context = (): EngineContext => ({ worldSeed: WORLD_SEED, now: Date.now(), locations });
const repo = new MemoryRepository(); // state resets on restart; swap for a real adapter later
const game = new GameService(repo, context, process.env.QR_SECRET ?? 'dev-secret');
await seedDemo(game, locations, WORLD_SEED);

const send = (res: ServerResponse, status: number, body: string | Buffer, type: string) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res: ServerResponse, body: unknown, status = 200) => send(res, status, JSON.stringify(body), 'application/json');

function parseBounds(q: URLSearchParams): Bounds | undefined {
  const [south, west, north, east] = ['s', 'w', 'n', 'e'].map((k) => Number(q.get(k)));
  if (![south, west, north, east].every(Number.isFinite) || south > north || west > east) return undefined;
  return { south, west, north, east };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      return send(res, 200, await readFile(path.join(ROOT, 'public/index.html')), 'text/html; charset=utf-8');
    }

    if (p.endsWith('.ts')) {
      const file = path.resolve(ROOT, '.' + p);
      if (!BROWSER_DIRS.some((d) => file.startsWith(d))) return send(res, 404, 'not found', 'text/plain');
      const code = stripTypeScriptTypes(await readFile(file, 'utf8'));
      return send(res, 200, code, 'text/javascript; charset=utf-8');
    }

    if (p.startsWith('/assets/')) {
      const file = path.resolve(ROOT, '.' + p);
      if (!file.startsWith(ASSETS_DIR)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, await readFile(file), ASSET_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    }

    if (p === '/api/world') {
      return json(res, { worldSeed: WORLD_SEED, center: DEMO_CENTER, now: Date.now() });
    }

    if (p === '/api/map') {
      const bounds = parseBounds(url.searchParams);
      if (!bounds) return json(res, { error: 'expected s, w, n, e query params' }, 400);
      return json(res, await game.mapPage(bounds));
    }

    const loc = p.match(/^\/api\/location\/([\w-]+)$/);
    if (loc) {
      const scene = await game.locationPage(loc[1]);
      if (!scene) return json(res, { error: 'unknown location' }, 404);
      const { terrain: _terrain, ...rest } = scene; // the client can regenerate terrain from the seed
      return json(res, rest);
    }

    if (p === '/api/stats') return json(res, repo.stats);

    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return send(res, 404, 'not found', 'text/plain');
    console.error(e);
    json(res, { error: 'internal error' }, 500);
  }
});

server.listen(PORT, () => console.log(`QR Empire dev server → http://localhost:${PORT}`));
