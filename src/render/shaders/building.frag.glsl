uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;
uniform float lampLevel; // 0 (day) - 1 (night): window and sign lights

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
flat varying vec2 vWin;
flat varying vec4 vKey;

#include ./chunks/fog.glsl;
#include ./chunks/windows.glsl;

void main() {
  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = vColor * (ambient + sunColor * ndl);

  float glass = step(0.5, vWin.x) * step(vWin.x, 1.5);
  if (glass > 0.5) {
    // Panes reflect a little sky at grazing angles, and the sun.
    vec3 v = normalize(cameraPosition - vWorldPos);
    float fres = pow(1.0 - max(dot(v, n), 0.0), 3.0);
    lit += skyAmbient * 0.35 * fres + sunColor * pow(max(dot(reflect(-sunDir, n), v), 0.0), 40.0) * 0.5;
  }

  // Night: lit panes glow warm on their own schedule (same as the far facades), signs in their own colour.
  vec3 emit = vColor * 3.0;
  float on = step(1.5, vWin.x);
  if (glass > 0.5) {
    emit = windowColor(vKey.xyz, vKey.w) * 1.15;
    on = windowLit(vKey.xyz, vKey.w, vWin.y);
  }
  lit = mix(lit, emit, on * lampLevel);

  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
