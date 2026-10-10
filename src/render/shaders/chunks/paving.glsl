// Sidewalk / paving colour: one seeded tint per key (a town's whole connected sidewalk network, or one paved yard), so it
// changes with the map seed but is constant over a connected surface.
uniform float mapSeed;

float pavingHash(float k) {
  return fract(sin((k + mapSeed * 0.618) * 12.9898 + 78.233) * 43758.5453);
}

/** Multiplier on the base paving colour for `key`. */
vec3 pavingTint(float key) {
  float h = pavingHash(key);
  float s = pavingHash(key + 17.3);
  float v = pavingHash(key + 91.7);
  // Hue wheel, kept pale: warm sandstone, red brick, grey, green, blue slate...
  vec3 hue = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), hue * 1.25 + 0.2, 0.2 + 0.35 * s) * (0.8 + 0.35 * v);
}
