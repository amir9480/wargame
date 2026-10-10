// Player base build area, draped over the terrain. uv: 0..1 across the square.
varying vec3 vWorldPos;
varying vec2 vUv;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
