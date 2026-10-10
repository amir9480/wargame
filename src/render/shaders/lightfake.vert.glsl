// Cheap stand-in for a deferred light (low quality): an instanced quad per light that is either a glow
// facing the camera (default) or a pool of light draped over the terrain (FLAT: a flat grid whose vertices are lifted to the ground height, so
// the pool never dives under a slope and gets cut off by the depth test).
uniform float level; // group dimmer
#ifdef FLAT
uniform sampler2D tHeight;
uniform float mapSize;
uniform float gridSize;
#endif

#include ./chunks/gameview.glsl;
#include ./chunks/signal.glsl;
#include ./chunks/anim.glsl;

varying vec2 vUv;
varying vec3 vColor;

void main() {
  vUv = uv;
  vColor = instanceColor * level;
#ifdef SIGNAL
  vColor *= signalColor();
#endif
#ifdef ANIM
  vColor *= animBlink();
  if (aAnim.x > 1.5) vColor = vec3(0.0); // a turning beam has no fixed pool of light
#endif
#ifdef FLAT
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec2 uv01 = wp.xz / mapSize + 0.5;
  vec2 huv = (uv01 * (gridSize - 1.0) + 0.5) / gridSize;
  wp.y = texture2D(tHeight, huv).r + 0.35;
#else
  vec3 center = instanceMatrix[3].xyz;
  float size = length(instanceMatrix[0].xyz);
  vec3 right = gameRight;
  vec3 up = gameUp;
  vec4 wp = vec4(center + (right * position.x + up * position.y) * size, 1.0);
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
