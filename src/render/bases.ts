import * as THREE from 'three';
import { sampleGrid, type Terrain } from '../terrain/generate.ts';
import type { Environment } from './world.ts';
import baseVertex from './shaders/base.vert.glsl';
import baseFragment from './shaders/base.frag.glsl';

/** Player slot colours: red, green, blue, purple. */
export const PLAYER_COLORS = [0xe53935, 0x43a047, 0x1e88e5, 0x8e24aa] as const;
export const PLAYER_COLOR_NAMES = ['red', 'green', 'blue', 'purple'] as const;

/** Height of the overlay above the ground (against z-fighting; the ground is flat there). */
const LIFT = 0.3;

/** Coloured, translucent squares marking each player's base build area. */
export class BaseLayer {
  readonly group = new THREE.Group();
  readonly materials: THREE.ShaderMaterial[] = [];
  private env: Environment;

  constructor(env: Environment) {
    this.env = env;
  }

  build(terrain: Terrain): void {
    this.clear();
    const half = terrain.worldSize / 2;
    for (const base of terrain.bases) {
      const segs = Math.round(base.size / terrain.cell); // one quad per grid cell -> follows the ground
      const geo = new THREE.PlaneGeometry(base.size, base.size, segs, segs).rotateX(-Math.PI / 2);
      geo.translate(base.x, 0, base.z);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), z = p.getZ(i);
        p.setY(i, sampleGrid(terrain.heights, terrain.size, (x + half) / terrain.cell, (z + half) / terrain.cell) + LIFT);
      }
      geo.computeVertexNormals();

      const material = new THREE.ShaderMaterial({
        vertexShader: baseVertex,
        fragmentShader: baseFragment,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        uniforms: {
          color: { value: new THREE.Color(PLAYER_COLORS[base.slot]) },
          size: { value: base.size },
          ...this.env.fog,
          fogNear: { value: 400 },
          fogFar: { value: 1200 },
        },
      });
      this.materials.push(material);
      const mesh = new THREE.Mesh(geo, material);
      mesh.renderOrder = 0.8; // over roads, under water
      this.group.add(mesh);
    }
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      this.group.remove(child);
    }
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}
