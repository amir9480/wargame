uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;
uniform float lampLevel; // 0 (lamps off, by day) - 1 (lit)

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
varying float vGlow;
varying vec3 vLamp;
uniform float time; // seconds on the shared render clock

#include ./chunks/fog.glsl;
#include ./chunks/twinkle.glsl;

void main() {
  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = vColor * (ambient + sunColor * ndl);
  // Lit lamps are emissive: brighter than anything the sun can make.
  float flicker = twinkleFar(vLamp, time, distance(fogOrigin, vWorldPos));
  lit = mix(lit, vColor * 3.0 * flicker, vGlow * lampLevel);

  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
