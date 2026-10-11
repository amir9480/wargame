// "LOD levels" debug view: every drawn object is tinted with the colour of its level of detail, the same colour for the
// nearest level of every kind of content, one for the next, and so on (green near, cyan, yellow, orange, red, magenta).
//
// How: the final colour step of every map shader (three's `colorspace_fragment` chunk, included by all of them) blends the
// colour towards the shared `lodTint` uniform (rgb + blend share). Materials get the uniform from `World`; a mesh sets it
// right before it is drawn (`onBeforeRender`, only installed while the view is on), from its level: `userData.lodLevel`
// when the layer says so (terrain chunks / super chunks, the city models), else 1 for a mesh that only appears beyond a
// distance (`lodMin` > 0: far buildings, sprites, far power...) and 0 for the rest.
//
// The chunk patch below must run before the first shader compiles (this module is imported by world.ts), and costs one
// uniform blend per fragment that is multiplied by 0 while the view is off.

import * as THREE from 'three';

THREE.ShaderChunk.colorspace_pars_fragment += '\nuniform vec4 lodTint;\n';
THREE.ShaderChunk.colorspace_fragment += '\ngl_FragColor.rgb = mix( gl_FragColor.rgb, lodTint.rgb, lodTint.a );\n';

/** Level colours, nearest first (the last one repeats for deeper levels). */
const LEVEL_COLORS = [0x2fe05a, 0x2fb4ff, 0xffd400, 0xff8a1e, 0xff3030, 0xd13bff].map((hex) => new THREE.Color(hex));
/** How strongly the level colour covers the normal look. */
const BLEND = 0.6;

/** The uniform every map material shares: [r, g, b, blend]. */
export const lodTint = { value: new THREE.Vector4(0, 0, 0, 0) };

/** LOD level of a mesh (0 = nearest). */
export function lodLevelOf(mesh: THREE.Object3D): number {
  const explicit = mesh.userData.lodLevel as number | undefined;
  if (explicit !== undefined) return explicit;
  return (mesh.userData.lodMin ?? 0) > 0 ? 1 : 0;
}

function tintBeforeRender(this: THREE.Object3D, _r: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, material: THREE.Material): void {
  const c = LEVEL_COLORS[Math.min(lodLevelOf(this), LEVEL_COLORS.length - 1)];
  lodTint.value.set(c.r, c.g, c.b, BLEND);
  (material as THREE.ShaderMaterial).uniformsNeedUpdate = true; // the uniform changes between draws that share a material
}

/** Switches the view on / off for the meshes under `root` (call again for meshes added while it is on). */
export function setLodDebug(root: THREE.Object3D, on: boolean): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (on) o.onBeforeRender = tintBeforeRender;
    else delete (o as { onBeforeRender?: unknown }).onBeforeRender; // back to the prototype's no-op
  });
  if (!on) lodTint.value.set(0, 0, 0, 0);
}
