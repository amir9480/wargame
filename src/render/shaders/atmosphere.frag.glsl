// Baked atmosphere LUTs (one shader, pass picked by define; see atmosphere.ts):
//  PASS_TRANSMITTANCE: transmittance to the top of the atmosphere per (altitude, direction); once
//  PASS_MULTISCATTER:  Hillaire's isotropic multiple-scattering transfer per (altitude, sun angle); once
//  PASS_SKYVIEW:       sky radiance per direction seen from the observer (sun + moon); on every time-of-day change
//  PASS_AERIAL:        in-scattered light (rgb) and mean transmittance (a) per (direction, distance) from the observer,
//                      one 3D-texture slice per draw; on every time-of-day change
// The observer sits at a fixed altitude (VIEW_ALT km): the camera's real height (< 1 km) hardly changes the air it
// looks through, so the LUTs only depend on the sun and moon and are not rebaked per frame.

varying vec2 vUv;

#include ./chunks/atmosphere.glsl;
#include ./chunks/skymap.glsl;

#ifdef PASS_TRANSMITTANCE
void main() {
  float r, mu;
  transmittanceRMu((gl_FragCoord.xy - 0.5) / (vec2(TRANS_W, TRANS_H) - 1.0), r, mu);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(max(1.0 - mu * mu, 0.0)), mu, 0.0);
  float tMax = max(raySphere(ro, rd, TOP_R), 0.0);
  const int N = 40;
  float dt = tMax / float(N);
  vec3 depth = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 rayS, ext;
    float mieS;
    medium(length(ro + rd * ((float(i) + 0.5) * dt)) - GROUND_R, rayS, mieS, ext);
    depth += ext * dt;
  }
  gl_FragColor = vec4(exp(-depth), 1.0);
}
#endif

#if defined(PASS_MULTISCATTER) || defined(PASS_SKYVIEW) || defined(PASS_AERIAL)
uniform sampler2D tTransmittance;
#endif

#ifdef PASS_MULTISCATTER
// Second-order light arriving at a point from all directions (unit sun) and the transfer factor f_ms of one more bounce;
// the infinite series of further orders sums to L2 / (1 - f_ms).
void main() {
  vec2 x = (gl_FragCoord.xy - 0.5) / (MS_SIZE - 1.0);
  float sunMu = x.x * 2.0 - 1.0;
  float r = GROUND_R + max(x.y * (TOP_R - GROUND_R), 0.01);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sun = vec3(sqrt(max(1.0 - sunMu * sunMu, 0.0)), sunMu, 0.0);
  const int DIRS = 8;
  const int STEPS = 20;
  vec3 lum = vec3(0.0), fms = vec3(0.0);
  for (int a = 0; a < DIRS; a++) {
    for (int b = 0; b < DIRS; b++) {
      float phi = 2.0 * PI * (float(a) + 0.5) / float(DIRS);
      float cosT = 1.0 - 2.0 * (float(b) + 0.5) / float(DIRS);
      float sinT = sqrt(1.0 - cosT * cosT);
      vec3 rd = vec3(sinT * cos(phi), cosT, sinT * sin(phi));
      float tGround = raySphere(ro, rd, GROUND_R);
      float tMax = tGround > 0.0 ? tGround : max(raySphere(ro, rd, TOP_R), 0.0);
      float dt = tMax / float(STEPS);
      vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        vec3 p = ro + rd * ((float(i) + 0.5) * dt);
        float pr = length(p);
        vec3 rayS, ext;
        float mieS;
        medium(pr - GROUND_R, rayS, mieS, ext);
        float mu = dot(p / pr, sun);
        vec3 Tsun = transmittance(tTransmittance, pr, mu) * planetShadow(pr, mu);
        vec3 scat = rayS + mieS;
        vec3 sampleT = exp(-ext * dt);
        vec3 S = scat * Tsun / (4.0 * PI);
        L += T * (S - S * sampleT) / ext;
        F += T * (scat - scat * sampleT) / ext;
        T *= sampleT;
      }
      if (tGround > 0.0) {
        vec3 p = ro + rd * tGround;
        vec3 n = normalize(p);
        float mu = dot(n, sun);
        L += T * transmittance(tTransmittance, GROUND_R, mu) * max(mu, 0.0) * GROUND_ALBEDO / PI;
      }
      lum += L / float(DIRS * DIRS);
      fms += F / float(DIRS * DIRS);
    }
  }
  gl_FragColor = vec4(lum / (1.0 - fms), 1.0);
}
#endif

#if defined(PASS_SKYVIEW) || defined(PASS_AERIAL)
uniform sampler2D tMultiScatter;
uniform vec3 sunDir;
uniform vec3 moonDir;
uniform vec3 sunIllum;   // light at the top of the atmosphere, already times the exposure
uniform vec3 moonIllum;
// Mie forward peak. The aerial LUT uses a flatter one than the sky: its stretched distances would otherwise turn
// everything towards a low sun into blinding glare.
uniform float mieG;

vec3 lightScatter(vec3 rd, float r, vec3 up, vec3 rayS, float mieS, vec3 L, vec3 illum) {
  float mu = dot(up, L);
  vec3 Tl = transmittance(tTransmittance, r, mu) * planetShadow(r, mu);
  vec3 ms = texture(tMultiScatter, multiScatterUv(r, mu)).rgb;
  float c = dot(rd, L);
  return illum * (Tl * (rayS * rayleighPhase(c) + mieS * miePhase(c, mieG)) + ms * (rayS + mieS));
}

/** In-scattered light along ro + rd * [0, tMax] (quadratic step spacing), and the transmittance over it. `groundClamp`:
 *  points below the ground take ground-level air (the aerial LUT's downward rays stand for the ground haze). */
vec3 scatterMarch(vec3 ro, vec3 rd, float tMax, int steps, bool groundClamp, out vec3 T) {
  vec3 L = vec3(0.0);
  T = vec3(1.0);
  float tPrev = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= steps) break;
    float f = (float(i) + 1.0) / float(steps);
    float t = tMax * f * f;
    float dt = t - tPrev;
    vec3 p = ro + rd * (0.5 * (t + tPrev));
    tPrev = t;
    float r = length(p);
    vec3 up = p / r;
    if (groundClamp) r = max(r, GROUND_R + 0.001);
    vec3 rayS, ext;
    float mieS;
    medium(r - GROUND_R, rayS, mieS, ext);
    vec3 S = lightScatter(rd, r, up, rayS, mieS, sunDir, sunIllum) + lightScatter(rd, r, up, rayS, mieS, moonDir, moonIllum);
    vec3 sampleT = exp(-ext * dt);
    L += T * (S - S * sampleT) / ext;
    T *= sampleT;
  }
  return L;
}
#endif

#ifdef PASS_SKYVIEW
uniform vec2 skySize;

void main() {
  float u = gl_FragCoord.x / skySize.x;
  float v = (gl_FragCoord.y - 0.5) / (skySize.y - 1.0);
  vec3 rd = skyDirection(u, skyViewElevation(v));
  vec3 ro = vec3(0.0, GROUND_R + VIEW_ALT, 0.0);
  float tMax = max(raySphere(ro, rd, TOP_R), 0.0);
  vec3 T;
  gl_FragColor = vec4(scatterMarch(ro, rd, tMax, 32, false, T), 1.0);
}
#endif

#ifdef PASS_AERIAL
uniform vec3 apSize;
uniform float slice;

void main() {
  float u = gl_FragCoord.x / apSize.x;
  float v = (gl_FragCoord.y - 0.5) / (apSize.y - 1.0);
  float w = slice / (apSize.z - 1.0);
  vec3 rd = skyDirection(u, aerialElevation(v));
  vec3 ro = vec3(0.0, GROUND_R + VIEW_ALT, 0.0);
  float tTop = raySphere(ro, rd, TOP_R);
  float tMax = AERIAL_MAX * w * w;
  if (tTop > 0.0) tMax = min(tMax, tTop);
  vec3 T;
  vec3 L = scatterMarch(ro, rd, tMax, 24, true, T);
  gl_FragColor = vec4(L, dot(T, vec3(1.0 / 3.0)));
}
#endif
