uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
varying float vCover;

#include ./chunks/fog.glsl;

// Wires fade out with distance: the share of a pixel they cover is the opacity, drawn as a screen-space dither (no blending
// needed, so wires stay in the opaque pass) that the AA / post pass smooths. wireFade = (fade start, fully gone) in metres per
// material (pylon wires reach further than pole wires); the meshes are culled beyond that by their chunk's lodMax.
uniform vec2 wireFade;

void main() {
  float dist = distance(fogOrigin, vWorldPos);
  float cover = clamp(vCover, 0.0, 1.0);
  float alpha = cover * cover * (1.0 - smoothstep(wireFade.x, wireFade.y, dist));
  // Interleaved gradient noise: a stable, evenly spread threshold per pixel.
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (alpha < 0.999 && alpha <= noise) discard;

  vec3 n = normalize(vNormal);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = vColor * (ambient + sunColor * max(dot(n, sunDir), 0.0));
  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
