// Instanced street light: vertex-coloured model, `glow` marks the lamp's emissive parts.
attribute float glow;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
varying float vGlow;
varying vec3 vLamp; // the lamp post's position: seeds its twinkle

void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vLamp = m[3].xyz;
  vNormal = normalize(mat3(m) * normal);
  // Emissive parts take the lamp's own colour (instanceColor), the rest of the model its vertex colour.
  vColor = glow > 0.5 ? instanceColor : color;
  vGlow = glow;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
