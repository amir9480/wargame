// Instanced traffic light: vertex-coloured model; aLamp marks the lamps (1 red, 2 yellow, 3 green, 0 = housing / pole).
// aSignal (per instance) = [group, cycle offset]: same timing as terrain/urban.ts signalAt.
attribute float aLamp;
attribute vec2 aSignal;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
varying float vLamp;
varying vec2 vSignal;

void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(m) * normal);
  vColor = color;
  vLamp = aLamp;
  vSignal = aSignal;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
