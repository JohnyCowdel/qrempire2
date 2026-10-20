// Zero-dependency localhost server.
//   /                 -> public/index.html (world map)
//   /location/<id>    -> public/location.html (location page)
//   /src/engine/*.ts  -> engine modules, types stripped on the fly, so the browser runs the SAME engine
//   /src/client/*.ts  -> client modules (same treatment)
//   /api/*            -> JSON view models from GameService
//   POST /api/command -> DEV ONLY: run any engine command for any player (no auth, no QR/GPS check)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { getTemplates, setTemplates, withMissingKinds, type Bounds, type Command, type EngineContext, type TerrainTemplate } from '../engine/index.ts';
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

// Terrain templates (= location traits): data/templates.json, edited in the asset editor.
const TEMPLATES_FILE = path.join(ROOT, 'data/templates.json');
const DECOR_FILE = path.join(ROOT, 'data/decor.json'); // asset editor settings
try {
  setTemplates(withMissingKinds(JSON.parse(await readFile(TEMPLATES_FILE, 'utf8')) as TerrainTemplate[]));
} catch {
  // no file yet: the built-in defaults
}
const locations = makeLocations(WORLD_SEED, DEMO_CENTER, 60);
/** Re-roll the locations' traits from the current templates (keeps ids, names, positions). */
const rerollLocations = () => { for (const [id, loc] of makeLocations(WORLD_SEED, DEMO_CENTER, 60)) Object.assign(locations.get(id) ?? {}, { traits: loc.traits }); };
const context = (): EngineContext => ({ worldSeed: WORLD_SEED, now: Date.now(), locations });
const repo = new MemoryRepository(); // state resets on restart; swap for a real adapter later
const game = new GameService(repo, context, process.env.QR_SECRET ?? 'dev-secret');
await seedDemo(game, locations, WORLD_SEED);

const send = (res: ServerResponse, status: number, body: string | Buffer, type: string) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res: ServerResponse, body: unknown, status = 200) => send(res, status, JSON.stringify(body), 'application/json');

const ID = /^[\w-]{1,40}$/;
const COMMANDS = new Set(['scan', 'claim', 'deposit', 'upgrade', 'equip']);

async function readJson(req: import('node:http').IncomingMessage, limit = 10_000): Promise<any> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('body too large');
  }
  return JSON.parse(body);
}

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
    if (p === '/editor') {
      return send(res, 200, await readFile(path.join(ROOT, 'public/editor.html')), 'text/html; charset=utf-8');
    }
    if (/^\/location\/[\w-]+$/.test(p)) {
      return send(res, 200, await readFile(path.join(ROOT, 'public/location.html')), 'text/html; charset=utf-8');
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

    if (p === '/api/templates' && req.method === 'GET') return json(res, getTemplates());
    // asset editor settings (DECOR): stored on the server so every device (phones!) renders the same
    if (p === '/api/decor' && req.method === 'GET') {
      try { return send(res, 200, await readFile(DECOR_FILE), 'application/json'); } catch { return json(res, null); }
    }
    if (p === '/api/decor' && req.method === 'PUT') {
      const decor = await readJson(req, 2_000_000);
      if (!decor || typeof decor !== 'object' || Array.isArray(decor)) return json(res, { error: 'bad settings' }, 400);
      await mkdir(path.dirname(DECOR_FILE), { recursive: true });
      await writeFile(DECOR_FILE, JSON.stringify(decor));
      return json(res, { ok: true });
    }
    if (p === '/api/templates' && req.method === 'PUT') { // asset editor saves the templates
      const list = await readJson(req, 2_000_000);
      if (!Array.isArray(list) || !list.every((t) => t && typeof t.name === 'string' && ID.test(t.name) && typeof t.kind === 'string')) return json(res, { error: 'bad templates' }, 400);
      setTemplates(list as TerrainTemplate[]);
      rerollLocations();
      await mkdir(path.dirname(TEMPLATES_FILE), { recursive: true });
      await writeFile(TEMPLATES_FILE, JSON.stringify(list, null, 1));
      return json(res, { ok: true, count: list.length });
    }
    if (p === '/api/locations') { // dev: quick switching on the location page
      return json(res, [...locations.values()].map(({ id, name, type, tier, traits }) => ({ id, name, type, tier, traits })));
    }

    if (p === '/api/map') {
      const bounds = parseBounds(url.searchParams);
      if (!bounds) return json(res, { error: 'expected s, w, n, e query params' }, 400);
      return json(res, await game.mapPage(bounds));
    }

    const loc = p.match(/^\/api\/location\/([\w-]+)$/);
    if (loc) {
      const viewer = url.searchParams.get('player');
      const scene = await game.locationPage(loc[1], viewer && ID.test(viewer) ? viewer : undefined);
      if (!scene) return json(res, { error: 'unknown location' }, 404);
      const { terrain: _terrain, ...rest } = scene; // the client can regenerate terrain from the seed
      return json(res, rest);
    }

    const base = p.match(/^\/api\/base\/([\w-]+)$/);
    if (base) return json(res, (await game.basePage(base[1])) ?? null);

    const player = p.match(/^\/api\/player\/([\w-]+)$/);
    if (player) return json(res, await game.playerPage(player[1]));

    if (p === '/api/command' && req.method === 'POST') {
      // DEV ONLY – a real deployment authenticates the player and routes scans through game.scanQr.
      const { playerId, command } = await readJson(req);
      if (typeof playerId !== 'string' || !ID.test(playerId) || !COMMANDS.has(command?.type)) {
        return json(res, { ok: false, error: 'bad request' }, 400);
      }
      return json(res, await game.execute(playerId, command as Command));
    }

    if (p === '/api/stats') return json(res, repo.stats);

    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return send(res, 404, 'not found', 'text/plain');
    console.error(e);
    json(res, { error: 'internal error' }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`QR Empire dev server → http://localhost:${PORT}`);
  // also reachable from other devices on the same network (phone on Wi-Fi):
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254')) console.log(`  on your network → http://${a.address}:${PORT}`);
    }
  }
});
