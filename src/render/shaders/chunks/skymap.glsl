// Direction <-> texture coordinates of the baked sky LUTs (atmosphere.ts), shared by the bakes and every reader.
//  sky view (2D):        u = absolute azimuth (wraps), v = sqrt(elevation / 90 deg), upper hemisphere only
//  aerial perspective:   u = azimuth, v = signed sqrt of the elevation (more texels near the horizon), w = sqrt(distance share)
// Texel centres sit at v / w = 0 and 1 exactly; u wraps (repeat).

const float SKYMAP_PI = 3.14159265359;

float skyAzimuthU(vec3 dir) {
  // Straight up / down has no azimuth: atan(0, 0) is undefined on some GPUs.
  return abs(dir.x) + abs(dir.z) < 1e-6 ? 0.5 : atan(dir.z, dir.x) / (2.0 * SKYMAP_PI) + 0.5;
}

/** Inverse of the u / elevation mappings. `e` in radians. */
vec3 skyDirection(float u, float e) {
  float az = (u - 0.5) * 2.0 * SKYMAP_PI;
  return vec3(cos(e) * cos(az), sin(e), cos(e) * sin(az));
}

vec2 skyViewUv(vec3 dir, vec2 size) {
  float v = sqrt(asin(clamp(dir.y, 0.0, 1.0)) / (0.5 * SKYMAP_PI));
  return vec2(skyAzimuthU(dir), (0.5 + v * (size.y - 1.0)) / size.y);
}

float skyViewElevation(float v) {
  return v * v * 0.5 * SKYMAP_PI;
}

vec3 aerialUvw(vec3 dir, float w, vec3 size) {
  float e = asin(clamp(dir.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(e) * sqrt(abs(e) / (0.5 * SKYMAP_PI));
  return vec3(skyAzimuthU(dir), (0.5 + v * (size.y - 1.0)) / size.y, (0.5 + w * (size.z - 1.0)) / size.z);
}

/** Level direction (y = 0) with `dir`'s azimuth: below the horizon everything is one haze colour per azimuth. */
vec3 levelDirection(vec3 dir) {
  vec2 h = dir.xz;
  float l = length(h);
  return l < 1e-5 ? vec3(1.0, 0.0, 0.0) : vec3(h.x / l, 0.0, h.y / l);
}

float aerialElevation(float v) {
  float s = v * 2.0 - 1.0;
  return sign(s) * s * s * 0.5 * SKYMAP_PI;
}
