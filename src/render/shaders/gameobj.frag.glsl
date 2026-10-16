// Same environment lighting as the map shaders (sun + sky / ground ambient, shadows come from the post pass) and the shared
// aerial perspective / ground mist / edge haze (`applyFog`), so game entities sit in the scene instead of floating over it.
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;
uniform vec3 tint;
uniform float opacity;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vTint;

#include ./chunks/fog.glsl;

void main() {
  vec3 col = vTint * tint;
#ifdef UNLIT
  vec3 lit = col;
#else
  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = col * (ambient + sunColor * ndl);
#endif
  gl_FragColor = vec4(applyFog(lit, vWorldPos), opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
