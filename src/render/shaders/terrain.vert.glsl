// Chunk-border skirt vertices carry the position of the edge they hang from (so a crack shows ground
// colours, not underwater ones) and are moved by `skirt` (down, slightly outward) only for rasterisation.
attribute vec3 skirt;

varying vec3 vWorldPos;
varying vec3 vNormal;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  wp.xyz += skirt;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
