// Sky dome: a sphere that follows the drawing camera (in its vertex shader) and is drawn after the opaque map, so
// early depth testing shades only the pixels where sky shows. On its own render layer (SKY_LAYER), which the sun's
// shadow camera doesn't see.

import * as THREE from 'three';
import { atmosphereDefines, type Atmosphere } from './atmosphere.ts';
import type { Environment } from './world.ts';
import skyVertex from './shaders/sky.vert.glsl';
import skyFragment from './shaders/sky.frag.glsl';

/** Render layer of the sky; cameras that should see it enable it. */
export const SKY_LAYER = 1;

export class Sky {
  readonly mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor(atmosphere: Atmosphere, env: Environment) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      defines: atmosphereDefines(),
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        tTransmittance: { value: atmosphere.transmittance.texture },
        tSkyView: atmosphere.fog.tSkyView,
        skySize: atmosphere.fog.skySize,
        tAerial: atmosphere.fog.tAerial,
        apSize: atmosphere.fog.apSize,
        sunDir: { value: env.sunDir },
        moonDir: { value: env.moonDir },
        starRotation: { value: env.starRotation },
        time: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.material);
    this.mesh.frustumCulled = false; // placed round the camera by the vertex shader
    this.mesh.renderOrder = 1000; // after the opaque map (the transparent list is drawn after anyway)
    this.mesh.layers.set(SKY_LAYER);
    this.mesh.userData.noCull = true;
    this.mesh.userData.noShadow = true;
  }

  /** Seconds, for twinkling stars. */
  update(time: number): void {
    this.material.uniforms.time.value = time;
  }
}
