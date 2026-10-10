// Map-edge skirt: vertex-coloured walls, fogged like the terrain they close.
varying vec3 vColor;
varying vec3 vWorldPos;

void main() {
  vColor = color;
  vWorldPos = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
