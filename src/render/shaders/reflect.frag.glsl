// Wet-street light reflection pixel: a streak (sharp across, long along the projected vertical, brightest between the
// lamp's foot and its mirror image, tailing off towards the viewer, broken into shimmering ripples) that only shows on
// mirror-like ground: the wet mask (wetmask.ts: asphalt, town sidewalks) at the surface point rebuilt from the scene
// depth, which must also lie on the ground (not on poles, cars, bridge railings). Drawn additively at half resolution
// into the ray target, which the post pass adds as is.
uniform sampler2D tDepth;
uniform mat4 invViewProj;
uniform vec2 resolution;     // full-resolution pixels
uniform vec2 rayResolution;  // size of the target drawn into
uniform sampler2D tWet;
uniform float wetSize;       // world size covered by the mask
uniform sampler2D tHeight;
uniform float mapSize;
uniform float gridSize;
uniform float time;

varying vec3 vColor;
varying vec3 vLight;
varying float vGround;
varying vec3 vFacing;
varying vec2 vBase;
varying vec2 vAxis;
varying vec2 vSize;

#include ./chunks/fogdist.glsl;

const float STRENGTH = 0.22;
// Reflections are a close-up effect: they fade out over this camera distance range (chunks beyond are not drawn,
// see REFLECT_DISTANCE in lights.ts).
const float REFLECT_FADE_START = 90.0;
const float REFLECT_FADE_END = 150.0;
// A wet surface only mirrors at grazing angles: no reflection while the view ray is within 50 deg of straight down,
// full from 65 deg (cosines of the angle from the vertical).
const float GRAZE_NONE = 0.6428; // cos 50
const float GRAZE_FULL = 0.4226; // cos 65

float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}

vec3 worldAt(vec2 uv, float d) {
  vec4 c = invViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return c.xyz / c.w;
}

void main() {
  vec2 uv = gl_FragCoord.xy / rayResolution;
  vec2 rel = uv * resolution - vBase;
  float t = dot(rel, vAxis) / vSize.x;
  float s = dot(rel, vec2(-vAxis.y, vAxis.x)) / vSize.y;
  float shape = smoothstep(-0.05, 0.12, t) * (1.0 - smoothstep(0.3, 1.0, t)) * exp(-s * s * 1.5);
  if (shape < 0.003) discard;

  float d = texture2D(tDepth, uv).r;
  if (d >= 1.0) discard;
  vec3 P = worldAt(uv, d);
  float camDist = distance(fogOrigin, P);
  float near = 1.0 - smoothstep(REFLECT_FADE_START, REFLECT_FADE_END, camDist);
  near *= 1.0 - smoothstep(GRAZE_FULL, GRAZE_NONE, (fogOrigin.y - P.y) / max(camDist, 1e-3));
  if (near <= 0.0) discard;
  float wet = texture2D(tWet, P.xz / wetSize + 0.5).r;
  if (wet <= 0.0) discard;
  vec2 huv = ((P.xz / mapSize + 0.5) * (gridSize - 1.0) + 0.5) / gridSize;
  float onGround = 1.0 - smoothstep(0.3, 0.8, abs(P.y - texture2D(tHeight, huv).r));

  // One-sided lamp (signal head): only ground in front of it can mirror it towards the camera, so a lamp seen from
  // behind (its lit face turned away) leaves no streak.
  float front = 1.0;
  if (dot(vFacing, vFacing) > 0.5) {
    vec2 out2 = P.xz - vLight.xz;
    front = smoothstep(0.05, 0.45, dot(vFacing.xz, out2) / max(length(out2), 1e-3));
    if (front <= 0.0) discard;
  }
  // Fades with ground distance from the lamp (taller lamps reflect farther).
  float reach = 6.0 + 3.0 * (vLight.y - vGround);
  float fall = exp(-distance(P.xz, vLight.xz) / reach);
  // Uneven water film: soft world-space noise (two octaves, slowly drifting), low contrast so the wet spots run into
  // each other. Flattened to its mean with distance (finer than a half-resolution pixel there).
  vec2 w = P.xz * 2.2;
  float n = 0.6 * valueNoise(w + vec2(time * 0.15, 0.0)) + 0.4 * valueNoise(w * 2.3 + vec2(0.0, -time * 0.2) + 17.0);
  float detail = 1.0 - smoothstep(50.0, 110.0, camDist);
  float ripple = mix(0.8, mix(0.55, 1.05, smoothstep(0.25, 0.75, n)), detail);

  gl_FragColor = vec4(vColor * (STRENGTH * shape * wet * onGround * fall * ripple * near * front), 1.0);
}
