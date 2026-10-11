// Particle puffs (render/particles/system.ts): one instance per particle slot, simulated analytically in this shader.
// A particle's state is a pure function of the render clock and its slot (emitter seed + slot fraction), so nothing is
// updated on the CPU and any number of emitters costs the same per instance. Camera-facing quads.
//   aOrigin = emitter mouth (world), aEmit = (seed 0-1, slot fraction 0-1, scale, intensity)
// FAR defined: the far level of detail (fewer, bigger puffs, fades in where the near level fades out).
attribute vec3 aOrigin;
attribute vec4 aEmit;

uniform float time;
uniform float density; // quality: share of the slots that are drawn
uniform vec2 wind;     // m/s
uniform float life;
uniform float rise;
uniform float riseDecay;
uniform float spread;
uniform float windDrift;
uniform float sizeStart;
uniform float sizeEnd;
uniform float sizeMul;
uniform float opacity;
uniform float fadeIn;
uniform vec3 colorStart;
uniform vec3 colorEnd;
uniform float spin;
uniform float lodNear;
uniform float lodBand;
uniform float lodFar;
uniform vec3 sunDir;

#include ./chunks/gameview.glsl;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vColor;
varying float vAlpha;
varying float vAge;
varying vec2 vSpin;
varying float vSeed;
varying vec3 vSun; // sun direction in the billboard's frame (right, up, towards the camera)
varying vec3 vUp;  // world up in the billboard's frame

vec3 hash13(float p) {
  vec3 q = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

void main() {
  float seed = aEmit.x;
  float slot = aEmit.y;
  float dist = distance(fogOrigin, aOrigin);
  float nearShare = 1.0 - smoothstep(lodNear - lodBand, lodNear + lodBand, dist);
#ifdef FAR
  float lod = (1.0 - nearShare) * (1.0 - smoothstep(lodFar * 0.8, lodFar, dist));
#else
  float lod = nearShare;
#endif
  if (slot >= aEmit.w * density || lod < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume
    return;
  }

  // Age: each slot is a fixed phase of the emitter's cycle; every new cycle draws new randomness.
  float u = time / life + slot + seed;
  float cycle = floor(u);
  float age = fract(u);
  vec3 r = hash13(seed * 91.7 + slot * 53.1 + cycle * 7.13);

  float height = rise * life * (age - 0.5 * riseDecay * age * age);
  float ang = r.x * 6.2832;
  vec2 turb = vec2(cos(ang), sin(ang)) * sqrt(r.y) * spread * aEmit.z * age;
  float gust = 1.0 + 0.25 * sin(time * 0.17 + seed * 40.0);
  vec2 drift = wind * gust * windDrift * life * age * age * 0.5;
  vec3 center = aOrigin + vec3(turb.x + drift.x, height, turb.y + drift.y);

  float radius = mix(sizeStart, sizeEnd, sqrt(age)) * aEmit.z * sizeMul * (0.75 + 0.5 * r.z);
  center.y += radius * 0.5; // the puff's lower rim starts at the mouth instead of sinking into it

  float turn = r.y * 6.2832 + age * spin * (r.x - 0.5) * 2.0;
  vSpin = vec2(cos(turn), sin(turn));
  vSeed = r.z + seed;
  vAge = age;
  vAlpha = opacity * smoothstep(0.0, max(fadeIn, 1e-3), age) * (1.0 - smoothstep(0.4, 1.0, age)) * lod;
  vColor = mix(colorStart, colorEnd, sqrt(age));

  vec3 right = gameRight;
  vec3 up = gameUp;
  vec3 toCam = cross(right, up);
  vSun = vec3(dot(sunDir, right), dot(sunDir, up), dot(sunDir, toCam));
  vUp = vec3(right.y, up.y, toCam.y);

  vUv = position.xy;
  vec4 wp = vec4(center + (right * position.x + up * position.y) * radius, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
