varying vec2 vUv;
varying vec3 vColor;
varying float vBokeh; // 0 = sharp dot, 1 = out-of-focus bokeh disc (ultra)

void main() {
  float r = length(vUv - 0.5) * 2.0;
  if (r >= 1.0) discard;
  float g = (1.0 - r) / (1.0 + 40.0 * r * r); // bright core, short tail
  if (vBokeh > 0.0) {
    // Flat disc with a brighter rim and soft edge; the quad is larger, so the energy is spread over its area.
    float disc = smoothstep(1.0, 0.45, r) * (0.8 + 0.3 * smoothstep(0.5, 0.85, r)) * 0.35;
    g = mix(g, disc, vBokeh);
  }
  gl_FragColor = vec4(vColor * g, 1.0);
}
