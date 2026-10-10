// HDR bloom (dual filter), one shader, pass picked by define (see bloom.ts):
//  PASS_PREFILTER: scene colour -> half resolution, soft threshold (only light brighter than a lit white surface blooms)
//  PASS_DOWN:      5-tap downsample to the next (half-size) level
//  PASS_UP:        8-tap tent upsample of the smaller level, added (blending) onto the larger one
// The post pass adds the largest level to the scene.

uniform sampler2D tSource;
uniform vec2 texel; // texel size of tSource

varying vec2 vUv;

#ifdef PASS_PREFILTER
uniform float threshold;
uniform float knee;

void main() {
  // Four bilinear taps = a 4x4 box of the full-resolution scene (no aliasing of small bright spots).
  vec3 c = texture(tSource, vUv + texel * vec2(-1.0, -1.0)).rgb + texture(tSource, vUv + texel * vec2(1.0, -1.0)).rgb
         + texture(tSource, vUv + texel * vec2(-1.0, 1.0)).rgb + texture(tSource, vUv + texel * vec2(1.0, 1.0)).rgb;
  c = min(c * 0.25, vec3(64.0)); // no fireflies
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  gl_FragColor = vec4(c * (max(soft, br - threshold) / max(br, 1e-4)), 1.0);
}
#endif

#ifdef PASS_DOWN
void main() {
  vec2 h = texel;
  vec3 c = texture(tSource, vUv).rgb * 4.0
         + texture(tSource, vUv - h).rgb + texture(tSource, vUv + h).rgb
         + texture(tSource, vUv + vec2(h.x, -h.y)).rgb + texture(tSource, vUv - vec2(h.x, -h.y)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}
#endif

#ifdef PASS_UP
void main() {
  vec2 h = texel;
  vec3 c = texture(tSource, vUv + vec2(-2.0 * h.x, 0.0)).rgb + texture(tSource, vUv + vec2(2.0 * h.x, 0.0)).rgb
         + texture(tSource, vUv + vec2(0.0, -2.0 * h.y)).rgb + texture(tSource, vUv + vec2(0.0, 2.0 * h.y)).rgb
         + (texture(tSource, vUv + vec2(-h.x, h.y)).rgb + texture(tSource, vUv + vec2(h.x, h.y)).rgb
          + texture(tSource, vUv + vec2(h.x, -h.y)).rgb + texture(tSource, vUv + vec2(-h.x, -h.y)).rgb) * 2.0;
  gl_FragColor = vec4(c / 12.0, 1.0);
}
#endif
