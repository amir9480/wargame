// Fragment side of the town light cross-fade (see chunks/townfade.glsl): vTown = (share kept, role) from the vertex shader.
// The detailed light keeps a pixel where the screen-space blue noise is above the city model's share, the model's light where
// it is below, the same test and noise as the city model's surfaces use (buildingFar.frag.glsl): exactly one of them draws it.
uniform sampler2D tNoise; // 64x64 blue noise, b = noise value
varying vec2 vTown;

/** `pixel`: the pixel's position in the drawing buffer (gl_FragCoord.xy of the main view). */
bool townKeep(vec2 pixel) {
  if (vTown.y == 0.0) return true;
  float n = texture2D(tNoise, pixel / 64.0).b;
  return vTown.y > 0.0 ? n >= 1.0 - vTown.x : n < vTown.x;
}
