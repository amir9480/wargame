uniform sampler2D tBillboard;
uniform float markSprite; // 1 = write alpha 0 for the lighting pass; 0 = plain opaque output (no lighting pass)

varying vec2 vUv0;
varying vec2 vUv1;
varying float vMix;
varying vec3 vWorldPos;
varying float vLodDist;
varying vec3 vTint;

#include ./chunks/fog.glsl;
#include ./chunks/lodfade.glsl;

void main() {
  // Cross-fade with the near model: the sprite takes the pixels it leaves (noise at or above its share).
  float nearShare = lodNearShare(vLodDist);
  if (nearShare > 0.0 && lodNoise() < nearShare) discard;
  vec4 t = texture2D(tBillboard, vUv0);
  // Second pitch only where it counts (vMix is the same for every pixel of a frame, so the branch is uniform).
  if (vMix > 0.002) t = mix(t, texture2D(tBillboard, vUv1), vMix);
  if (t.a < 0.5) discard;
  // Baked sprite is linear + untonemapped; tint matches the full-mesh instance colour.
  // Alpha 0 marks sprite pixels for the lighting pass (everything else writes 1): a flat quad has no
  // meaningful depth for shadow / occlusion lookups, and the sprite already carries baked shading.
  // Without that pass the alpha would reach the canvas and blend the sprite with the page behind it.
  gl_FragColor = vec4(applyFog(t.rgb * vTint, vWorldPos), 1.0 - markSprite);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
