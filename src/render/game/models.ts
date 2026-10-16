// Placeholder procedural models for game entities (one merged geometry per type, drawn as one InstancedMesh each).
// Vertex colours carry the part shading; the per-instance colour is the team tint. Units face +Z with their feet at y = 0;
// structures are modelled in unit space (x, z in -0.5..0.5, y 0..1) and scaled per instance to their footprint / height.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function shade(geo: THREE.BufferGeometry, v: number): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(v), 3));
  return geo;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, v: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return shade(g, v);
}

/** Cylinder standing on `y`. */
function cyl(r: number, h: number, x: number, y: number, z: number, v: number, seg = 10, rTop = r): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, r, h, seg);
  g.translate(x, y + h / 2, z);
  return shade(g, v);
}

/** Cylinder lying along +Z (gun barrels). */
function barrel(r: number, len: number, x: number, y: number, z: number, v: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z + len / 2);
  return shade(g, v);
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => p.index ? p.toNonIndexed() : p), false)!;
  g.computeBoundingSphere();
  return g;
}

export function unitGeometry(name: string): THREE.BufferGeometry {
  switch (name) {
    case 'rifleman':
      return merged([cyl(0.3, 1.0, 0, 0.35, 0, 0.9, 8), box(0.3, 0.3, 0.3, 0, 1.4, 0, 0.8), box(0.09, 0.09, 0.8, 0.24, 1.0, 0.4, 0.3)]);
    case 'rocketTrooper':
      return merged([cyl(0.32, 1.05, 0, 0.35, 0, 0.9, 8), box(0.32, 0.32, 0.32, 0, 1.45, 0, 0.8), barrel(0.11, 1.3, 0.3, 1.35, -0.2, 0.35)]);
    case 'supplyTruck':
      return merged([box(2.3, 1.2, 4.6, 0, 0.7, -0.4, 0.85), box(2.2, 1.3, 1.5, 0, 0.7, 2.4, 1), box(2.4, 0.5, 5.8, 0, 0.1, 0.2, 0.25)]);
    case 'battleTank':
      return merged([
        box(3.0, 1.0, 5.6, 0, 0.55, 0, 0.9),
        box(0.9, 1.0, 5.9, 1.85, 0.1, 0, 0.25), box(0.9, 1.0, 5.9, -1.85, 0.1, 0, 0.25),
        box(2.0, 0.85, 2.5, 0, 1.55, -0.3, 1),
        barrel(0.16, 3.8, 0, 1.95, 0.9, 0.35),
      ]);
    default:
      return merged([box(1, 1, 1, 0, 0, 0, 1)]);
  }
}

/** Structure in unit space; the instance matrix scales it to (width, height * progress, depth). */
export function structureGeometry(name: string): THREE.BufferGeometry {
  switch (name) {
    case 'commandCenter':
      return merged([box(1, 0.6, 1, 0, 0, 0, 0.9), box(0.5, 0.4, 0.5, 0, 0.6, 0, 1), cyl(0.12, 0.45, 0.2, 1.0, 0.1, 0.4, 8), box(0.9, 0.06, 0.9, 0, 0.6, 0, 0.55)]);
    case 'powerPlant':
      return merged([box(1, 0.5, 1, 0, 0, 0, 0.9), cyl(0.2, 1.1, -0.22, 0.2, -0.12, 0.7, 12, 0.14), cyl(0.2, 1.1, 0.22, 0.2, 0.12, 0.7, 12, 0.14)]);
    case 'supplyDepot':
      return merged([box(1, 0.45, 1, 0, 0, 0, 0.85), box(0.28, 0.5, 0.8, -0.3, 0.45, 0, 1), box(0.28, 0.5, 0.8, 0, 0.45, 0, 0.7), box(0.28, 0.5, 0.8, 0.3, 0.45, 0, 1)]);
    case 'barracks':
      return merged([box(1, 0.7, 1, 0, 0, 0, 0.95), box(1.04, 0.14, 1.04, 0, 0.7, 0, 0.5), box(0.2, 0.3, 0.2, 0.3, 0.84, 0.2, 0.7)]);
    case 'warFactory':
      return merged([box(1, 0.65, 1, 0, 0, 0, 0.9), box(0.3, 0.35, 1, -0.3, 0.65, 0, 0.75), box(0.3, 0.35, 1, 0.1, 0.65, 0, 0.75), cyl(0.07, 0.5, 0.38, 0.65, -0.3, 0.4, 8)]);
    case 'mgTurret':
      return merged([cyl(0.5, 0.45, 0, 0, 0, 0.8, 12), box(0.7, 0.4, 0.8, 0, 0.45, 0, 1), barrel(0.09, 0.9, 0, 0.65, 0.4, 0.3)]);
    default:
      return merged([box(1, 1, 1, 0, 0, 0, 1)]);
  }
}

export const UNIT_HEIGHT: Record<string, number> = { rifleman: 1.9, rocketTrooper: 1.9, supplyTruck: 2.4, battleTank: 2.7 };
