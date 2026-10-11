// Deferred light volume pixel: rebuilds the surface point and normal from the scene depth buffer and
// writes the light's irradiance (additively) into the light buffer. The post pass multiplies the
// accumulated light with the surface colour (see post.frag.glsl).
uniform sampler2D tDepth;
uniform mat4 invViewProj;
uniform vec2 lightResolution; // size of the light buffer (a share of the screen, see QualitySettings.lightResolution)

varying vec3 vCenter;
varying float vRadius;
varying vec3 vColor;
varying vec4 vSpot;

#include ./chunks/fogdist.glsl;
#include ./chunks/townkeep.glsl;
uniform vec2 resolution; // size of the main view (the light buffer is a share of it)

vec3 worldAt(vec2 uv, float d) {
  vec4 c = invViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return c.xyz / c.w;
}

void main() {
  vec2 uv = gl_FragCoord.xy / lightResolution;
  if (!townKeep(uv * resolution)) discard; // a town's detailed lights give way to its city model's, per pixel (townkeep.glsl)
  float d0 = texture2D(tDepth, uv).r;
  if (d0 >= 1.0) discard;
  vec3 P = worldAt(uv, d0);

  vec3 toLight = vCenter - P;
  float dist = length(toLight);
  if (dist >= vRadius) discard;
  vec3 L = toLight / max(dist, 1e-4);

  float spot = 1.0;
  if (vSpot.w > -1.0) {
    spot = smoothstep(vSpot.w, mix(vSpot.w, 1.0, 0.5), dot(-L, vSpot.xyz));
    if (spot <= 0.0) discard;
  }

  // Normal from depth, using the neighbour with the smaller depth step so silhouettes don't smear.
  vec2 px = 1.0 / lightResolution;
  float dR = texture2D(tDepth, uv + vec2(px.x, 0.0)).r;
  float dL = texture2D(tDepth, uv - vec2(px.x, 0.0)).r;
  float dU = texture2D(tDepth, uv + vec2(0.0, px.y)).r;
  float dD = texture2D(tDepth, uv - vec2(0.0, px.y)).r;
  vec3 ex = abs(dR - d0) < abs(d0 - dL) ? worldAt(uv + vec2(px.x, 0.0), dR) - P : P - worldAt(uv - vec2(px.x, 0.0), dL);
  vec3 ey = abs(dU - d0) < abs(d0 - dD) ? worldAt(uv + vec2(0.0, px.y), dU) - P : P - worldAt(uv - vec2(0.0, px.y), dD);
  vec3 N = cross(ex, ey);
  N = length(N) > 1e-6 ? normalize(N) : vec3(0.0, 1.0, 0.0);
  if (dot(N, cameraPosition - P) < 0.0) N = -N;

  float ndl = clamp((dot(N, L) + 0.25) / 1.25, 0.0, 1.0); // slight wrap: no hard terminator
  float x = dist / vRadius;
  float falloff = (1.0 - x * x) * (1.0 - x * x) / (1.0 + 4.0 * x * x);
  float fog = fogFade(P);

  gl_FragColor = vec4(vColor * (falloff * ndl * spot * (1.0 - fog)), 1.0);
}
