// Aerial perspective shared by all map shaders: light scattered in by the air between the game camera and the point,
// and the share of the point's own light that gets through, from the baked 3D LUT (atmosphere.ts). Towards the grid
// edge (fogdist.glsl) points fade to the solid horizon haze, the colour the sky dome shows below the horizon.
// Uniforms: `...env.fog` (FogUniforms) plus fogNear / fogFar / fogOrigin.
#include ./fogdist.glsl;
#include ./skymap.glsl;
uniform highp sampler3D tAerial;
uniform vec3 apSize;
uniform float aerialScale;
uniform sampler2D tSkyView;
uniform vec2 skySize;

/** Far haze at the horizon towards `dir`'s azimuth (the aerial LUT's last slice, looking level). */
vec3 horizonHaze(vec3 dir) {
  return texture(tAerial, aerialUvw(levelDirection(dir), 1.0, apSize)).rgb;
}

// Ground mist: damp air that pools low (valleys, shores, flat ground) on top of the aerial haze, in the horizon colour.
// Thickens with distance, thins with the point's height above MIST_BASE (so mountains and ridges stay clear).
#define MIST_BASE 0.0
#define MIST_HEIGHT 20.0
#define MIST_PER_M 0.0014
#define MIST_MAX 0.5

vec3 applyFog(vec3 color, vec3 worldPos) {
  vec3 v = worldPos - fogOrigin;
  float dist = length(v);
  vec4 ap = texture(tAerial, aerialUvw(v / max(dist, 1e-3), sqrt(min(dist * aerialScale, 1.0)), apSize));
  vec3 c = color * ap.a + ap.rgb;
  float mist = (1.0 - exp(-dist * MIST_PER_M)) * exp(-max(worldPos.y - MIST_BASE, 0.0) / MIST_HEIGHT) * MIST_MAX;
  // Haze colour from the aerial tap already taken (in-scatter / opacity = the colour of the air along this ray), so
  // the mist costs no extra 3D texture fetch per fragment. Near the camera the air is clear (opacity ~0): no mist.
  float airOpacity = 1.0 - ap.a;
  if (mist > 0.004 && airOpacity > 0.02) c = mix(c, min(ap.rgb / airOpacity, vec3(4.0)), mist * smoothstep(0.02, 0.15, airOpacity));
  float edge = fogFade(worldPos);
  return edge > 0.0 ? mix(c, horizonHaze(v), edge) : c;
}

/** Sky radiance seen towards `dir` (upper hemisphere; below the horizon gives the horizon). */
vec3 skyRadiance(vec3 dir) {
  return texture(tSkyView, skyViewUv(dir, skySize)).rgb;
}
