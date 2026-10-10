// Far-away window light: camera-facing disc (lighthalo.frag.glsl) that keeps a few pixels wide with distance and
// fades in between haloStart and haloEnd camera distance, only while its window is lit (chunks/windows.glsl).
// Destroyed buildings zero their instance scale. aHalo = window key + building seed hash, aHaloShare = lit share.
attribute vec4 aHalo;
attribute float aHaloShare;
uniform float level; // night dimmer
uniform float haloStart;
uniform float haloEnd;
uniform float time; // seconds on the shared render clock

varying vec2 vUv;
varying vec3 vColor;
varying float vBokeh;

#include ./chunks/gameview.glsl;
#include ./chunks/windows.glsl;
#include ./chunks/twinkle.glsl;

void main() {
  vUv = uv;
  vec3 center = instanceMatrix[3].xyz;
  float scale = length(instanceMatrix[0].xyz);
  float dist = distance(fogOrigin, center);
  float fade = smoothstep(haloStart, haloEnd, dist);
  vBokeh = bokehAmount(dist);
  float size = max(scale, dist * 0.006 * haloShrink(dist)) * (1.0 + BOKEH_GROW * vBokeh) * step(0.001, scale);
  vColor = instanceColor * level * fade * windowLit(aHalo.xyz, aHalo.w, aHaloShare) * twinkleFar(center, time, dist);
  vec3 right = gameRight;
  vec3 up = gameUp;
  vec4 wp = vec4(center + (right * position.x + up * position.y) * size, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
