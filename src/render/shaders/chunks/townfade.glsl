// Vertex side of the cross-fade of a town's lights between its detailed lights (deferred volumes, chunk pools, window halos)
// and its city model's lights (one pool mesh, window halos). The same dithered blue-noise fade as the city model's surfaces
// (buildingFar.frag.glsl, townLod.ts): from the town centre's distance to the camera each pixel belongs to exactly one of
// the two, so they never add up in the band round the switch distance. The fragment side is chunks/townkeep.glsl.
// Needs fogOrigin: include chunks/gameview.glsl first. Instance attribute aTown: town index + 1 for the detailed lights,
// -(town index + 1) for the city model's, 0 (or no attribute) for lights outside towns.
uniform vec4 townInfo[16]; // per town, two entries: (centre x, y, z, switch distance), (band half width, 0, 0, 0)
attribute float aTown;

#ifdef LIGHT_SWITCH
// Lights outside towns: the deferred volumes (LIGHT_SWITCH = 1) and the overlay pools (-1) cross-fade the same way, by the
// light's own distance to the camera. x = switch distance (0 = no switch: low quality draws pools only), y = band half width.
uniform vec2 lightSwitch;
#endif

/** (share of pixels this light keeps, role): role +1 detailed light, -1 city model's light, 0 outside towns (keeps all). */
vec2 townFade() {
  int t = int(abs(aTown) + 0.5) - 1;
  if (t < 0) {
#ifdef LIGHT_SWITCH
    if (lightSwitch.x > 0.0) {
      float pool = smoothstep(lightSwitch.x - lightSwitch.y, lightSwitch.x + lightSwitch.y, distance(fogOrigin, (modelMatrix * instanceMatrix)[3].xyz));
      return LIGHT_SWITCH > 0.0 ? vec2(1.0 - pool, 1.0) : vec2(pool, -1.0);
    }
#endif
    return vec2(1.0, 0.0);
  }
  vec4 info = townInfo[t * 2];
  float band = townInfo[t * 2 + 1].x;
  float model = smoothstep(info.w - band, info.w + band, distance(fogOrigin, info.xyz));
  return aTown > 0.0 ? vec2(1.0 - model, 1.0) : vec2(model, -1.0);
}
