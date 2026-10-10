uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;
uniform float time; // seconds on the shared signal clock
uniform float signalGreen;
uniform float signalYellow;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
varying float vLamp;
varying vec2 vSignal;

#include ./chunks/fog.glsl;

void main() {
  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = vColor * (ambient + sunColor * ndl);

  if (vLamp > 0.5) {
    // Phase within the cycle: green, yellow, then red while the other group runs (see signalAt).
    float cycle = 2.0 * (signalGreen + signalYellow);
    float t = mod(time + vSignal.y - vSignal.x * (signalGreen + signalYellow), cycle);
    float showing = t < signalGreen ? 3.0 : t < signalGreen + signalYellow ? 2.0 : 1.0;
    vec3 lamp = vLamp < 1.5 ? vec3(1.0, 0.08, 0.04) : vLamp < 2.5 ? vec3(1.0, 0.55, 0.05) : vec3(0.15, 1.0, 0.45);
    float on = 1.0 - step(0.5, abs(vLamp - showing));
    lit = mix(lamp * 0.08, lamp * 4.0, on);
  }

  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
