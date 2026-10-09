// Application service: the only place where engine meets storage.
// Per command: derive keys -> ONE batched read -> pure engine call -> ONE atomic commit.
// Reads for pages are projections computed in the engine from as few docs as possible.
import {
  baseIdFor, baseView, buildLocationScene, buildMapView, createPlayer, distanceM, execute, playerView,
  regionIdOf, regionsInBounds, requirements, TUNING,
  type BaseState, type Bounds, type Command, type EngineContext, type Id, type LatLng, type Outcome,
  type PlayerState, type RegionState, type Snapshot,
} from '../engine/index.ts';
import { ConflictError, type DocKey, type Repository, type Write } from '../storage/repository.ts';
import { verifyQr } from './qr.ts';

const pk = (id: Id): DocKey => `player:${id}`;
const bk = (id: Id): DocKey => `base:${id}`;
const rk = (id: string): DocKey => `region:${id}`;

export class GameService {
  private readonly repo: Repository;
  private readonly context: () => EngineContext;
  private readonly qrSecret: string;

  constructor(repo: Repository, context: () => EngineContext, qrSecret: string) {
    this.repo = repo;
    this.context = context;
    this.qrSecret = qrSecret;
  }

  /** Entry point for /l/<locationId>?t=... scans. Cheap rejections happen before any DB access. */
  async scanQr(playerId: Id, token: string, gps: LatLng): Promise<Outcome> {
    const locationId = await verifyQr(this.qrSecret, token);
    if (!locationId) return { ok: false, error: 'invalid QR code' };
    const loc = this.context().locations.get(locationId);
    if (!loc) return { ok: false, error: 'unknown location' };
    if (distanceM(loc, gps) > TUNING.scanRadiusM) return { ok: false, error: 'you are too far away' };
    return this.execute(playerId, { type: 'scan', locationId });
  }

  async execute(playerId: Id, cmd: Command, retries = 3): Promise<Outcome> {
    for (let attempt = 0; ; attempt++) {
      const ctx = this.context();
      const req = requirements(ctx, cmd);
      const keys: DocKey[] = [pk(playerId)];
      if (req.baseId) keys.push(bk(req.baseId));
      if (req.regionId) keys.push(rk(req.regionId));
      const docs = await this.repo.getMany(keys);

      const snap: Snapshot = {
        player: (docs.get(pk(playerId)) as PlayerState | undefined) ?? createPlayer(playerId, playerId),
        base: req.baseId ? (docs.get(bk(req.baseId)) as BaseState | undefined) : undefined,
        region: req.regionId
          ? ((docs.get(rk(req.regionId)) as RegionState | undefined) ?? { id: req.regionId, owners: {}, version: 0 })
          : undefined,
      };
      const outcome = execute(ctx, snap, cmd);
      if (!outcome.ok) return outcome;

      const writes: Write[] = [];
      const stage = (key: DocKey, doc: { version: number } | undefined, original: { version: number } | undefined) => {
        if (!doc) return;
        const expectedVersion = original?.version ?? 0;
        writes.push({ key, doc: { ...doc, version: expectedVersion + 1 }, expectedVersion });
      };
      stage(pk(playerId), outcome.changed.player, docs.get(pk(playerId)));
      if (req.baseId) stage(bk(req.baseId), outcome.changed.base, docs.get(bk(req.baseId)));
      if (req.regionId) stage(rk(req.regionId), outcome.changed.region, docs.get(rk(req.regionId)));

      try {
        await this.repo.commit(writes);
        return outcome;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= retries) throw e;
      }
    }
  }

  // ---- read side (page view models) ----

  async playerPage(playerId: Id) {
    const docs = await this.repo.getMany([pk(playerId)]);
    const player = (docs.get(pk(playerId)) as PlayerState | undefined) ?? createPlayer(playerId, playerId);
    return playerView(player);
  }

  async basePage(baseId: Id) {
    const docs = await this.repo.getMany([bk(baseId)]);
    const base = docs.get(bk(baseId)) as BaseState | undefined;
    return base ? baseView(base, this.context().now) : undefined;
  }

  /** 2 docs max (region + base) + the viewer, all in one batch. Terrain costs 0 reads. */
  async locationPage(locationId: Id, viewerId?: Id) {
    const ctx = this.context();
    const loc = ctx.locations.get(locationId);
    if (!loc) return undefined;
    const keys: DocKey[] = [rk(regionIdOf(loc)), bk(baseIdFor(loc.id))];
    if (viewerId) keys.push(pk(viewerId));
    const docs = await this.repo.getMany(keys);
    return buildLocationScene(ctx, loc, {
      ownerId: (docs.get(keys[0]) as RegionState | undefined)?.owners[loc.id],
      base: docs.get(keys[1]) as BaseState | undefined,
      viewer: viewerId ? (docs.get(keys[2]) as PlayerState | undefined) : undefined,
    });
  }

  /** One batched read of the few region docs covering the viewport. Cache this at the edge for ~30 s. */
  async mapPage(bounds: Bounds) {
    const ctx = this.context();
    const regionIds = regionsInBounds(bounds);
    const docs = await this.repo.getMany(regionIds.map(rk));
    const regions = new Map<string, RegionState>();
    for (const id of regionIds) {
      const r = docs.get(rk(id)) as RegionState | undefined;
      if (r) regions.set(id, r);
    }
    return buildMapView(ctx, bounds, regions, regionIds);
  }
}
