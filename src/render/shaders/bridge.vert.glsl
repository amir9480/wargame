// Bridge structure: plain vertex-coloured geometry (three.js provides `color` with vertexColors).
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = color;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
