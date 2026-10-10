varying vec3 vWorldPos;
#ifdef STREAM
// Mountain stream ribbon: xz = downstream direction, z = steepness 0..1.
attribute vec3 aFlow;
varying vec3 vFlow;
#endif

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
#ifdef STREAM
  vFlow = aFlow;
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
