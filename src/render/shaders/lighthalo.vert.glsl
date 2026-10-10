// Far-away look of a light: a camera-facing disc that grows with distance (so it stays a visible dot) and
// fades in between haloStart and haloEnd camera distance.
uniform float level; // group dimmer
uniform float haloStart;
uniform float haloEnd;

#include ./chunks/gameview.glsl;
#include ./chunks/signal.glsl;
#include ./chunks/anim.glsl;
#include ./chunks/twinkle.glsl;
#if !defined(SIGNAL) && !defined(ANIM)
uniform float time; // seconds on the shared render clock (the signal / anim chunks declare it otherwise)
#endif

varying vec2 vUv;
varying vec3 vColor;
varying float vBokeh;

void main() {
  vUv = uv;
  vec3 center = instanceMatrix[3].xyz;
  float dist = distance(fogOrigin, center);
  float fade = smoothstep(haloStart, haloEnd, dist);
  vBokeh = bokehAmount(dist);
  float size = max(length(instanceMatrix[0].xyz), dist * 0.012 * haloShrink(dist)) * (1.0 + BOKEH_GROW * vBokeh);
  vColor = instanceColor * level * fade * twinkleFar(center, time, dist);
#ifdef SIGNAL
  vColor *= signalColor();
#endif
#ifdef ANIM
  vColor *= animBlink();
  if (aAnim.x > 1.5) {
    // A rotating beam is seen as a flash when it points at the camera, and a faint glow otherwise.
    vec2 toCam = normalize(fogOrigin.xz - center.xz + 1e-4);
    vColor *= 0.1 + 0.9 * pow(max(dot(animBeamDir(), toCam), 0.0), 8.0);
  }
#endif
  vec3 right = gameRight;
  vec3 up = gameUp;
  vec4 wp = vec4(center + (right * position.x + up * position.y) * size, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
