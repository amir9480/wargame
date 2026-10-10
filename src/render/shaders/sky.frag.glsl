// Sky dome: baked sky radiance (sky-view LUT) above the horizon, the aerial LUT's far haze below it (the same colour the
// map's far edge fades into), plus the sun disc (HDR: blooms), the moon (sphere lit by the sun, so its phase follows the
// geometry), stars and a faint milky way turning with the sky, dimmed by the air towards the horizon and by daylight.

uniform sampler2D tTransmittance;
uniform sampler2D tSkyView;
uniform vec2 skySize;
uniform highp sampler3D tAerial;
uniform vec3 apSize;
uniform vec3 sunDir;
uniform vec3 moonDir;
uniform mat3 starRotation;
uniform float time;

varying vec3 vDir;

#include ./chunks/atmosphere.glsl;
#include ./chunks/skymap.glsl;

const float SUN_RADIUS = 0.0105;  // radians (~2x the real sun, so it reads from an RTS camera)
const float SUN_BRIGHT = 40.0;    // HDR radiance of the disc before the air dims it
const float MOON_RADIUS = 0.013;
const float MOON_BRIGHT = 1.4;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float valueNoise(vec3 p) {
  vec3 i = floor(p), f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash33(i).x, n100 = hash33(i + vec3(1, 0, 0)).x, n010 = hash33(i + vec3(0, 1, 0)).x, n110 = hash33(i + vec3(1, 1, 0)).x;
  float n001 = hash33(i + vec3(0, 0, 1)).x, n101 = hash33(i + vec3(1, 0, 1)).x, n011 = hash33(i + vec3(0, 1, 1)).x, n111 = hash33(i + vec3(1, 1, 1)).x;
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}

float fbm(vec3 p) {
  return 0.5 * valueNoise(p) + 0.3 * valueNoise(p * 2.03) + 0.2 * valueNoise(p * 4.11);
}

/** Star field in sky coordinates `c` (unit vector); `px` = pixel size in radians, so stars stay ~1-2 pixels wide. */
vec3 stars(vec3 c, float px) {
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 2; layer++) {
    // ~1.6k brighter + ~4k faint stars over the whole sphere (half above the horizon).
    float scale = layer == 0 ? 40.0 : 90.0;
    float density = layer == 0 ? 0.08 : 0.04;
    vec3 cell = floor(c * scale);
    vec3 h = hash33(cell + float(layer) * 71.0);
    if (h.x >= density) continue;
    // Star near the middle of its cell (cells are tested alone, so stars on cell borders would be cut).
    vec3 s = normalize(cell + 0.3 + 0.4 * hash33(cell + 13.7));
    float a = length(c - s);
    float size = px * 0.8;
    // Few bright stars, many faint ones.
    float bright = layer == 0 ? 1.2 * pow(h.y, 8.0) + 0.12 : 0.06 + 0.06 * h.y;
    float twinkle = 0.7 + 0.3 * sin(time * (1.5 + 4.0 * h.z) + h.x * 40.0);
    vec3 tint = mix(vec3(1.0, 0.78, 0.6), vec3(0.75, 0.85, 1.0), h.z);
    col += tint * bright * twinkle * exp(-a * a / (size * size));
  }
  // Milky way: a noisy band round a fixed great circle, with dark dust lanes.
  float band = dot(c, normalize(vec3(0.3, 0.6, 0.74)));
  float glow = exp(-band * band / 0.025) * fbm(c * 6.0);
  float dust = smoothstep(0.45, 0.7, fbm(c * 11.0 + 3.0));
  col += vec3(0.02, 0.022, 0.028) * glow * (1.0 - 0.7 * dust);
  return col;
}

void main() {
  vec3 d = normalize(vDir);
  float px = length(fwidth(d));

  vec3 sky = texture(tSkyView, skyViewUv(d, skySize)).rgb;
  // Below the horizon: one solid haze colour per azimuth (the map's far edge fades to the same, see fog.glsl).
  vec3 far = texture(tAerial, aerialUvw(levelDirection(d), 1.0, apSize)).rgb;
  vec3 col = mix(far, sky, smoothstep(-0.02, 0.01, d.y));

  float above = smoothstep(-0.01, 0.005, d.y);
  vec3 T = transmittance(tTransmittance, GROUND_R + VIEW_ALT, d.y) * above;

  // Stars fade in as the sky darkens, only above the horizon (dimmed by the air towards it); the moon covers them.
  float skyLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float starVis = (1.0 - smoothstep(0.004, 0.05, skyLum)) * smoothstep(0.0, 0.08, d.y) * T.g;
  vec3 night = starVis > 0.0 ? stars(starRotation * d, px) * starVis : vec3(0.0);

  // Moon: a sphere lit by the sun.
  float cm = dot(d, moonDir);
  if (cm > 0.99) {
    vec3 axis = abs(moonDir.y) > 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(moonDir, axis));
    vec3 up = cross(right, moonDir);
    vec3 o = d - moonDir * cm;
    vec2 q = vec2(dot(o, right), dot(o, up)) / sin(MOON_RADIUS);
    float rr = length(q);
    float aa = px / MOON_RADIUS; // no derivatives inside the branch
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, rr);
    if (disc > 0.0) {
      vec3 n = right * q.x + up * q.y - moonDir * sqrt(max(1.0 - rr * rr, 0.0));
      float lit = smoothstep(-0.03, 0.08, dot(n, sunDir));
      float albedo = 0.8 - 0.35 * smoothstep(0.45, 0.7, fbm(vec3(q * 2.5, 1.7)));
      vec3 moon = vec3(1.0, 0.97, 0.92) * albedo * (lit * MOON_BRIGHT + 0.015) * T;
      night = mix(night, moon, disc);
    }
  }
  col += night;

  // Sun disc with limb darkening.
  float cs = dot(d, sunDir);
  if (cs > 0.999) {
    float a = acos(clamp(cs, -1.0, 1.0)) / SUN_RADIUS;
    float aa = px / SUN_RADIUS;
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, a);
    float limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - a * a, 0.0)));
    col += T * (SUN_BRIGHT * limb * disc);
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
