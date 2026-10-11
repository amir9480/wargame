// Particle puff: a soft disc shaded like a little sphere (sun + sky from its billboard-space normal), with a billowy,
// turning edge pattern that is only computed near the camera (surfaceDetail); far away the plain soft disc is drawn.
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vColor;
varying float vAlpha;
varying float vAge;
varying vec2 vSpin;
varying float vSeed;
varying vec3 vSun;
varying vec3 vUp;

#include ./chunks/fog.glsl;
#define DETAIL_START 160.0
#define DETAIL_END 260.0
#include ./chunks/lod.glsl;

float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + 1.0), f.x), f.y);
}

void main() {
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;
  float body = 1.0 - r2;
  body *= body;

  float shape = body;
  float detail = surfaceDetail(vWorldPos);
  if (detail > 0.0) {
    vec2 p = vec2(vSpin.x * vUv.x - vSpin.y * vUv.y, vSpin.y * vUv.x + vSpin.x * vUv.y) * 2.4 + vSeed * 31.0;
    float n = valueNoise(p) * 0.65 + valueNoise(p * 2.7 + 11.0) * 0.35;
    float billow = clamp((body - (1.0 - n) * 0.5) * 2.0, 0.0, 1.0);
    shape = mix(body, billow, detail);
  }
  float alpha = shape * vAlpha;
  if (alpha < 0.004) discard;

  vec3 n3 = vec3(vUv, sqrt(1.0 - r2));
  float ndl = clamp(dot(n3, vSun) * 0.6 + 0.4, 0.0, 1.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, dot(n3, vUp) * 0.5 + 0.5);
  vec3 lit = vColor * (ambient + sunColor * ndl * 0.85);

  // Alpha blends the colour only: the target's alpha channel is left alone (0 marks sprite pixels for the lighting pass).
  gl_FragColor = vec4(applyFog(lit, vWorldPos), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
