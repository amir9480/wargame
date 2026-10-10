// Wet-street light reflection (see reflect.frag.glsl): one screen-space quad per light, laid along the projected vertical
// through the lamp (from its foot on the ground towards its mirror image below the ground, i.e. towards the viewer), so
// the reflection reads as a long vertical streak like on a rainy street. Lamp from the instance matrix (scale = reach),
// colour from instanceColor (HDR), aGround = [ground height under the lamp, streak half width at the lamp (m)]. A zero
// instance scale hides a streak (destroyed building).
// WINDOW: lit windows and signs of buildings: aHalo = window key + building seed hash, aHaloShare = lit share (a window
// streak shows only while its window is lit, in the window's colour, chunks/windows.glsl); < 0 = a sign, always lit.
attribute vec2 aGround;
attribute vec3 aFacing; // horizontal direction a one-sided lamp faces; zero = lights all round

uniform float level;      // group dimmer
uniform vec2 resolution;  // full-resolution pixels

#include ./chunks/signal.glsl;
#ifdef WINDOW
attribute vec4 aHalo;
attribute float aHaloShare;
#include ./chunks/windows.glsl;
#endif

varying vec3 vColor;
varying vec3 vLight;
varying float vGround;
varying vec3 vFacing;
varying vec2 vBase;  // lamp foot, pixels
varying vec2 vAxis;  // unit streak direction, pixels
varying vec2 vSize;  // streak length, half width (pixels)

const float STREAK_LENGTH = 2.6; // x the foot -> mirror image distance on screen

vec2 toPixels(vec4 c) {
  return (c.xy / c.w * 0.5 + 0.5) * resolution;
}

void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec3 L = m[3].xyz;
  float ground = aGround.x;
  float height = max(L.y - ground, 0.5);
  vColor = instanceColor * level;
#ifdef SIGNAL
  vColor *= signalColor();
#endif
#ifdef WINDOW
  if (aHaloShare >= 0.0) vColor *= windowLit(aHalo.xyz, aHalo.w, aHaloShare) * windowColor(aHalo.xyz, aHalo.w);
#endif
  vLight = L;
  vGround = ground;
  vFacing = aFacing;

  mat4 vp = projectionMatrix * viewMatrix;
  vec4 cb = vp * vec4(L.x, ground, L.z, 1.0);
  vec4 cm = vp * vec4(L.x, ground - height, L.z, 1.0);
  if (cb.w < 1.0 || cm.w < 1.0 || level <= 0.0 || dot(vColor, vColor) <= 0.0 || dot(m[0].xyz, m[0].xyz) < 1e-6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // behind the camera / off / unlit / hidden: outside the clip volume
    return;
  }
  vec2 b = toPixels(cb);
  vec2 d = toPixels(cm) - b;
  float sep = length(d);
  float halfW = max(aGround.y * projectionMatrix[1][1] * 0.5 * resolution.y / cb.w, 1.5);
  vec2 axis = sep > 0.5 ? d / sep : vec2(0.0, -1.0);
  float len = max(sep * STREAK_LENGTH, halfW * 8.0);
  vBase = b;
  vAxis = axis;
  vSize = vec2(len, halfW);

  // Unit plane (x, y in -0.5..0.5) -> slightly behind the foot to the streak's end, +-3 half widths across.
  vec2 perp = vec2(-axis.y, axis.x);
  vec2 px = b + axis * (mix(-0.1, 1.0, position.y + 0.5) * len) + perp * (position.x * 6.0 * halfW);
  gl_Position = vec4(px / resolution * 2.0 - 1.0, 0.0, 1.0);
}
