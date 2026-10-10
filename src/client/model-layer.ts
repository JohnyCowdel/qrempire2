// MapLibre custom layer that renders 3D assets (STL) with three.js, sharing the map's
// WebGL context and depth buffer (so models occlude/are occluded by 3D buildings).
//
// The three.js scene lives in a local metric frame around an origin: x = east, y = north,
// z = up, in metres. One matrix maps that frame into MapLibre's Mercator space, so each
// model is just positioned in metres – no per-model projection math, good float precision.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { LatLng, ModelPlacement } from '../engine/index.ts';

declare const maplibregl: any;

const geometryCache = new Map<string, Promise<THREE.BufferGeometry>>();

/** Load + normalise an STL once per URL: centred on X/Y, base at Z = 0. */
function loadGeometry(url: string): Promise<THREE.BufferGeometry> {
  let promise = geometryCache.get(url);
  if (!promise) {
    promise = new STLLoader().loadAsync(url).then((g) => {
      g.computeBoundingBox();
      const b = g.boundingBox!;
      g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      return g;
    });
    geometryCache.set(url, promise);
  }
  return promise;
}

export class ModelLayer {
  readonly id: string;
  readonly type = 'custom';
  readonly renderingMode = '3d';

  private map: any;
  private renderer?: THREE.WebGLRenderer;
  private readonly camera = new THREE.Camera();
  private readonly scene = new THREE.Scene();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private readonly meshes = new Map<string, THREE.Mesh>();
  private origin?: { x: number; y: number; z: number; unitsPerMeter: number };
  private placements: ModelPlacement[];

  constructor(id: string, placements: ModelPlacement[] = []) {
    this.id = id;
    this.placements = placements;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8c74, 2.0), this.sun);
    this.setSun(315, 45);
  }

  // ---- MapLibre CustomLayerInterface ----

  onAdd(map: any, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.setPlacements(this.placements);
  }

  onRemove(): void {
    for (const mesh of this.meshes.values()) (mesh.material as THREE.Material).dispose();
    this.meshes.clear();
    this.renderer?.dispose();
  }

  render(_gl: WebGL2RenderingContext, args: any): void {
    if (!this.origin || !this.renderer) return;
    const o = this.origin;
    // MapLibre v5 passes projection data; v4 passed the matrix directly.
    const mapMatrix = new THREE.Matrix4().fromArray(args?.defaultProjectionData?.mainMatrix ?? args);
    // local metres -> mercator units; Mercator y grows southwards, hence -y.
    const local = new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).scale(new THREE.Vector3(o.unitsPerMeter, -o.unitsPerMeter, o.unitsPerMeter));
    this.camera.projectionMatrix = mapMatrix.multiply(local);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }

  // ---- API ----

  /** Replace all placed models. The first placement becomes the local frame origin. */
  setPlacements(placements: ModelPlacement[]): void {
    this.placements = placements;
    for (const mesh of this.meshes.values()) this.scene.remove(mesh);
    this.meshes.clear();
    if (!placements.length) return;
    this.origin = this.makeOrigin(placements[0]);
    for (const p of placements) void this.addMesh(p);
  }

  /** Light direction in the same convention as the hillshade: degrees from north, clockwise. */
  setSun(directionDeg: number, altitudeDeg: number): void {
    const d = (directionDeg * Math.PI) / 180, a = (altitudeDeg * Math.PI) / 180;
    this.sun.position.set(Math.sin(d) * Math.cos(a), Math.cos(d) * Math.cos(a), Math.sin(a)).multiplyScalar(100);
    this.map?.triggerRepaint();
  }

  // ---- internals ----

  private makeOrigin(p: LatLng) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([p.lng, p.lat], 0);
    return { x: m.x, y: m.y, z: m.z, unitsPerMeter: m.meterInMercatorCoordinateUnits() };
  }

  private async addMesh(p: ModelPlacement): Promise<void> {
    const geometry = await loadGeometry(p.url);
    if (!this.placements.includes(p) || !this.origin) return; // replaced while loading
    const material = new THREE.MeshStandardMaterial({ color: p.color ?? '#bfb5a5', roughness: 0.85, flatShading: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    const m = maplibregl.MercatorCoordinate.fromLngLat([p.lng, p.lat], 0);
    mesh.position.set((m.x - this.origin.x) / this.origin.unitsPerMeter, -(m.y - this.origin.y) / this.origin.unitsPerMeter, p.altitude ?? 0);
    mesh.rotation.z = (-(p.rotation ?? 0) * Math.PI) / 180; // clockwise from north
    mesh.scale.setScalar((p.unitsToMeters ?? 0.001) * (p.scale ?? 1));
    mesh.frustumCulled = false; // our camera only has a combined matrix; three's culling would misjudge it
    this.scene.add(mesh);
    this.meshes.set(p.id, mesh);
    this.map?.triggerRepaint();
  }
}
