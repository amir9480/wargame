// Building (near detail): world-space vertex-coloured mesh. aWin = [kind, lit share]: kind 1 = window pane (lit on its
// own schedule, see chunks/windows.glsl), 2 = sign / canopy light (lit at night). aKey = window key + building seed hash.
attribute vec2 aWin;
attribute vec4 aKey;
flat varying vec4 vKey;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
flat varying vec2 vWin;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = color;
  vWin = aWin;
  vKey = aKey;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
