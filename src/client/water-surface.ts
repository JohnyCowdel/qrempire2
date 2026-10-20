// Lake/river surface for the 3D location view: a real-time planar reflection (three.js
// Reflector renders the scene mirrored in the water plane) seen through animated, procedural
// ripples – the reflection wobbles, a fresnel term mixes water colour and reflection by view
// angle, and the ripples catch the sun as glints. No textures needed.
import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { DECOR } from './location-decor.ts';

// ======================= KNOBS =======================
// Colour, transparency, reflection and ripples are per water environment (lake / pond / river):
// DECOR.water in location-decor.ts (asset editor → Water). These are shared:
export const WATER_SURFACE = {
  reflection: true, // false = cheap non-reflective water (no second scene render)
  resolution: 0.5, // reflection texture size relative to the screen
  sparkle: 1.2, // sun glints on the ripples
  sunColor: '#ffcf9a',
};
// =====================================================

const vertexShader = /* glsl */ `
  uniform mat4 textureMatrix;
  varying vec4 vUv;
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vUv = textureMatrix * vec4(position, 1.0);
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform sampler2D tDiffuse;
  uniform float uTime, uSparkle, uHasReflection, uHasMask;
  uniform vec3 uSunDir, uSunColor;
  // per environment (x = lake, y = pond, z = river), blended by the environment mask
  uniform sampler2D uMask;
  uniform vec4 uMaskRect; // x0, z0, width, depth of the mask in world units
  uniform vec3 uColL, uColP, uColR, uOpac3, uRefl3, uWScale3, uWSpeed3, uWStr3;
  float gScale = 1.0, gSpeed = 1.0;
  varying vec4 vUv;
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  float wHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float wNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p), w = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1, 0)), w.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), w.x), w.y);
  }
  // two layers of noise drifting in different directions = ripples
  float waves(vec2 p) {
    float t = uTime * gSpeed;
    return 0.6 * wNoise(p * gScale + vec2(t, t * 0.7)) + 0.4 * wNoise(p * gScale * 2.3 - vec2(t * 0.8, -t * 1.1));
  }

  void main() {
    vec2 p = vWorld.xz;
    vec3 env = vec3(1.0, 0.0, 0.0);
    if (uHasMask > 0.5) env = texture2D(uMask, (p - uMaskRect.xy) / uMaskRect.zw).rgb;
    float es = env.x + env.y + env.z;
    env = es > 0.02 ? env / es : vec3(1.0, 0.0, 0.0);
    gScale = dot(env, uWScale3); gSpeed = dot(env, uWSpeed3);
    float uWaveStrength = dot(env, uWStr3), uOpacity = dot(env, uOpac3), uReflectivity = dot(env, uRefl3);
    vec3 uWaterColor = uColL * env.x + uColP * env.y + uColR * env.z;
    float e = 0.15 / gScale;
    float h = waves(p);
    vec2 g = vec2(waves(p + vec2(e, 0.0)) - h, waves(p + vec2(0.0, e)) - h) / e; // ripple slope
    vec3 N = normalize(vec3(-g.x * 0.12, 1.0, -g.y * 0.12));
    vec3 V = normalize(cameraPosition - vWorld);

    vec3 refl = uWaterColor;
    if (uHasReflection > 0.5) {
      vec4 uv = vUv;
      uv.xy += g * uWaveStrength * uv.w; // ripples wobble the mirrored image
      refl = texture2DProj(tDiffuse, uv).rgb;
    }
    float fresnel = 0.2 + 0.8 * pow(1.0 - max(dot(N, V), 0.0), 3.0);
    vec3 col = mix(uWaterColor, refl, clamp(fresnel * uReflectivity, 0.0, 1.0));
    col *= 0.92 + 0.16 * h; // ripple shading
    float spec = pow(max(dot(N, normalize(V + uSunDir)), 0.0), 160.0) * uSparkle;
    col += uSunColor * spec;

    gl_FragColor = vec4(col, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/**
 * Build the water plane (y = 0, centred at cx/cz). `env` = environment mask (waterMaskTexture) and
 * the world rectangle it covers; without it the whole surface looks like a lake. Call `update(time)`
 * every frame (also picks up changed DECOR.water settings).
 */
export function createWater(size: number, cx: number, cz: number, sunDirection: THREE.Vector3, env?: { mask: THREE.Texture; x0: number; z0: number; size: number }):
  { mesh: THREE.Mesh; update: (time: number) => void } {
  const S = WATER_SURFACE;
  const v3 = () => ({ value: new THREE.Vector3() });
  const uniforms = {
    color: { value: new THREE.Color('#ffffff') },
    tDiffuse: { value: null as THREE.Texture | null },
    textureMatrix: { value: new THREE.Matrix4() },
    uTime: { value: 0 }, uSparkle: { value: S.sparkle }, uHasReflection: { value: S.reflection ? 1 : 0 },
    uSunDir: { value: sunDirection.clone().normalize() }, uSunColor: { value: new THREE.Color(S.sunColor) },
    uMask: { value: env?.mask ?? null }, uHasMask: { value: env ? 1 : 0 },
    uMaskRect: { value: new THREE.Vector4(env?.x0 ?? 0, env?.z0 ?? 0, env?.size ?? 1, env?.size ?? 1) },
    uColL: { value: new THREE.Color() }, uColP: { value: new THREE.Color() }, uColR: { value: new THREE.Color() },
    uOpac3: v3(), uRefl3: v3(), uWScale3: v3(), uWSpeed3: v3(), uWStr3: v3(),
    ...THREE.UniformsLib.fog,
  };
  const syncEnv = () => {
    const { lake: L, pond: P, river: R } = DECOR.water;
    uniforms.uColL.value.set(L.color); uniforms.uColP.value.set(P.color); uniforms.uColR.value.set(R.color);
    uniforms.uOpac3.value.set(L.opacity, P.opacity, R.opacity);
    uniforms.uRefl3.value.set(L.reflectivity, P.reflectivity, R.reflectivity);
    uniforms.uWScale3.value.set(L.waveScale, P.waveScale, R.waveScale);
    uniforms.uWSpeed3.value.set(L.waveSpeed, P.waveSpeed, R.waveSpeed);
    uniforms.uWStr3.value.set(L.waveStrength, P.waveStrength, R.waveStrength);
  };
  syncEnv();
  const shader = { name: 'WaterSurface', uniforms, vertexShader, fragmentShader };
  const geometry = new THREE.PlaneGeometry(size, size);

  let mesh: THREE.Mesh;
  if (S.reflection) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    mesh = new Reflector(geometry, {
      clipBias: 0.003,
      textureWidth: Math.round(window.innerWidth * dpr * S.resolution),
      textureHeight: Math.round(window.innerHeight * dpr * S.resolution),
      shader,
    });
  } else {
    mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader }));
  }
  const material = mesh.material as THREE.ShaderMaterial;
  material.transparent = true;
  material.fog = true; // three refreshes the fog uniforms for us
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(cx, 0, cz);
  mesh.renderOrder = 1;

  return {
    mesh,
    update: (time) => {
      material.uniforms.uTime.value = time;
      syncEnv();
    },
  };
}
