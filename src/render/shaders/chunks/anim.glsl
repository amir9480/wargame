// Animated lights (LightGroup made with `animated`). aAnim = [kind, period s, phase s, blink duty]: kind 1 = a beacon that
// flashes (lit for `duty` of every period), 2 = a rotating beam (a spot light that turns once per period; its horizontal
// direction at a time is beamDir()), 0 = steady. `time` is the shared render clock.
#ifdef ANIM
attribute vec4 aAnim;
#ifndef SIGNAL
uniform float time;
#endif

float animCycle() {
  return fract((time + aAnim.z) / max(aAnim.y, 1e-3));
}

// Flashing beacon: 1 while lit (soft edges), else 0; other kinds 1.
float animBlink() {
  if (aAnim.x < 0.5 || aAnim.x > 1.5) return 1.0;
  float t = animCycle();
  return smoothstep(0.0, 0.03, t) * (1.0 - smoothstep(aAnim.w, aAnim.w + 0.03, t));
}

// Horizontal unit direction (x, z) a rotating beam points to.
vec2 animBeamDir() {
  float a = 6.2831853 * animCycle();
  return vec2(sin(a), cos(a));
}

// Rotates a beam axis (y = its elevation, kept) round the vertical to the current direction.
vec3 animAxis(vec3 axis) {
  if (aAnim.x < 1.5) return axis;
  vec2 d = animBeamDir() * sqrt(max(0.0, 1.0 - axis.y * axis.y));
  return vec3(d.x, axis.y, d.y);
}
#endif
