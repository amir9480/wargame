// Walkable-area debug overlay, draped over the terrain. The mask texture is indexed by world position (one texel per nav cell).
uniform float navOrigin;
uniform float navSize;

varying vec3 vWorldPos;
varying vec2 vUv;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vUv = (wp.xz - navOrigin) / navSize;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
