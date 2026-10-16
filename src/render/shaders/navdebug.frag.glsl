uniform sampler2D tMask;
uniform float opacity;

varying vec3 vWorldPos;
varying vec2 vUv;

#include ./chunks/fog.glsl;

void main() {
  vec4 m = texture2D(tMask, vUv);
  if (m.a < 0.004) discard;
  gl_FragColor = vec4(applyFog(m.rgb, vWorldPos), m.a * opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
