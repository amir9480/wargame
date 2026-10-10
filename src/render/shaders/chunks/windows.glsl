// Window lights, shared by the near panes (building.frag), the far facades (buildingFar.frag) and the far halos
// (buildingHalo.vert), so a window looks the same at every distance. Every window has its own stable schedule from
// the building's seed and the window's place (column, floor, wall + 4 * block):
//   - some never light up (1 - the building's lit share),
//   - the others switch on between ~17:30 and ~20:30 (later or earlier for the whole building, by its seed),
//   - and off again either around midnight (21:30 - 01:30) or at dawn (05:00 - 07:00).
uniform float hour; // 0 - 24

float windowHash(vec4 p) {
  p = fract(p * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p += dot(p, p.wzxy + 33.33);
  return fract((p.x + p.y) * (p.z + p.w));
}

/** 1 while the window is lit at the current hour, else 0. */
float windowLit(vec3 key, float seed, float share) {
  key = floor(key + 0.5); // exact integers, whatever the interpolation did
  float s = seed * 1000.0;
  if (windowHash(vec4(key, s)) >= share) return 0.0;
  float a = windowHash(vec4(key, s + 17.0));
  float b = windowHash(vec4(key, s + 41.0));
  float c = windowHash(vec4(key, s + 73.0));
  float t = hour < 12.0 ? hour + 24.0 : hour; // evening -> next morning without a wrap: 12 .. 36
  float on = 17.5 + (seed - 0.5) + 2.5 * a;
  float off = b < 0.5 ? 21.5 + 4.0 * c : 29.0 + 2.0 * c;
  return step(on, t) * step(t, off);
}

/** Warm light colour of a window (slight per-window tint). */
vec3 windowColor(vec3 key, float seed) {
  key = floor(key + 0.5);
  return mix(vec3(1.0, 0.58, 0.26), vec3(1.0, 0.82, 0.55), windowHash(vec4(key, seed * 1000.0 + 101.0)));
}
