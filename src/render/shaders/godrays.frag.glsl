// Sun god rays (ultra only, see godrays.ts): half-resolution radial blur towards the sun's screen position. Each pixel
// marches STEPS samples towards the sun and adds the sky colour (depth = far plane) it meets, weighted by closeness to
// the sun, so terrain, trees and buildings in front of a low sun cut dark shafts out of its glow. Added in the post pass.

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNoise;
uniform vec2 sunUv;
uniform float aspect;
uniform float strength;

varying vec2 vUv;

const int STEPS = 40;
const float DECAY = 0.965;
const float FALLOFF = 5.0; // glow radius, screen heights^-1

void main() {
  vec2 delta = sunUv - vUv;
  float jitter = texture(tNoise, gl_FragCoord.xy / 64.0).b;
  vec3 acc = vec3(0.0);
  float decay = 1.0;
  for (int i = 0; i < STEPS; i++) {
    vec2 uv = vUv + delta * ((float(i) + jitter) / float(STEPS));
    decay *= DECAY;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    if (texture(tDepth, uv).r < 1.0) continue; // occluded
    vec2 s = (uv - sunUv) * vec2(aspect, 1.0);
    acc += min(texture(tColor, uv).rgb, vec3(8.0)) * exp(-length(s) * FALLOFF) * decay;
  }
  gl_FragColor = vec4(acc * (strength / float(STEPS)), 1.0);
}
