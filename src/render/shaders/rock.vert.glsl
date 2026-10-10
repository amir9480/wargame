// Instanced rock. three.js declares instanceMatrix / instanceColor for InstancedMesh.
#include ./chunks/gameview.glsl;

uniform float lodSwitch;
uniform float lodBias;

varying vec3 vWorldPos;
varying float vLodDist; // game camera distance of the instance (near / sprite cross-fade)
varying vec3 vNormal;
varying vec3 vTint;
varying float vBase;

void main() {
  // Beyond the switch distance (+ bias) the sprite stands in for this instance (see billboard.vert.glsl).
  float lodDist = distance(fogOrigin, instanceMatrix[3].xyz);
  if (lodDist > lodSwitch + lodBias) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume
    return;
  }
  vLodDist = lodDist;
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // Inverse-transpose: instances are non-uniformly scaled.
  vNormal = normalize(transpose(inverse(mat3(m))) * normal);
#ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
#else
  vTint = vec3(1.0);
#endif
  // 0 at the bottom of the rock, 1 at the top: fake contact shadow.
  vBase = smoothstep(-0.45, 0.6, position.y);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
