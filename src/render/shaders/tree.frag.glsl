uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;

varying vec3 vWorldPos;
varying float vLodDist;
varying vec3 vNormal;
varying vec3 vColor;

#include ./chunks/fog.glsl;
#include ./chunks/lodfade.glsl;

void main() {
  // Cross-fade with the sprite: keep this pixel only where the noise is below the near model's share.
  float nearShare = lodNearShare(vLodDist);
  if (nearShare < 1.0 && lodNoise() >= nearShare) discard;
  vec3 n = normalize(vNormal);
  // Wrapped diffuse: foliage scatters light, so shadowed sides aren't black.
  float ndl = max(dot(n, sunDir) * 0.7 + 0.3, 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = vColor * (ambient + sunColor * ndl * 0.85);

  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
