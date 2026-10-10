// Ambient occlusion at half resolution, in three small full-screen passes (one shader, picked by define):
//  PASS_DEPTH: full-res depth buffer -> linear view depth (R32F), one texel per 2x2 pixels
//  PASS_AO:    occlusion from AO_TAPS depth taps around each pixel (view space, no matrices), written with its depth
//  PASS_BLUR:  4x4 depth-aware box blur; the AO pass rotates its taps in a 4x4 interleaved pattern, so this box
//              averages exactly one of each rotation -> smooth result from few taps
// The post pass then upsamples it with depth-aware weights (post.frag.glsl).
//
// Faceted terrain: the AO normal comes from depth differences over at least one terrain cell, and shallow creases
// are biased out, so triangle edges of the ground mesh don't show.

varying vec2 vUv;

#ifdef PASS_DEPTH
uniform sampler2D tDepth;
uniform float camNear;
uniform float camFar;

void main() {
  float d = texture2D(tDepth, vUv).r;
  float z = d * 2.0 - 1.0;
  // Sky: far away, never occluded and never occluding.
  float lin = d >= 1.0 ? 1e6 : 2.0 * camNear * camFar / (camFar + camNear - z * (camFar - camNear));
  gl_FragColor = vec4(lin, 0.0, 0.0, 1.0);
}
#endif

#ifdef PASS_AO
uniform sampler2D tZ;         // linear view depth, half resolution
uniform vec2 size;            // half-res target size
uniform vec2 projScale;       // tan(fov/2) * aspect, tan(fov/2)
uniform float pxScale;        // half-res pixels per world unit at distance 1
uniform float aoRadius;       // world units
uniform mat4 viewToWorld;
uniform vec3 focus;
uniform float regionR;

vec3 viewPos(vec2 uv, float z) {
  return vec3((uv * 2.0 - 1.0) * projScale * z, -z);
}

void main() {
  float z0 = texture2D(tZ, vUv).r;
  vec3 P = viewPos(vUv, z0);
  vec3 W = (viewToWorld * vec4(P, 1.0)).xyz;
  if (z0 > 1e5 || distance(W.xz, focus.xz) > regionR) {
    gl_FragColor = vec4(1.0, z0, 0.0, 1.0);
    return;
  }
  vec2 texel = 1.0 / size;

  // Smooth normal: central differences over >= one terrain cell (2 m), one-sided across depth jumps.
  float k = clamp(2.5 * pxScale / z0, 1.0, 12.0);
  vec2 ox = vec2(k * texel.x, 0.0), oy = vec2(0.0, k * texel.y);
  vec3 pR = viewPos(vUv + ox, texture2D(tZ, vUv + ox).r), pL = viewPos(vUv - ox, texture2D(tZ, vUv - ox).r);
  vec3 pU = viewPos(vUv + oy, texture2D(tZ, vUv + oy).r), pD = viewPos(vUv - oy, texture2D(tZ, vUv - oy).r);
  float jR = distance(pR, P), jL = distance(pL, P), jU = distance(pU, P), jD = distance(pD, P);
  vec3 ax = max(jR, jL) < 2.0 * min(jR, jL) ? pR - pL : (jR < jL ? pR - P : P - pL);
  vec3 ay = max(jU, jD) < 2.0 * min(jU, jD) ? pU - pD : (jU < jD ? pU - P : P - pD);
  vec3 N = normalize(cross(ax, ay));
  if (dot(N, -P) < 0.0) N = -N;

  // 4x4 interleaved rotation (undone exactly by the 4x4 blur), golden-angle spiral of taps.
  vec2 cell = mod(floor(gl_FragCoord.xy), 4.0);
  float rot = (cell.x * 4.0 + cell.y) * (6.2831853 / 16.0);
  float jitter = fract((cell.y * 4.0 + cell.x) * 0.3819660);
  float rpx = clamp(aoRadius * pxScale / z0, 2.0, 32.0);
  float occ = 0.0;
  for (int i = 0; i < AO_TAPS; i++) {
    float t = (float(i) + jitter) / float(AO_TAPS);
    float a = rot + float(i) * 2.3999632;
    vec2 suv = vUv + vec2(cos(a), sin(a)) * (0.2 + 0.8 * t) * rpx * texel;
    vec3 v = viewPos(suv, texture2D(tZ, suv).r) - P;
    float len = max(length(v), 1e-4);
    float range = 1.0 - smoothstep(aoRadius * 0.5, aoRadius * 1.5, len);
    // Bias: shallow creases (gently folded ground, ~10 degrees) cast no occlusion.
    occ += max(0.0, dot(N, v) / len - 0.18) * range;
  }
  float ao = 1.0 - clamp(occ / float(AO_TAPS) * 2.2, 0.0, 1.0);
  gl_FragColor = vec4(ao, z0, 0.0, 1.0);
}
#endif

#ifdef PASS_BLUR
uniform sampler2D tAO;        // r = occlusion, g = linear depth
uniform vec2 size;

void main() {
  vec2 texel = 1.0 / size;
  float z0 = texture2D(tAO, vUv).g;
  float sum = 0.0, wsum = 0.0;
  for (int y = -2; y < 2; y++) {
    for (int x = -2; x < 2; x++) {
      vec2 s = texture2D(tAO, vUv + vec2(float(x), float(y)) * texel).rg;
      // Only average over the same surface (depth within ~3%).
      float w = max(0.0, 1.0 - abs(s.g - z0) / (0.03 * z0));
      sum += s.r * w;
      wsum += w;
    }
  }
  gl_FragColor = vec4(wsum > 0.0 ? sum / wsum : 1.0, z0, 0.0, 1.0);
}
#endif
