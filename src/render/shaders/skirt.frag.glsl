varying vec3 vColor;
varying vec3 vWorldPos;

#include ./chunks/fog.glsl;

void main() {
  gl_FragColor = vec4(applyFog(vColor, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
