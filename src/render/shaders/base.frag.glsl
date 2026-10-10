uniform vec3 color;
/** Side length of the square, world units. */
uniform float size;

/** Overall strength of the dashed border. */
#define OPACITY 0.4

varying vec3 vWorldPos;
varying vec2 vUv;

#include ./chunks/fog.glsl;

void main() {
  // Distance to the nearest edge, in world units, and the position along that edge.
  vec2 p = (vUv - 0.5) * size;
  float edge = size * 0.5 - max(abs(p.x), abs(p.y));
  float along = (abs(p.x) > abs(p.y) ? p.y : p.x) + size * 0.5;
  // Dashes: a whole number of periods per side (about 8 m each), so every corner starts with a dash.
  float period = size / max(1.0, floor(size / 8.0 + 0.5));
  float dash = 1.0 - smoothstep(0.58, 0.62, abs(fract(along / period + 0.5) - 0.5) * 2.0);
  float border = (1.0 - smoothstep(1.2, 1.7, edge)) * dash;
  if (border < 0.01) discard;
  float alpha = border * 0.9 * OPACITY;
  vec3 col = color * 1.15;

  gl_FragColor = vec4(applyFog(col, vWorldPos), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
