// Third level of detail of a town: beyond a camera distance the town's detailed content (building meshes, street ribbons,
// paving decals, window halos...) is hidden and the town's one merged city model (cityLod.ts) is drawn instead.
//
// The distance is measured to the town's EDGE (`distance` + the town's reach from its centre), so a big town switches when
// its nearest streets are `distance` away, and the whole town switches at once. The switch is a dithered cross-fade like the
// trees' sprites (chunks/lodfade.glsl): within `bias` of the switch both levels are drawn, the model's shader keeps each pixel
// where the blue noise is below its share. So detail meshes stay until switch + bias, the model starts at switch - bias.
// Content is tagged with `tag`; the Culler does the rest (`lodMax` / `lodMin` + the town centre as the measuring point).
// Quality changes call `setDistance`, which re-applies every tag.

import * as THREE from 'three';
import type { City } from '../terrain/generate.ts';
import { TOWN_REACH } from '../terrain/urban.ts';

/** What a tagged mesh is: `detail` = hidden beyond the switch, `model` = shown only beyond it. */
export type TownRole = 'detail' | 'model';

/** Half width of the cross-fade band, as a share of the switch distance. */
const BAND = 0.12;

export class TownLod {
  /** Camera distance (m) to a town's edge beyond which its city model replaces the detailed content. */
  distance = 800;
  private cities: City[] = [];
  private centers: THREE.Vector3[] = [];

  /**
   * Per town (up to 8), two entries: (centre x, y, z, switch distance), then (band half width, 0, 0, 0). Shared with the light
   * shaders (chunks/townfade.glsl), which cross-fade a town's detailed lights with its city model's by the same 3D distance as
   * the Culler and the model's surfaces use.
   */
  readonly info: THREE.Vector4[] = Array.from({ length: 16 }, () => new THREE.Vector4());

  setCities(cities: City[]): void {
    this.cities = cities;
    this.centers = cities.map((c) => new THREE.Vector3(c.x, c.y, c.z));
    this.updateInfo();
  }

  private updateInfo(): void {
    this.cities.slice(0, this.info.length / 2).forEach((c, i) => {
      this.info[i * 2].set(c.x, c.y, c.z, this.switchAt(i));
      this.info[i * 2 + 1].set(this.bias, 0, 0, 0);
    });
  }

  /** Half width (m) of the cross-fade band round the switch. */
  get bias(): number {
    return this.distance * BAND;
  }

  /** Camera distance to the town's centre where the cross-fade is half way. */
  switchAt(city: number): number {
    return this.distance + (this.cities[city]?.radius ?? 0) * TOWN_REACH;
  }

  center(city: number): THREE.Vector3 {
    return this.centers[city];
  }

  /** Marks `mesh` as content of town `city` (a negative city = not in a town: left alone). */
  tag(mesh: THREE.Object3D, city: number, role: TownRole = 'detail'): void {
    if (city < 0) return;
    mesh.userData.townCity = city;
    mesh.userData.townRole = role;
    this.apply(mesh);
  }

  /** Sets the Culler's distance limits of a tagged mesh from the current distance. */
  apply(mesh: THREE.Object3D): void {
    const city = mesh.userData.townCity as number | undefined;
    if (city === undefined || !this.centers[city]) return;
    const at = this.switchAt(city);
    if (mesh.userData.townRole === 'model') {
      mesh.userData.lodLevel = 2; // third level of a town (LOD levels debug view)
      mesh.userData.lodMin = at - this.bias;
      mesh.userData.lodCenter = this.centers[city];
    } else {
      mesh.userData.lodMax = at + this.bias;
      mesh.userData.lodMaxCenter = this.centers[city];
    }
  }

  /** Moves the switch distance and re-applies it to everything tagged under `roots`. */
  setDistance(distance: number, roots: THREE.Object3D[]): void {
    this.distance = distance;
    this.updateInfo();
    for (const root of roots) root.traverse((o) => this.apply(o));
  }
}
