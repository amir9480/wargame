// Colour grade: the scene's linear HDR colour -> the display-encoded (sRGB) graded colour, through the 3D lookup table
// baked in gradeLut.ts (GTA IV style: drained, cold cast, gritty contrast). Applied by every quality's first full-screen
// pass (post.frag.glsl, grade.frag.glsl); the final pass (final.frag.glsl) then works on display-encoded colours.
uniform highp sampler3D tGradeLut;
#define GRADE_LUT_SIZE 32.0

vec3 srgbEncode(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 colorGrade(vec3 col) {
  vec3 e = srgbEncode(col);
  vec3 k = clamp(e, 0.0, 1.0);
  // HDR values above 1 (sun disc, bright sky) go past the table unchanged.
  return texture(tGradeLut, k * ((GRADE_LUT_SIZE - 1.0) / GRADE_LUT_SIZE) + 0.5 / GRADE_LUT_SIZE).rgb + (e - k);
}
