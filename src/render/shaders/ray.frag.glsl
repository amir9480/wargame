// Light ray: a plain translucent cone under a spot light, as a cheap screen-space march (6 steps, scene depth stops it, so it can
// never be drawn over by roads or trees). Opacity falls off linearly from the lamp (top) to the ground (bottom) and softly towards
// the cone's edge. The result is added in the post pass (see post.frag.glsl).
uniform sampler2D tDepth;
uniform mat4 invViewProj;
uniform vec2 rayResolution; // size of the ray target (half the screen)

varying vec4 vRayA;
varying vec4 vRayB;
varying vec3 vCenter;
varying float vRadius;
varying vec3 vColor;

#include ./chunks/fogdist.glsl;

const int STEPS = 6;
const float STRENGTH = 0.035;
const float CONE_STRENGTH = 0.03; // peak brightness of an analytic cone (ANIM) per unit of light colour
const float SOURCE_RADIUS = 0.4; // the cone is this wide at the lamp, so it starts at the luminaire instead of a point

vec3 worldAt(vec2 uv, float d) {
  vec4 c = invViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return c.xyz / c.w;
}

void main() {
  vec2 uv = gl_FragCoord.xy / rayResolution;
  vec3 ro = cameraPosition;
  vec3 rd = worldAt(uv, texture2D(tDepth, uv).r) - ro;
  float maxT = length(rd);
  rd /= maxT;

  // Part of the camera ray inside the bounding sphere and in front of the scene.
  vec3 oc = ro - vCenter;
  float b = dot(oc, rd);
  float disc = b * b - (dot(oc, oc) - vRadius * vRadius);
  if (disc <= 0.0) discard;
  float root = sqrt(disc);
  float t0 = max(0.0, -b - root);
  float t1 = min(maxT, -b + root);
  if (t1 <= t0) discard;

  vec3 apex = vRayA.xyz;
  float len = vRayA.w;
  vec3 axis = vRayB.xyz;
  float tanHalf = vRayB.w;

#ifdef ANIM
  // Thin beams (lighthouse): a plain translucent cone found analytically, so a narrow cone is never missed between marching
  // steps. The camera ray's closest approach to the cone axis (kept on the visible stretch t0..t1) gives the soft edge; the
  // opacity falls linearly along the axis from the lamp to nothing at the cone's end.
  {
    vec3 w = ro - apex;
    float b = dot(rd, axis), d = dot(rd, w), e = dot(axis, w);
    float den = max(1.0 - b * b, 1e-4);
    float h = clamp((e - b * d) / den, 0.0, len);
    float s = clamp(dot(apex + axis * h - ro, rd), t0, t1);
    vec3 p = ro + rd * s;
    h = clamp(dot(p - apex, axis), 0.0, len);
    float u = length(p - (apex + axis * h)) / (h * tanHalf + SOURCE_RADIUS);
    if (u >= 1.0) discard;
    float alpha = (1.0 - u * u) * (1.0 - h / len) * smoothstep(3.0, 16.0, s);
    float fogA = 1.0 - fogFade(p);
    gl_FragColor = vec4(vColor * (alpha * CONE_STRENGTH * fogA), 1.0);
    return;
  }
#endif

  float dt = (t1 - t0) / float(STEPS);
  float acc = 0.0;
  for (int i = 0; i < STEPS; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 v = ro + rd * t - apex;
    float h = dot(v, axis);
    if (h <= 0.0 || h >= len) continue;
    float u = length(v - axis * h) / (h * tanHalf + SOURCE_RADIUS); // 0 on the axis, 1 at the cone's edge
    if (u >= 1.0) continue;
    float edge = 1.0 - u * u;                       // soft towards the edge
    float along = 1.0 - h / len;                    // bright at the lamp, clear at the ground
    float nearFade = smoothstep(3.0, 16.0, t);      // soft when the camera is close
    acc += edge * along * nearFade;
  }
  float fog = 1.0 - fogFade(ro + rd * t0);
  gl_FragColor = vec4(vColor * (acc * dt * STRENGTH * fog), 1.0);
}
