// Deferred light volume: one instanced sphere per light, drawn from the inside (back faces) so the
// camera may be within it. Position and reach come from the instance matrix, colour from
// instanceColor (HDR, intensity included), spot cone from aSpot.
attribute vec4 aSpot; // xyz = spot direction, w = cos(outer cone); w < -1 marks a point light

uniform float level; // group dimmer (street lights: 0 by day, 1 at night)

#include ./chunks/gameview.glsl;
#include ./chunks/townfade.glsl;
#include ./chunks/signal.glsl;
#include ./chunks/anim.glsl;

varying vec3 vCenter;
varying float vRadius;
varying vec3 vColor;
varying vec4 vSpot;
varying vec2 vTown;

void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vCenter = m[3].xyz;
  vRadius = length(m[0].xyz) / VOLUME_SCALE;
  vTown = townFade();
  vColor = instanceColor * level;
#ifdef SIGNAL
  vColor *= signalColor();
#endif
  vSpot = aSpot;
#ifdef ANIM
  vColor *= animBlink();
  vSpot.xyz = animAxis(aSpot.xyz); // rotating beams turn
#endif
  gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0);
  if (vTown.y != 0.0 && vTown.x < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // fully handed over to the other level
}
