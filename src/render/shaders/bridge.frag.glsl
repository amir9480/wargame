uniform sampler2D tRock;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;

#include ./chunks/fog.glsl;

void main() {
  vec3 n = normalize(vNormal);
  // Borrow the rock texture as grain/weathering for wood and concrete alike.
  float grain = texture2D(tRock, (vWorldPos.xz + vWorldPos.y) / 4.0).r;
  vec3 col = vColor * (0.75 + grain * 0.6);

  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = col * (ambient + sunColor * ndl);

  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
