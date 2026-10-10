uniform sampler2D tNormal;
uniform sampler2D tHeight;
uniform float time;
uniform float waterLevel;
uniform float mapSize;
uniform float gridSize;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float daylight;
uniform vec3 shallowColor;
uniform vec3 deepColor;

varying vec3 vWorldPos;
#ifdef STREAM
// Mountain stream (ground.ts buildStreams): its own surface height, ripples running downstream, white where steep.
varying vec3 vFlow;
#endif

#include ./chunks/fog.glsl;
#define DETAIL_START 220.0
#define DETAIL_END 360.0
#include ./chunks/lod.glsl;

void main() {
  // Terrain height under this fragment -> water depth.
  vec2 uv = vWorldPos.xz / mapSize + 0.5;
  vec2 huv = (uv * (gridSize - 1.0) + 0.5) / gridSize;
#ifdef STREAM
  float depth = vWorldPos.y - texture2D(tHeight, huv).r;
  vec2 nuv = vWorldPos.xz / 12.0;
  vec2 drift = -vFlow.xy * time * (0.08 + vFlow.z * 0.25);
#else
  float depth = waterLevel - texture2D(tHeight, huv).r;
  vec2 nuv = vWorldPos.xz / 40.0;
  vec2 drift = vec2(time * 0.020, time * 0.013);
#endif
  if (depth < 0.0) discard;

  vec3 n1 = texture2D(tNormal, nuv + drift).rgb * 2.0 - 1.0;
  // Second (cross) ripple layer near the camera only; far away the first one alone, doubled to keep the strength.
  vec2 ripple = n1.xy * 2.0;
  float detail = surfaceDetail(vWorldPos);
  vec2 g = dFdx(nuv * 0.6), h = dFdy(nuv * 0.6); // outside the branch (derivatives need uniform control flow)
  if (detail > 0.0) {
    vec3 n2 = textureGrad(tNormal, nuv * 0.6 + vec2(-time * 0.015, time * 0.021), g, h).rgb * 2.0 - 1.0;
    ripple = mix(ripple, n1.xy + n2.xy, detail);
  }
  vec3 n = normalize(vec3(ripple.x, 0.0, ripple.y) * 0.35 + vec3(0.0, 1.0, 0.0));

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fresnel = mix(0.04, 1.0, pow(1.0 - max(dot(viewDir, n), 0.0), 4.0));

  float lightScale = mix(0.1, 1.0, daylight); // water has no ambient term of its own
  vec3 col = mix(shallowColor, deepColor, smoothstep(0.0, 10.0, depth)) * lightScale;
  // Reflected sky from the baked sky view (dark at night by itself).
  col = mix(col, skyRadiance(reflect(-viewDir, n)), fresnel * 0.6);

  vec3 hv = normalize(sunDir + viewDir);
  col += sunColor * (pow(max(dot(n, hv), 0.0), 140.0) * 1.2);

  float foam = 1.0 - smoothstep(0.0, 0.55, depth + n1.x * 0.25);
#ifdef STREAM
  foam = max(foam, smoothstep(0.2, 0.9, vFlow.z + n1.x * 0.3)); // white water on the steep stretches
#endif
  col = mix(col, vec3(0.92, 0.95, 0.95) * lightScale, foam * 0.55);

  float alpha = max(mix(0.45, 0.92, smoothstep(0.0, 5.0, depth)), foam * 0.7);

  gl_FragColor = vec4(applyFog(col, vWorldPos), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
