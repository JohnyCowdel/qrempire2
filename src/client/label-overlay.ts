// Our own label renderer: reads named features straight from the vector tiles the map
// already loaded (querySourceFeatures, no extra requests) and draws them on a Canvas2D
// overlay. Being plain canvas text, it can use ANY web font, unlike MapLibre symbol
// layers which are limited to pre-built glyph PBFs.

type Props = Record<string, any>;
type LngLat = [number, number];

export interface LabelStyle {
  size: number;
  color: string;
  weight?: number;
  italic?: boolean;
  uppercase?: boolean;
  letterSpacing?: number; // px
  halo?: string;
  haloWidth?: number;
}

export interface LabelKind {
  id: string;
  source: string;
  sourceLayer: string;
  placement: 'point' | 'line'; // line = one label per name, rotated along the line near the view centre
  filter?(props: Props, zoom: number): boolean;
  text?(props: Props): string | undefined;
  style(props: Props, zoom: number): LabelStyle;
  priority?(props: Props): number; // lower wins collisions
}

interface Cached {
  kind: LabelKind;
  text: string;
  props: Props;
  points: LngLat[]; // point placement: one anchor; line placement: unused
  lines: LngLat[][];
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const MAX_DISTANCE_SCREENS = 3;

const defaultText =(p: Props): string | undefined => p['name:latin'] ?? p.name;

export class LabelOverlay {
  private readonly map: any;
  private readonly kinds: readonly LabelKind[];
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly hidden = new Set<string>();
  private readonly widthCache = new Map<string, number>();
  private cache: Cached[] = [];
  private font: string;
  private frame = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(map: any, kinds: readonly LabelKind[], font: string) {
    this.map = map;
    this.kinds = kinds;
    this.font = font;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'qre-label-overlay';
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    // Right above the map canvas, below controls and popups.
    map.getCanvasContainer().after(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    map.on('render', this.schedule);
    map.on('resize', this.schedule);
    map.on('moveend', this.refreshSoon);
    map.on('sourcedata', (e: any) => {
      if (e.isSourceLoaded && this.kinds.some((k) => k.source === e.sourceId)) this.refreshSoon();
    });
    this.setFont(font);
  }

  setFont(family: string): void {
    this.font = family;
    this.widthCache.clear();
    document.fonts.load(`16px "${family}"`).finally(this.schedule);
    this.schedule();
  }

  setKindVisible(kindId: string, visible: boolean): void {
    if (visible) this.hidden.delete(kindId);
    else this.hidden.add(kindId);
    this.schedule();
  }

  // ---- feature cache (geo coords; rebuilt only when tiles change) ----

  private readonly refreshSoon = () => {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(this.refresh, 150);
  };

  private readonly refresh = () => {
    const out: Cached[] = [];
    const zoom = this.map.getZoom();
    for (const kind of this.kinds) {
      if (!this.map.getSource(kind.source)) continue;
      const byKey = new Map<string, Cached>(); // features repeat across tile borders
      for (const f of this.map.querySourceFeatures(kind.source, { sourceLayer: kind.sourceLayer })) {
        const props = f.properties ?? {};
        if (kind.filter && !kind.filter(props, zoom)) continue;
        const text = (kind.text ?? defaultText)(props);
        if (!text) continue;
        const key = `${text}|${props.class ?? ''}`;
        let entry = byKey.get(key);
        if (!entry) byKey.set(key, (entry = { kind, text, props, points: [], lines: [] }));
        const g = f.geometry;
        if (g.type === 'Point') entry.points.push(g.coordinates);
        else if (g.type === 'MultiPoint') entry.points.push(...g.coordinates);
        else if (g.type === 'LineString') entry.lines.push(g.coordinates);
        else if (g.type === 'MultiLineString') entry.lines.push(...g.coordinates);
        else if (g.type === 'Polygon' && kind.placement === 'point') entry.points.push(centroid(g.coordinates[0]));
      }
      out.push(...byKey.values());
    }
    this.cache = out;
    this.schedule();
  };

  // ---- drawing ----

  private readonly schedule = () => {
    if (!this.frame) this.frame = requestAnimationFrame(this.draw);
  };

  private fontString(s: LabelStyle): string {
    return `${s.italic ? 'italic ' : ''}${s.weight ?? 400} ${s.size}px "${this.font}", Georgia, serif`;
  }

  private measure(text: string, s: LabelStyle): number {
    const key = `${this.fontString(s)}|${s.letterSpacing ?? 0}|${text}`;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      this.applyFont(s);
      w = this.ctx.measureText(text).width;
      this.widthCache.set(key, w);
    }
    return w;
  }

  private applyFont(s: LabelStyle): void {
    this.ctx.font = this.fontString(s);
    this.ctx.letterSpacing = `${s.letterSpacing ?? 0}px`;
  }

  private readonly draw = () => {
    this.frame = 0;
    const { map, canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const zoom = map.getZoom();
    // When pitched, the view reaches the horizon; skip labels farther than a few screen
    // widths from the centre so distant cities don't pile up along the top edge.
    const center = map.getCenter();
    const cosLat = Math.cos((center.lat * Math.PI) / 180);
    const metersPerPixel = (156543.03 * cosLat) / 2 ** zoom;
    const maxDist = MAX_DISTANCE_SCREENS * w * metersPerPixel;
    const tooFar = ([lng, lat]: LngLat) =>
      Math.hypot((lng - center.lng) * cosLat, lat - center.lat) * 111_320 > maxDist;

    const candidates: { c: Cached; anchors: Anchor[]; prio: number }[] = [];
    for (const c of this.cache) {
      if (this.hidden.has(c.kind.id)) continue;
      const prio = c.kind.priority?.(c.props) ?? 100;
      if (c.kind.placement === 'point') {
        if (!c.points.length || tooFar(c.points[0])) continue;
        const p = map.project(c.points[0]);
        candidates.push({ c, anchors: [{ x: p.x, y: p.y, angle: 0 }], prio });
      } else {
        const anchors = lineAnchors(map, c.lines, w, h);
        if (anchors.length) candidates.push({ c, anchors, prio });
      }
    }
    candidates.sort((a, b) => a.prio - b.prio);

    const placed: Box[] = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const { c, anchors } of candidates) {
      const s = c.kind.style(c.props, zoom);
      const text = s.uppercase ? c.text.toUpperCase() : c.text;
      const tw = this.measure(text, s), th = s.size * 1.2;
      // First anchor that fits wins (line labels have several along the line).
      let fit: { x: number; y: number; angle: number; box: Box } | undefined;
      for (const { x, y, angle } of anchors) {
        const cos = Math.abs(Math.cos(angle)), sin = Math.abs(Math.sin(angle));
        const hw = (tw * cos + th * sin) / 2 + 2, hh = (tw * sin + th * cos) / 2 + 2;
        const box = { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh };
        if (box.x0 < 0 || box.y0 < 0 || box.x1 > w || box.y1 > h) continue;
        if (placed.some((b) => b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0)) continue;
        fit = { x, y, angle, box };
        break;
      }
      if (!fit) continue;
      const { x, y, angle } = fit;
      placed.push(fit.box);

      ctx.save();
      ctx.translate(x, y);
      if (angle) ctx.rotate(angle);
      this.applyFont(s);
      if (s.halo) {
        ctx.strokeStyle = s.halo;
        ctx.lineWidth = (s.haloWidth ?? 2) * 2;
        ctx.strokeText(text, 0, 0);
      }
      ctx.fillStyle = s.color;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  };
}

function centroid(ring: LngLat[]): LngLat {
  let x = 0, y = 0;
  for (const [lng, lat] of ring) {
    x += lng;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

interface Anchor {
  x: number;
  y: number;
  angle: number;
}

/**
 * Candidate label positions along a line: on-screen vertices ordered by distance from the
 * view centre, at least `spacing` px apart, each with the line's local angle (kept upright).
 */
function lineAnchors(map: any, lines: LngLat[][], w: number, h: number, spacing = 120, max = 10): Anchor[] {
  const all: (Anchor & { d: number })[] = [];
  for (const line of lines) {
    if (line.length < 3) continue;
    const pts = line.map((c) => map.project(c));
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      if (p.x < 0 || p.y < 0 || p.x > w || p.y > h) continue;
      // Angle over a wider window (±2 vertices) to ignore tiny wiggles.
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
      let angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (angle > Math.PI / 2) angle -= Math.PI;
      else if (angle < -Math.PI / 2) angle += Math.PI;
      all.push({ x: p.x, y: p.y, angle, d: (p.x - w / 2) ** 2 + (p.y - h / 2) ** 2 });
    }
  }
  all.sort((p, q) => p.d - q.d);
  const out: Anchor[] = [];
  for (const p of all) {
    if (out.some((o) => (o.x - p.x) ** 2 + (o.y - p.y) ** 2 < spacing * spacing)) continue;
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}
