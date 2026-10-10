// Light ray volume: an instanced sphere around the beam of one spot light, drawn from the inside like the light volumes.
// The fragment shader marches the camera ray through the beam; the beam itself comes in as per-instance data.
attribute vec4 aRayA; // xyz = lamp (beam apex), w = beam length
attribute vec4 aRayB; // xyz = beam axis (unit, lamp -> ground), w = tan(half angle)

uniform float level; // group dimmer

#include ./chunks/anim.glsl;

varying vec4 vRayA;
varying vec4 vRayB;
varying vec3 vCenter;
varying float vRadius;
varying vec3 vColor;

void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vCenter = m[3].xyz;
  vRadius = length(m[0].xyz) / VOLUME_SCALE;
  vRayA = aRayA;
  vRayB = aRayB;
  vColor = instanceColor * level;
#ifdef ANIM
  vColor *= animBlink();
  vRayB.xyz = animAxis(aRayB.xyz); // rotating beams turn (their bounding sphere is centred on the lamp)
#endif
  gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0);
}
