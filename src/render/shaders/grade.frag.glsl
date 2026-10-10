// Grade-only pass for presets without the full post pass (low): the scene is drawn into a target, then graded here
// into the display-encoded target that the final pass reads (see chunks/grade.glsl).
uniform sampler2D tColor;

varying vec2 vUv;

#include ./chunks/grade.glsl;

void main() {
  gl_FragColor = vec4(colorGrade(texture2D(tColor, vUv).rgb), 1.0);
}
