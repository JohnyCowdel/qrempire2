// Terrain template editor for the asset editor (tabs Water, High spot, Forest, Traits): pick /
// create / rename / delete NAMED templates (= location traits), tune their chance and params, and
// edit their shapes with handles in the 3D viewport (on a see-through plane above the preview).
// The preview is a real location generated from just that template – exactly what locations get.
// Changes are sent to the dev server (PUT /api/templates → data/templates.json).
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  getTemplates, KIND_DEFAULTS, PARAM_OPTIONS, riverPolyline, setTemplates, splineLoop, TERRAIN_LEVELS, terrainField, waterLooks,
  type LocationDef, type TemplateKind, type TerrainTemplate,
} from '../engine/index.ts';
import { LocationView } from './location-view.ts';

export interface EditorContext {
  preview: THREE.Group;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  sun: THREE.DirectionalLight;
  terrainMaterial: THREE.Material;
  knobsEl: HTMLElement;
  rebuild: () => void; // regenerate the preview
  renderPanel: () => void;
  activeKinds: () => TemplateKind[] | null; // kinds of the current tab, null = not a template tab
  status: (text: string) => void;
}

/** Slider ranges per param (`kind.param` overrides `param`). */
const RANGES: Record<string, [number, number, number]> = {
  radius: [0.03, 0.5, 0.005], slope: [0.02, 0.6, 0.005], height: [0, 0.6, 0.005], tierHeight: [0, 0.1, 0.002], calm: [0, 0.3, 0.005],
  rimRock: [0, 0.6, 0.01], ringWidth: [0.01, 0.2, 0.002], depth: [0.01, 0.3, 0.005], bankSlope: [0.1, 4, 0.05], count: [0, 8, 1],
  size: [0.01, 0.15, 0.002], bog: [0.3, 0.9, 0.005], width: [0.005, 0.08, 0.001], straight: [0, 2, 0.01], amount: [0, 1.5, 0.01],
  edge: [0.005, 0.3, 0.005], scale: [1, 20, 0.1], threshold: [0.2, 0.9, 0.005], moist: [-0.6, 0.6, 0.01], rock: [-0.3, 0.3, 0.005],
  ridge: [0, 0.5, 0.005], fields: [0, 2, 0.01], minSlope: [0.2, 3, 0.05], fullSlope: [0.3, 4, 0.05], p1: [0.05, 3, 0.01],
  gridSize: [0.3, 4, 0.05], protrude: [-0.5, 0.5, 0.01], bulge: [0, 1, 0.01], topBulge: [0, 1, 0.01], bottomBulge: [0, 1, 0.01], topBulgeAt: [0, 0.5, 0.01], bottomBulgeAt: [0.5, 1, 0.01], gridJitter: [0, 1.5, 0.01], reachJitter: [0, 0.6, 0.01],
  chamfer: [0, 0.5, 0.01], sink: [-1, 1, 0.01], rubblePerRock: [0, 12, 1], rubbleSize: [0.02, 0.6, 0.01], 'cliff.depth': [0, 2, 0.01], 'climate.height': [-0.2, 0.2, 0.005], 'quarry.radius': [0.03, 0.2, 0.002], distance: [0, 0.45, 0.005],
  'valley.width': [0, 0.4, 0.005],
};
const KIND_LABEL: Record<TemplateKind, string> = {
  highspot: 'high spot', lake: 'lake', pond: 'bog / pond', river: 'river', forest: 'forest', rocky: 'rocky patches', quarry: 'quarry',
  climate: 'climate', valley: 'valley', fields: 'fields', perimeter: 'perimeter', cliff: 'cliffs',
};
const HAS_SHAPE: TemplateKind[] = ['highspot', 'lake', 'pond', 'river', 'forest'];

/** A starting shape for a new template of this kind. */
function defaultShape(kind: TemplateKind): Pick<TerrainTemplate, 'points' | 'blobs'> {
  const ring = (n: number, extra?: number) => Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2, r = 1 + 0.12 * Math.sin(i * 2.3);
    return extra === undefined ? [Math.cos(a) * r, Math.sin(a) * r] : [Math.cos(a) * r, Math.sin(a) * r, extra];
  });
  if (kind === 'river') return { points: [[-1, 0, 1], [-0.3, 0.3, 1], [0.4, -0.2, 1.1], [1, 0, 1]] };
  if (kind === 'forest') return { blobs: [{ points: ring(8).map(([x, y]) => [x * 0.25 - 0.3, y * 0.25]) }] };
  if (kind === 'highspot') return { points: ring(8, 1) };
  if (kind === 'lake' || kind === 'pond') return { points: ring(8) };
  return {};
}

export function createTemplateEditor(ctx: EditorContext) {
  const selected: Partial<Record<string, string>> = {}; // tab kinds key -> template name
  let blobIndex = 0;
  let view: LocationView | undefined;
  let previewSeed = 0;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const kindsKey = (kinds: TemplateKind[]) => kinds.join(',');
  const listFor = (kinds: TemplateKind[]) => getTemplates().filter((t) => kinds.includes(t.kind));
  const current = (kinds: TemplateKind[]): TerrainTemplate | undefined => {
    const list = listFor(kinds);
    return list.find((t) => t.name === selected[kindsKey(kinds)]) ?? list[0];
  };

  /** Templates changed: refresh the engine, save to the server (debounced), rebuild the preview. */
  function changed(rerenderPanel = false): void {
    setTemplates(getTemplates()); // clears the terrain caches
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/templates', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(getTemplates()) });
        ctx.status(res.ok ? 'templates saved on the server (data/templates.json) – reload a location page to see them' : `saving templates failed (${res.status})`);
      } catch {
        ctx.status('saving templates failed (server not reachable)');
      }
    }, 400);
    if (rerenderPanel) ctx.renderPanel();
    clearTimeout(rebuildTimer); // building a whole location takes a moment: wait until the edits pause
    rebuildTimer = setTimeout(() => ctx.rebuild(), 250);
  }

  // ---------- panel ----------
  function panel(kinds: TemplateKind[]): void {
    const el = ctx.knobsEl;
    const list = listFor(kinds);
    const t = current(kinds);
    const h3 = (text: string) => el.append(Object.assign(document.createElement('h3'), { textContent: text }));
    h3('Templates (= location traits)');
    const head = document.createElement('div');
    head.className = 'shape-head';
    const sel = document.createElement('select');
    for (const x of list) sel.append(Object.assign(document.createElement('option'), { value: x.name, textContent: `${x.title} (${x.name}) – ${KIND_LABEL[x.kind]}`, selected: x === t }));
    sel.onchange = () => { selected[kindsKey(kinds)] = sel.value; blobIndex = 0; ctx.renderPanel(); ctx.rebuild(); };
    const btn = (text: string, onClick: () => void) => Object.assign(document.createElement('button'), { className: 'btn', textContent: text, onclick: onClick });
    const kindSel = document.createElement('select');
    for (const k of kinds) kindSel.append(Object.assign(document.createElement('option'), { value: k, textContent: KIND_LABEL[k] }));
    const uniqueName = (base: string) => { let n = base, i = 2; while (getTemplates().some((x) => x.name === n)) n = `${base}-${i++}`; return n; };
    head.append(sel,
      ...(kinds.length > 1 ? [kindSel] : []),
      btn('+ new', () => {
        const kind = (kinds.length > 1 ? kindSel.value : kinds[0]) as TemplateKind;
        const name = uniqueName(`new-${kind}`);
        getTemplates().push({ name, title: `New ${KIND_LABEL[kind]}`, kind, chance: 0.1, params: JSON.parse(JSON.stringify(KIND_DEFAULTS[kind])), ...defaultShape(kind) });
        selected[kindsKey(kinds)] = name;
        changed(true);
      }),
      ...(t ? [
        btn('🎲 re-roll preview', () => { previewSeed++; ctx.rebuild(); }),
        btn('duplicate', () => {
          const copy: TerrainTemplate = JSON.parse(JSON.stringify(t));
          copy.name = uniqueName(t.name);
          copy.title = `${t.title} copy`;
          getTemplates().push(copy);
          selected[kindsKey(kinds)] = copy.name;
          changed(true);
        }),
        btn('delete', () => {
          if (!confirm(`Delete template "${t.title}" (${t.name})? Locations with this trait lose it.`)) return;
          getTemplates().splice(getTemplates().indexOf(t), 1);
          selected[kindsKey(kinds)] = undefined;
          changed(true);
        }),
      ] : []));
    el.append(head);
    if (!t) { el.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No templates of this kind yet – add one.' })); return; }

    // name / title / chance
    const row = (label: string, input: HTMLElement, cls = 'knob') => {
      const r = document.createElement('label');
      r.className = cls;
      r.append(Object.assign(document.createElement('span'), { textContent: label }), input);
      el.append(r);
    };
    const text = (value: string, onChange: (v: string) => void) => {
      const i = Object.assign(document.createElement('input'), { type: 'text', value });
      i.onchange = () => onChange(i.value.trim());
      return i;
    };
    row('trait id (name)', text(t.name, (v) => {
      if (!/^[\w-]{1,40}$/.test(v) || getTemplates().some((x) => x !== t && x.name === v)) { ctx.status(`"${v}" is not a valid / free name (letters, digits, - and _)`); ctx.renderPanel(); return; }
      t.name = v;
      selected[kindsKey(kinds)] = v;
      changed(true);
    }));
    row('title', text(t.title, (v) => { t.title = v || t.name; changed(true); }));
    slider('chance', t.chance, 0, 1, 0.01, (v) => { t.chance = v; changed(); });

    // params
    h3(`${KIND_LABEL[t.kind]} settings`);
    const params = { ...KIND_DEFAULTS[t.kind], ...t.params };
    for (const [k, v] of Object.entries(params)) {
      const range = RANGES[`${t.kind}.${k}`] ?? RANGES[k] ?? [0, 1, 0.01];
      if (typeof v === 'number') slider(k, v, ...range, (nv) => { t.params[k] = nv; changed(); });
      else if (Array.isArray(v)) {
        const pair = [...v] as [number, number];
        slider(`${k} (min)`, pair[0], ...range, (nv) => { pair[0] = Math.min(nv, pair[1]); t.params[k] = [...pair]; changed(); });
        slider(`${k} (max)`, pair[1], ...range, (nv) => { pair[1] = Math.max(nv, pair[0]); t.params[k] = [...pair]; changed(); });
      } else if (typeof v === 'boolean') {
        const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: v });
        box.onchange = () => { t.params[k] = box.checked; changed(); };
        row(k, box, 'knob check');
      } else if (typeof v === 'string' && v.startsWith('#')) { // colour
        const ci = Object.assign(document.createElement('input'), { type: 'color', value: v });
        ci.oninput = () => { t.params[k] = ci.value; changed(); };
        row(k, ci, 'knob check');
      } else {
        const s = document.createElement('select');
        const opts = (PARAM_OPTIONS[k] ?? [String(v)]).filter((o) => k !== 'mode' || (t.kind === 'river' ? ['line', 'loop'] : ['nearby', 'island', 'peninsula']).includes(o));
        for (const o of opts) s.append(Object.assign(document.createElement('option'), { value: o, textContent: o, selected: o === v }));
        s.onchange = () => { t.params[k] = s.value; changed(); };
        row(k, s, 'knob check');
      }
    }

    // shape
    if (HAS_SHAPE.includes(t.kind)) {
      h3('Shape');
      if (t.kind === 'forest') {
        const blobs = (t.blobs ??= []);
        blobIndex = Math.min(blobIndex, Math.max(0, blobs.length - 1));
        const bh = document.createElement('div');
        bh.className = 'shape-head';
        const bs = document.createElement('select');
        blobs.forEach((_, i) => bs.append(Object.assign(document.createElement('option'), { value: String(i), textContent: `forest patch ${i + 1} / ${blobs.length}`, selected: i === blobIndex })));
        bs.onchange = () => { blobIndex = Number(bs.value); };
        bh.append(bs,
          btn('+ patch', () => { blobs.push(defaultShape('forest').blobs![0]); blobIndex = blobs.length - 1; changed(true); }),
          btn('− patch', () => { if (blobs.length) { blobs.splice(blobIndex, 1); blobIndex = Math.max(0, blobIndex - 1); changed(true); } }));
        el.append(bh);
      }
      const extra = t.kind === 'highspot' ? ' · mouse wheel on a point: height there' : t.kind === 'river' ? ' · mouse wheel on a point: river width there' : '';
      el.append(Object.assign(document.createElement('p'), {
        className: 'hint',
        textContent: `Edit in the viewport, on the see-through plane: drag the yellow points · double-click the plane: add a point${t.kind === 'forest' ? ' (to the nearest patch)' : ''} · right-click a point: remove it${extra}. The terrain updates when you let go.`,
      }));
    }
  }

  function slider(name: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void): void {
    const r = document.createElement('label');
    r.className = 'knob';
    // min / max / step before value: a range input clamps the value to its current bounds
    const num = Object.assign(document.createElement('input'), { type: 'number', min: String(min), max: String(max), step: String(step) });
    const range = Object.assign(document.createElement('input'), { type: 'range', min: String(min), max: String(max), step: String(step) });
    num.value = range.value = String(value);
    range.oninput = () => { num.value = range.value; onInput(Number(range.value)); };
    num.onchange = () => { range.value = num.value; onInput(Number(num.value)); };
    r.append(Object.assign(document.createElement('span'), { textContent: name }), num, range);
    ctx.knobsEl.append(r);
  }

  // ---------- preview ----------
  const SIZE = 40, HANDLE_Y = 2.2;
  function previewLocation(t: TerrainTemplate): LocationDef {
    const traits = [t.name];
    // cliff types: shown on a steep test hill (a helper, not a trait)
    const hill: TerrainTemplate = { name: '__cliff-test-hill', title: 'test hill', kind: 'highspot', chance: 0,
      params: { ...KIND_DEFAULTS.highspot, radius: 0.22, slope: 0.07, height: 0.35, tierHeight: 0 },
      points: Array.from({ length: 10 }, (_, i) => { const a = (i / 10) * Math.PI * 2, r = 1 + 0.18 * Math.sin(i * 2.7); return [Math.cos(a) * r, Math.sin(a) * r, 1]; }) };
    const id = `template-preview-${previewSeed}`; // 🎲 re-roll: another seed = other random placement
    if (t.kind === 'cliff') { traits.push(hill.name); return { id, name: 'preview', type: 'hut', tier: 2, lat: 0, lng: 0, traits, preview: true, extraTemplates: [hill] }; }
    return { id, name: 'preview', type: 'hut', tier: 2, lat: 0, lng: 0, traits, preview: true };
  }

  /** Preview = a real location generated by the location builder from just this template (+ what it needs). */
  function preview(kinds: TemplateKind[]): void {
    view = undefined;
    const t = current(kinds);
    if (!t) return;
    const group = new THREE.Group();
    group.position.set(-SIZE / 2, 0, -SIZE / 2); // location tiles 0..40 -> centred on the preview
    // trees only where the template is about them (forest); grass never – both are slow to build
    view = new LocationView({ embed: group, trees: t.kind === 'forest', grass: false }, 12345, previewLocation(t));
    ctx.preview.add(group);
    buildHandles(t);
  }

  // ---------- viewport shape handles ----------
  interface Shape {
    pts: number[][]; // the template's points (edited in place)
    closed: boolean;
    extra: number | null; // index of the per-point value changed with the wheel
    toWorld: (p: number[]) => [number, number];
    fromWorld: (x: number, z: number) => [number, number];
    outline: () => THREE.Vector3[];
  }
  interface Handles { template: TerrainTemplate; shapes: Shape[]; spheres: THREE.Mesh[]; refs: [number, number][]; outlines: THREE.Line[]; rings: THREE.Line[] }
  let handles: Handles | undefined;
  const handleMat = new THREE.MeshBasicMaterial({ color: '#ffd66b', depthTest: false });
  const handleHot = new THREE.MeshBasicMaterial({ color: '#fff3c4', depthTest: false });
  const lineMat = new THREE.LineBasicMaterial({ color: '#9fd3f0', depthTest: false });
  const ringMat = new THREE.LineDashedMaterial({ color: '#ffd66b', depthTest: false, dashSize: 0.3, gapSize: 0.2 });

  /** A closed outline (points in fixed order, spline through them) drawn at scale k (tiles per unit). */
  function closedShape(pts: number[][], k: number, extra: number | null): Shape {
    return {
      pts, closed: true, extra,
      toWorld: (p) => [p[0] * k, p[1] * k],
      fromWorld: (x, z) => [x / k, z / k],
      outline: () => {
        const loop = splineLoop(pts);
        return [...loop, loop[0]].filter(Boolean).map(([x, y]) => new THREE.Vector3(x * k, HANDLE_Y, y * k));
      },
    };
  }

  function shapesOf(t: TerrainTemplate): Shape[] {
    const p = { ...KIND_DEFAULTS[t.kind], ...t.params } as Record<string, any>;
    if (t.kind === 'river') {
      const pts = (t.points ??= defaultShape('river').points!), sx = 20, sz = 10 * Number(p.straight);
      return [{
        pts, closed: false, extra: 2,
        toWorld: (q) => [q[0] * sx, q[1] * sz],
        fromWorld: (x, z) => [Math.max(-1, Math.min(1, x / sx)), sz ? z / sz : 0],
        outline: () => riverPolyline({ points: pts as [number, number, number][] }).slice(1, -1).map(([u, v]) => new THREE.Vector3(u * sx, HANDLE_Y, v * sz)),
      }];
    }
    if (t.kind === 'forest') return (t.blobs ??= []).map((b) => closedShape(b.points, 20, null)); // map coords: ±1 = ±20 tiles
    const pts = (t.points ??= defaultShape(t.kind).points!);
    // radius on the terrain (tiles) the outline's mean radius maps to – as the engine lays it out for previews
    const R = t.kind === 'highspot' ? Number(p.radius) * 20
      : t.kind === 'pond' ? (Array.isArray(p.size) ? p.size[1] : 0.06) * 3 * 40
      : p.mode === 'nearby' ? Number(p.radius) * 2 * 40 : 0.4 * 20;
    return [closedShape(pts, R, t.kind === 'highspot' ? 2 : null)]; // fixed scale: 1 template unit = the radius setting
  }

  function buildHandles(t: TerrainTemplate): void {
    handles = undefined;
    if (!HAS_SHAPE.includes(t.kind)) return;
    const group = new THREE.Group();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), new THREE.MeshBasicMaterial({ color: '#9fd3f0', transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = HANDLE_Y;
    plane.renderOrder = 9;
    group.add(plane);
    const shapes = shapesOf(t), spheres: THREE.Mesh[] = [], refs: [number, number][] = [], outlines: THREE.Line[] = [], rings: THREE.Line[] = [];
    const sphereGeo = new THREE.SphereGeometry(0.35, 12, 8);
    const ringPts = Array.from({ length: 33 }, (_, i) => new THREE.Vector3(Math.cos((i / 32) * Math.PI * 2) * 1.2, 0, Math.sin((i / 32) * Math.PI * 2) * 1.2));
    shapes.forEach((sh, si) => {
      const ol = new THREE.Line(new THREE.BufferGeometry(), lineMat);
      ol.renderOrder = 10;
      outlines.push(ol);
      group.add(ol);
      sh.pts.forEach((_, pi) => {
        const s = new THREE.Mesh(sphereGeo, handleMat);
        s.renderOrder = 11;
        s.userData.ref = spheres.length;
        spheres.push(s);
        refs.push([si, pi]);
        group.add(s);
        if (sh.extra !== null) {
          const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), ringMat);
          ring.computeLineDistances();
          ring.renderOrder = 10;
          ring.userData.ref = spheres.length - 1;
          rings.push(ring);
          group.add(ring);
        }
      });
    });
    handles = { template: t, shapes, spheres, refs, outlines, rings };
    refreshHandles();
    ctx.preview.add(group);
  }

  function refreshHandles(): void {
    if (!handles) return;
    const { shapes, spheres, refs, outlines, rings } = handles;
    spheres.forEach((s, i) => { const [si, pi] = refs[i], [x, z] = shapes[si].toWorld(shapes[si].pts[pi]); s.position.set(x, HANDLE_Y, z); });
    outlines.forEach((ol, si) => {
      const pts = shapes[si].outline();
      if (shapes[si].closed === false || pts.length) ol.geometry.setFromPoints(pts);
    });
    rings.forEach((ring) => {
      const [si, pi] = refs[ring.userData.ref], sh = shapes[si];
      const [x, z] = sh.toWorld(sh.pts[pi]);
      ring.position.set(x, HANDLE_Y, z);
      ring.scale.setScalar(sh.pts[pi][sh.extra!] ?? 1);
    });
  }

  // pointer interaction (registered once; active on template tabs only)
  {
    const { canvas } = ctx;
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -HANDLE_Y), hit = new THREE.Vector3();
    let drag: number | null = null, hot: THREE.Mesh | null = null;
    const aim = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, ctx.camera);
    };
    const pick = (e: MouseEvent): THREE.Mesh | null => {
      if (!ctx.activeKinds() || !handles) return null;
      aim(e);
      return (ray.intersectObjects(handles.spheres)[0]?.object as THREE.Mesh) ?? null;
    };
    const onPlane = (e: MouseEvent): [number, number] | null => { aim(e); return ray.ray.intersectPlane(plane, hit) ? [hit.x, hit.z] : null; };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const h = pick(e);
      if (!h) return;
      drag = h.userData.ref;
      ctx.controls.enabled = false; // runs before OrbitControls (capture), so the camera stays put
      canvas.setPointerCapture(e.pointerId);
    }, { capture: true });
    canvas.addEventListener('pointermove', (e) => {
      if (drag === null || !handles) {
        const h = pick(e);
        if (hot !== h) { if (hot) hot.material = handleMat; hot = h; if (hot) hot.material = handleHot; canvas.style.cursor = hot ? 'grab' : ''; }
        return;
      }
      const at = onPlane(e);
      if (!at) return;
      const [si, pi] = handles.refs[drag], sh = handles.shapes[si], [u, v] = sh.fromWorld(at[0], at[1]);
      sh.pts[pi][0] = u;
      sh.pts[pi][1] = v;
      refreshHandles();
    });
    canvas.addEventListener('pointerup', () => {
      if (drag === null) return;
      drag = null;
      ctx.controls.enabled = true;
      changed();
    });
    canvas.addEventListener('dblclick', (e) => {
      if (!handles || pick(e)) return;
      const at = onPlane(e);
      if (!at) return;
      // insert into the nearest segment between two neighbouring points (order stays fixed)
      let best: { sh: Shape; at: number; d: number } | null = null;
      for (const sh of handles.shapes) {
        const n = sh.pts.length, segs = sh.closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
          const [ax, az] = sh.toWorld(sh.pts[i]), [bx, bz] = sh.toWorld(sh.pts[(i + 1) % n]);
          const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1e-9;
          const u = Math.max(0, Math.min(1, ((at[0] - ax) * dx + (at[1] - az) * dz) / len2));
          const d = Math.hypot(at[0] - ax - dx * u, at[1] - az - dz * u);
          // open line: beyond an end point -> extend the line there
          const pos = !sh.closed && i === 0 && u === 0 ? 0 : !sh.closed && i === segs - 1 && u === 1 ? n : i + 1;
          if (!best || d < best.d) best = { sh, at: pos, d };
        }
      }
      if (!best) return;
      const [u, v] = best.sh.fromWorld(at[0], at[1]);
      const nb = best.sh.pts[Math.min(best.at, best.sh.pts.length - 1)];
      best.sh.pts.splice(best.at, 0, best.sh.extra !== null ? [u, v, nb?.[best.sh.extra] ?? 1] : [u, v]);
      changed();
    });
    canvas.addEventListener('contextmenu', (e) => {
      const h = pick(e);
      if (!h || !handles) return;
      e.preventDefault();
      const [si, pi] = handles.refs[h.userData.ref], sh = handles.shapes[si];
      if (sh.pts.length > (sh.closed ? 3 : 2)) { sh.pts.splice(pi, 1); changed(); }
    });
    canvas.addEventListener('wheel', (e) => {
      const h = pick(e);
      if (!h || !handles) return;
      const [si, pi] = handles.refs[h.userData.ref], sh = handles.shapes[si];
      if (sh.extra === null) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // no camera zoom while changing the value
      sh.pts[pi][sh.extra] = Math.max(0.1, Math.min(4, (sh.pts[pi][sh.extra] ?? 1) * (e.deltaY < 0 ? 1.08 : 0.93)));
      refreshHandles();
      changed();
    }, { capture: true, passive: false });
  }

  return {
    panel,
    preview,
    update: (time: number) => view?.update(time),
    dispose: () => { view?.dispose(); view = undefined; handles = undefined; },
  };
}
