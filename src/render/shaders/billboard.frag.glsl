uniform sampler2D tBillboard;
uniform float markSprite; // 1 = write alpha 0 for the lighting pass; 0 = plain opaque output (no lighting pass)

// Sprite shading the lighting pass can't do (a flat quad has no real depth): sun shadow map lookup at a point on the
// object's surface, and a per-object ambient occlusion term.
uniform sampler2DShadow tShadow;
uniform mat4 shadowVP;
uniform vec3 sunDir;
uniform vec3 focus;
uniform float regionR;
uniform float shadowRange;
uniform float spriteShadow; // sun share of the lit colour; 0 = no shadow map this frame
uniform float spriteAO;     // occlusion strength, 0 = none

varying vec2 vUv0;
varying vec2 vUv1;
varying float vMix;
varying vec3 vWorldPos;
varying float vLodDist;
varying vec3 vTint;
varying vec3 vQuad; // xy: -1..1 across the quad, z: its half size (m)

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
  vec3 col = t.rgb * vTint;
  float r2 = dot(vQuad.xy, vQuad.xy);

  // Per-object occlusion: crowns and boulders are darker low down and towards the middle (light reaches them least there).
  float h = vQuad.y * 0.5 + 0.5;
  float ao = mix(1.0 - 0.4 * spriteAO, 1.0, smoothstep(0.1, 0.75, h));
  ao *= 1.0 - 0.1 * spriteAO * (1.0 - smoothstep(0.3, 0.9, sqrt(r2)));
  col *= ao;

  // Sun shadows: look the map up where the visible surface is (the quad is a plane through the object's centre; the
  // surface bulges towards the camera like a sphere), nudged towards the sun so the object's own shadow proxy
  // doesn't shade it.
  if (spriteShadow > 0.0) {
    float region = 1.0 - smoothstep(0.75 * regionR, regionR, distance(vWorldPos.xz, focus.xz));
    if (region > 0.001) {
      vec3 toCam = normalize(fogOrigin - vWorldPos);
      vec3 P = vWorldPos + toCam * (sqrt(max(1.0 - r2, 0.0)) * vQuad.z * 0.5) + sunDir * (0.25 * vQuad.z);
      vec3 sc = (shadowVP * vec4(P, 1.0)).xyz * 0.5 + 0.5;
      if (all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xy, vec2(1.0))) && sc.z < 1.0) {
        float lit = texture(tShadow, vec3(sc.xy, sc.z - 1.0 / shadowRange));
        col *= 1.0 - (1.0 - lit) * spriteShadow * region;
      }
    }
  }
  // Alpha 0 marks sprite pixels for the lighting pass (everything else writes 1): a flat quad has no
  // meaningful depth for shadow / occlusion lookups, and the sprite is shaded above.
  // Without that pass the alpha would reach the canvas and blend the sprite with the page behind it.
  gl_FragColor = vec4(applyFog(col, vWorldPos), 1.0 - markSprite);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
