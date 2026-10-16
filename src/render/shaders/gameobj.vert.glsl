// Game entities (units, structures, rings, tracers): plain or instanced; vertex colour = part shade, instance colour = team tint.
#include ./chunks/gameview.glsl;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vTint;

void main() {
  mat4 m = modelMatrix;
#ifdef USE_INSTANCING
  m = modelMatrix * instanceMatrix;
#endif
  vec4 wp = m * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // Inverse-transpose: instances are non-uniformly scaled (structures stretch to their footprint).
  vNormal = normalize(transpose(inverse(mat3(m))) * normal);
  vTint = color;
#ifdef USE_INSTANCING_COLOR
  vTint *= instanceColor;
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
