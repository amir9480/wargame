// Node-only loader for the mountain heightmaps (scripts, tests, a server). Browser code uses fetchMountainLibrary.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { MOUNTAIN_PATCHES, decodeMountainPatch, type MountainLibrary } from './library.ts';

const DIR = fileURLToPath(new URL('../../../public/assets/heightmaps/', import.meta.url));

export function loadMountainLibrary(dir = DIR): Promise<MountainLibrary> {
  return Promise.all(
    MOUNTAIN_PATCHES.map((name) => decodeMountainPatch(name, readFileSync(`${dir}${name}.png`), (zlib) => inflateSync(zlib))),
  );
}
