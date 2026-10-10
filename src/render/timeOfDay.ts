// Day / night cycle: turns an hour of the day (0-24, fractional) into the shared lighting environment: sun and moon
// positions on their orbit, the star field's rotation, sunlight filtered by the atmosphere, ambient light. The
// Environment's vectors and colours are mutated in place, so every shader that holds a reference updates automatically.
// The sky and aerial-perspective LUTs follow from the sun and moon (Atmosphere.bake, called by the engine).

import * as THREE from 'three';
import type { Environment } from './world.ts';
import { transmittanceTowards } from './atmosphere.ts';

const { smoothstep } = THREE.MathUtils;

// Overcast autumn: a weak, pale sun and cold grey ambient light.
const SUN_WHITE = new THREE.Color(0.9, 0.87, 0.8);
const SKY_NIGHT = new THREE.Color(0.15, 0.185, 0.3);
const SKY_DAY = new THREE.Color(0.36, 0.4, 0.44);
const GROUND_NIGHT = new THREE.Color(0.08, 0.09, 0.13);
const GROUND_DAY = new THREE.Color(0.2, 0.19, 0.17);
/** Sunlight strength through the cloud deck. */
const OVERCAST_SUN = 0.72;
/** The moon trails the sun by this angle on the same orbit (waxing gibbous: up most of the night). */
const MOON_LAG = THREE.MathUtils.degToRad(160);
/** Exponent on the sun's atmospheric transmittance (1 = physical). */
const SUNLIGHT_SOFTEN = 0.55;

export const DEFAULT_HOUR = 9;

/** Direct sunlight colour at golden hour (sunrise and sunset): deep orange. Only the sun changes, not the ambient light or the grade. */
const SUN_GOLD = new THREE.Color(1.0, 0.5, 0.2);
/** Sun strength left at full golden hour. */
const GOLDEN_DIM = 0.7;

/** 0-1: how golden the light is for a sun elevation (sine of its angle): peaks around the horizon (about 5:40-7:30 and 16:30-18:20), gone by ~0.4. */
export function goldenHour(elevation: number): number {
  return smoothstep(elevation, -0.16, 0.02) * (1 - smoothstep(elevation, 0.08, 0.4));
}

export interface TimeOfDayState {
  /** 0-1: strength of direct sunlight (0 = sun below the horizon, so no shadows). */
  sunUp: number;
  /** 0-1: overall brightness of the sky / ambient light. */
  daylight: number;
}

const zenith = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Color();
const rot = new THREE.Matrix4();

/**
 * Position on the sun / moon orbit at `angle` (0 = rising in the east, pi/2 = highest): a circle round the celestial
 * pole (+Z), tilted so it stays slightly north of overhead and shadows fall towards the default camera.
 */
function orbit(angle: number, target: THREE.Vector3): THREE.Vector3 {
  return target.set(Math.cos(angle) * 0.8, Math.sin(angle) * 0.85, -0.35).normalize();
}

/**
 * Sets sun / moon directions, star rotation, sunlight and ambient colours for `hour`. The sun rises in the east at 6,
 * peaks at noon, sets in the west at 18.
 */
export function applyTimeOfDay(hour: number, env: Environment): TimeOfDayState {
  const h = ((hour % 24) + 24) % 24;
  const angle = ((h - 6) / 12) * Math.PI;
  orbit(angle, env.sunDir);
  orbit(angle - MOON_LAG, env.moonDir);
  env.moonLit.value = (1 - env.sunDir.dot(env.moonDir)) / 2;
  // World -> sky frame: the sky turns round the pole with the sun.
  env.starRotation.setFromMatrix4(rot.makeRotationZ(-angle));
  const elevation = env.sunDir.y;

  const sunUp = smoothstep(elevation, 0.0, 0.18);
  const daylight = smoothstep(elevation, -0.12, 0.3);

  // Sunlight = white light through the air towards the sun (reddens as it sets), relative to the sun overhead. Softened
  // (power < 1): the real loss near the horizon leaves a low sun too dim to play by.
  const zen = transmittanceTowards(zenith, tmp);
  const zr = zen.r, zg = zen.g, zb = zen.b;
  const t = transmittanceTowards(env.sunDir, tmp);
  const k = SUNLIGHT_SOFTEN;
  const golden = goldenHour(elevation);
  // Golden hour: the sun light turns orange (and a little dimmer).
  const overcast = OVERCAST_SUN * (1 - (1 - GOLDEN_DIM) * golden);
  env.sunColor.setRGB(SUN_WHITE.r * (t.r / zr) ** k, SUN_WHITE.g * (t.g / zg) ** k, SUN_WHITE.b * (t.b / zb) ** k).multiplyScalar(sunUp * overcast);
  env.sunColor.r *= 1 + (SUN_GOLD.r - 1) * golden;
  env.sunColor.g *= 1 + (SUN_GOLD.g - 1) * golden;
  env.sunColor.b *= 1 + (SUN_GOLD.b - 1) * golden;

  // Night ambient: steady moonlight glow (independent of the moon's position), so the land stays visible all night.
  env.skyAmbient.lerpColors(SKY_NIGHT, SKY_DAY, daylight);
  env.groundAmbient.lerpColors(GROUND_NIGHT, GROUND_DAY, daylight);
  env.daylight.value = daylight;
  env.hour.value = h;
  return { sunUp, daylight };
}
