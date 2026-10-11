// Far light halos of a whole town in one instanced draw (render/cityLod.ts): street lamps (steady, always lit with the night
// level) and one disc per lit building (chunks/windows.glsl schedule, like buildingHalo.vert). Camera-facing discs that stay
// a few pixels wide with distance (lighthalo.frag.glsl) and fade in over their own range; an instance that has not faded in
// yet (too near the camera, where the real lamps and windows are drawn) is moved outside the clip volume here, so it costs
// no fill rate. aHaloShare < 0 marks a lamp; otherwise it is the building's lit share (a destroyed building has scale 0).
attribute vec4 aHalo;
attribute float aHaloShare;
uniform float level; // night dimmer
uniform vec2 lampRange;     // camera distance where lamp halos start to fade in / are at full strength
uniform vec2 buildingRange; // same for the buildings' halos
uniform float time; // seconds on the shared render clock

varying vec2 vUv;
varying vec3 vColor;
varying float vBokeh;
varying vec2 vTown;

#include ./chunks/gameview.glsl;
#include ./chunks/townfade.glsl;
#include ./chunks/windows.glsl;
#include ./chunks/twinkle.glsl;

void main() {
  vUv = uv;
  vColor = vec3(0.0);
  vBokeh = 0.0;
  vec3 center = instanceMatrix[3].xyz;
  float scale = length(instanceMatrix[0].xyz);
  float dist = distance(fogOrigin, center);
  bool lamp = aHaloShare < 0.0;
  vec2 range = lamp ? lampRange : buildingRange;
  float fade = smoothstep(range.x, range.y, dist);
  vTown = townFade(); // window halos: dithered cross-fade with the detailed ones (townfade.glsl)
  if (fade < 0.003 || vTown.x < 0.003 || scale < 0.001 || level < 0.001) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume
    return;
  }
  vBokeh = bokehAmount(dist);
  float size = max(scale, dist * (lamp ? 0.012 : 0.006) * haloShrink(dist)) * (1.0 + BOKEH_GROW * vBokeh);
  float lit = lamp ? 1.0 : windowLit(aHalo.xyz, aHalo.w, aHaloShare);
  vColor = instanceColor * level * fade * lit * twinkleFar(center, time, dist);
  vec4 wp = vec4(center + (gameRight * position.x + gameUp * position.y) * size, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
