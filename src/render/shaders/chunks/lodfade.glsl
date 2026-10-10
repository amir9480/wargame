// Dithered cross-fade between a near model and its sprite (needs lodSwitch / lodBias uniforms). Both levels draw
// within lodBias of the switch distance; each pixel keeps the near model where the blue noise is below the near
// share and the sprite elsewhere, so exactly one of them covers it and the share slides with the instance distance.
uniform sampler2D tNoise; // 64x64 blue noise, b = noise value
uniform float lodSwitch;
uniform float lodBias;

/** 1 = near model only (closer than switch - bias), 0 = sprite only (beyond switch + bias). */
float lodNearShare(float dist) {
  return 1.0 - smoothstep(lodSwitch - lodBias, lodSwitch + lodBias, dist);
}

float lodNoise() {
  return texture2D(tNoise, gl_FragCoord.xy / 64.0).b;
}
