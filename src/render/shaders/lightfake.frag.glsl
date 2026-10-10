varying vec2 vUv;
varying vec3 vColor;

void main() {
  float r = length(vUv - 0.5) * 2.0;
  if (r >= 1.0) discard;
#ifdef FLAT
  // Soft pool. Added as is (no surface colour to multiply with, unlike the deferred light), so it is kept faint: dense
  // town lamps overlap and would wash the streets out.
  float g = (1.0 - r * r) * (1.0 - r * r) * 0.07;
#else
  float g = (1.0 - r) / (1.0 + 40.0 * r * r); // bright core, short tail
#endif
  gl_FragColor = vec4(vColor * g, 1.0);
}
