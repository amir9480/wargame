// Instanced tree: three.js declares instanceMatrix / instanceColor / color.
#include ./chunks/gameview.glsl;

uniform float time;
uniform float lodSwitch;
uniform float lodBias;
uniform float treeHeight;

varying vec3 vWorldPos;
varying float vLodDist; // game camera distance of the instance (near / sprite cross-fade)
varying vec3 vNormal;
varying vec3 vColor;

void main() {
  // Beyond the switch distance (+ bias) the sprite stands in for this instance (see billboard.vert.glsl).
  float lodDist = distance(fogOrigin, instanceMatrix[3].xyz);
  if (lodDist > lodSwitch + lodBias) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume
    return;
  }
  vLodDist = lodDist;
  vec4 local = instanceMatrix * vec4(position, 1.0);

  // Wind: sway grows with height; per-tree phase from its position.
  vec3 root = instanceMatrix[3].xyz;
  float bend = pow(clamp(position.y / treeHeight, 0.0, 1.0), 2.0);
  float phase = root.x * 0.13 + root.z * 0.17;
  local.xz += vec2(sin(time * 1.3 + phase), cos(time * 1.1 + phase * 1.3)) * 0.12 * bend;

  vec4 wp = modelMatrix * local;
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vColor = color;
#ifdef USE_INSTANCING_COLOR
  vColor *= instanceColor;
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
