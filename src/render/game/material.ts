// Material for game entities: environment lighting + aerial perspective like every map shader (shaders/gameobj.*).
// The material must be registered with `World.addFogMaterial` so its fog uniforms follow the game camera each frame.
import * as THREE from 'three';
import type { Environment } from '../world.ts';
import vertexShader from '../shaders/gameobj.vert.glsl';
import fragmentShader from '../shaders/gameobj.frag.glsl';

export interface GameMaterialOptions {
  /** No lighting (selection rings, tracers, translucent volumes): still fogged. */
  unlit?: boolean;
  opacity?: number;
  side?: THREE.Side;
}

export function createGameMaterial(env: Environment, opts: GameMaterialOptions = {}): THREE.ShaderMaterial {
  const opacity = opts.opacity ?? 1;
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
    defines: opts.unlit ? { UNLIT: '' } : {},
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
    side: opts.side ?? THREE.FrontSide,
    uniforms: {
      sunDir: { value: env.sunDir },
      sunColor: { value: env.sunColor },
      skyAmbient: { value: env.skyAmbient },
      groundAmbient: { value: env.groundAmbient },
      ...env.fog,
      fogNear: { value: 400 },
      fogFar: { value: 1200 },
      tint: { value: new THREE.Color(1, 1, 1) },
      opacity: { value: opacity },
    },
  });
}

/** Adds the white vertex colour the shader expects to geometry without one (rings, bars, boxes, lines). */
export function withShade<T extends THREE.BufferGeometry>(geo: T): T {
  if (!geo.attributes.color) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
  return geo;
}
