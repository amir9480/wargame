// Twinkle of a far light halo: fast random flicker, like noise. Per light, two layers of 1D value noise over time (new random
// values ~5.6 and ~13.3 times a second, only lightly smoothed between them, so it jitters instead of gliding). The pace offset
// comes from a hash of the light's position, so neighbours are out of step. Brightness ranges about 0.4 - 1.
float hash11(float x) {
  return fract(sin(x * 127.1) * 43758.5453);
}

float noise1(float x, float seed) {
  float i = floor(x), f = fract(x);
  float u = smoothstep(0.35, 0.65, f); // short blend: mostly steps
  return mix(hash11(i + seed), hash11(i + 1.0 + seed), u);
}

float twinkle(vec3 p, float t) {
  float h = fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float n = 0.6 * noise1(t * 5.6 + h * 100.0, h * 311.0) + 0.4 * noise1(t * 13.3 + h * 57.0, h * 173.0 + 7.0);
  return mix(0.4, 1.0, smoothstep(0.2, 0.7, n));
}

// Lights only twinkle when seen from afar: steady closer than TWINKLE_START (m from the camera), fully twinkling from TWINKLE_END.
#define TWINKLE_START 220.0
#define TWINKLE_END 450.0

float twinkleFar(vec3 p, float t, float camDist) {
  return mix(1.0, twinkle(p, t), smoothstep(TWINKLE_START, TWINKLE_END, camDist));
}
