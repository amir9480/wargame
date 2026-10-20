// Map-edge haze: the generated grid ends in a margin beyond the play area, and its edge would stand out against the sky.
// Points melt into the horizon haze (fog.glsl) between fogNear and fogFar, measured as max(|x|, |z|) from the map
// centre (square, like the grid), independent of the camera, so distant parts of the play area stay visible at any
// zoom. Light passes that add light on top of the scene fade out over the same range. gameview.glsl's fogOrigin (the game
// camera, frozen under the debug freeze: see Engine.cameraFrozen) is for LOD distances; the fog itself (fog.glsl) is measured
// from the viewing camera.
#include ./gameview.glsl;
uniform float fogNear;
uniform float fogFar;

// High ground counts as nearer by HIGH_GROUND_PULL per metre above HIGH_GROUND: mountain ranges in the margin keep their
// summits clear instead of melting into flat haze silhouettes; they fall away low by the grid edge (ranges.ts), which
// still disappears.
#define HIGH_GROUND 20.0
#define HIGH_GROUND_PULL 0.5

float fogFade(vec3 worldPos) {
  float d = max(abs(worldPos.x), abs(worldPos.z)) - HIGH_GROUND_PULL * max(worldPos.y - HIGH_GROUND, 0.0);
  return smoothstep(fogNear, fogFar, d);
}
