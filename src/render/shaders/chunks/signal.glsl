// Traffic-signal colour of a light (LightGroup with signals). aSignal = [group, cycle offset]: same timing as
// terrain/urban.ts signalAt and trafficlight.frag.glsl. Returns the colour of the lamp showing (linear, ~1 bright).
#ifdef SIGNAL
attribute vec2 aSignal;
uniform float time; // seconds on the shared signal clock
uniform float signalGreen;
uniform float signalYellow;

vec3 signalColor() {
  float cycle = 2.0 * (signalGreen + signalYellow);
  float t = mod(time + aSignal.y - aSignal.x * (signalGreen + signalYellow), cycle);
  return t < signalGreen ? vec3(0.15, 1.0, 0.45) : t < signalGreen + signalYellow ? vec3(1.0, 0.55, 0.05) : vec3(1.0, 0.08, 0.04);
}
#endif
