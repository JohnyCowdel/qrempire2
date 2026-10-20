// RTS-style camera (Age of Empires 3 feel): looks down at a ground target from a tilted angle.
//   scroll: WASD / arrow keys, mouse at the screen edge, or drag (any mouse button)
//   zoom:   mouse wheel – the view also flattens a little as you get closer
//   rotate: Q / E
import * as THREE from 'three';

// ======================= KNOBS =======================
export const RTS = {
  minDistance: 7, // zoom limits (world units = tiles)
  maxDistance: 34,
  pitchFar: 58, // degrees above the horizon when zoomed out…
  pitchNear: 38, // …and when zoomed in
  panSpeed: 1.1, // keyboard/edge scroll speed, × distance per second
  edgePx: 14, // edge-scroll band width; 0 = off
  rotateSpeed: 90, // degrees per second for Q / E
  zoomStep: 0.12, // fraction of the distance per wheel notch
  smoothing: 10, // higher = snappier camera motion
};
// =====================================================

export class RtsCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Fires on a click that wasn't a drag (client coords). */
  onClick?: (x: number, y: number) => void;

  private readonly dom: HTMLElement;
  private readonly bounds: { cx: number; cz: number; radius: number }; // the target stays inside this circle
  private readonly target = new THREE.Vector3();
  private readonly goal = new THREE.Vector3(); // target we're easing towards
  private distance: number;
  private goalDistance: number;
  private yaw = 0; // 0 = looking north (towards -z)
  private readonly keys = new Set<string>();
  private mouse: { x: number; y: number } | null = null;
  /**
   * Drag state. The camera is FROZEN at drag start and every move is measured against that copy:
   * several pointer events can arrive per frame, and measuring against the live (lagging) camera
   * made each event overshoot and snap back – the violent shaking.
   */
  private drag: { x: number; y: number; moved: boolean; grab: THREE.Vector3; startGoal: THREE.Vector3; cam: THREE.PerspectiveCamera } | null = null;
  private readonly ray = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // invisible drag plane

  constructor(dom: HTMLElement, center: THREE.Vector3, bounds: { cx: number; cz: number; radius: number }) {
    this.dom = dom;
    this.bounds = bounds;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 400);
    this.target.copy(center);
    this.goal.copy(center);
    this.distance = this.goalDistance = (RTS.minDistance + RTS.maxDistance) / 2;

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('mouseleave', () => (this.mouse = null));
    dom.addEventListener('pointermove', (e) => this.pointerMove(e));
    dom.addEventListener('pointerdown', (e) => {
      dom.setPointerCapture(e.pointerId);
      this.goal.copy(this.target); // stop any easing so the frozen camera matches what's on screen
      const cam = this.camera.clone();
      cam.updateMatrixWorld();
      const grab = this.groundAt(e.clientX, e.clientY, cam) ?? this.target.clone();
      this.drag = { x: e.clientX, y: e.clientY, moved: false, grab, startGoal: this.goal.clone(), cam };
    });
    dom.addEventListener('pointerup', (e) => {
      if (this.drag && !this.drag.moved && e.button === 0) this.onClick?.(e.clientX, e.clientY);
      this.drag = null;
    });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = 1 + Math.sign(e.deltaY) * RTS.zoomStep;
      this.goalDistance = THREE.MathUtils.clamp(this.goalDistance * factor, RTS.minDistance, RTS.maxDistance);
    }, { passive: false });
  }

  /** Call once per frame. */
  update(dt: number, width: number, height: number): void {
    if (this.camera.aspect !== width / height) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    // Keyboard + edge scrolling, relative to the camera's facing.
    let dx = 0, dz = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) dz -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dz += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += 1;
    if (this.mouse && RTS.edgePx > 0 && !this.drag) {
      if (this.mouse.x < RTS.edgePx) dx -= 1;
      if (this.mouse.x > width - RTS.edgePx) dx += 1;
      if (this.mouse.y < RTS.edgePx) dz -= 1;
      if (this.mouse.y > height - RTS.edgePx) dz += 1;
    }
    if (this.keys.has('q')) this.yaw += THREE.MathUtils.degToRad(RTS.rotateSpeed) * dt;
    if (this.keys.has('e')) this.yaw -= THREE.MathUtils.degToRad(RTS.rotateSpeed) * dt;
    if (dx || dz) {
      const speed = RTS.panSpeed * this.distance * dt;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      this.goal.x += (dx * cos + dz * sin) * speed;
      this.goal.z += (-dx * sin + dz * cos) * speed;
    }
    // keep the target inside the round play area
    const bx = this.goal.x - this.bounds.cx, bz = this.goal.z - this.bounds.cz, bd = Math.hypot(bx, bz);
    if (bd > this.bounds.radius) {
      this.goal.x = this.bounds.cx + (bx / bd) * this.bounds.radius;
      this.goal.z = this.bounds.cz + (bz / bd) * this.bounds.radius;
    }

    // Ease towards the goal.
    const k = 1 - Math.exp(-RTS.smoothing * dt);
    this.target.lerp(this.goal, k);
    this.distance += (this.goalDistance - this.distance) * k;

    // Place the camera: pitch flattens as we zoom in.
    const zoomT = (this.distance - RTS.minDistance) / (RTS.maxDistance - RTS.minDistance);
    const pitch = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(RTS.pitchNear, RTS.pitchFar, zoomT));
    const horiz = Math.cos(pitch) * this.distance;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horiz,
      this.target.y + Math.sin(pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * horiz,
    );
    this.camera.lookAt(this.target);
  }

  /** Normalised device coords for a client point (for raycasting). */
  ndc(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.dom.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  private groundAt(clientX: number, clientY: number, cam: THREE.Camera = this.camera): THREE.Vector3 | null {
    this.ray.setFromCamera(this.ndc(clientX, clientY), cam);
    return this.ray.ray.intersectPlane(this.ground, new THREE.Vector3());
  }

  private pointerMove(e: PointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (!this.drag) return;
    if (Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 4) this.drag.moved = true;
    if (!this.drag.moved) return;
    // Grab-the-ground panning against the frozen camera: absolute, so it can't oscillate.
    const now = this.groundAt(e.clientX, e.clientY, this.drag.cam);
    if (now) {
      this.goal.copy(this.drag.startGoal).add(this.drag.grab.clone().sub(now));
      this.target.copy(this.goal); // follow the hand directly while dragging
    }
  }
}
