// Sky dome: a unit sphere around the drawing camera, pushed onto the far plane (depth exactly 1, like the cleared depth
// buffer, so the post pass still treats sky pixels as "nothing there").
varying vec3 vDir;

void main() {
  vDir = position;
  vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + position * 1000.0, 1.0);
  gl_Position = p.xyww;
}
