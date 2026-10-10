// Deferred-style lighting extras, applied to the finished HDR scene using only its depth buffer:
//  - sun shadow map (cascade-less, centred on the camera focus)
//  - screen-space contact shadows (short ray march towards the sun)
//  - screen-space ambient occlusion (computed at half resolution by ao.frag.glsl, upsampled here)
//  - deferred local lights: irradiance from the light buffer (see lights.ts) times the surface colour
// Shadows and occlusion fade out beyond `regionR` from the focus point, so only objects near the camera pay for them.

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2DShadow tShadow;
uniform sampler2D tNoise;     // 64x64 blue-noise rotation map: rg = (cos, sin) of a per-texel angle, b = noise value
uniform sampler2D tRay;       // light rays (half resolution, linear filtered): scattered light, added as is
uniform float rayOn;
uniform sampler2D tLight;     // irradiance of the local lights, accumulated by their volumes
uniform float lightOn;       // 0 = light buffer empty this frame
uniform vec2 lightSize;      // light buffer size (a share of the screen, QualitySettings.lightResolution)
uniform mat4 invViewProj;
uniform mat4 viewProj;
uniform mat4 shadowVP;
uniform vec3 sunDir;
uniform vec3 focus;
uniform vec3 camPos;         // scene camera (the built-in cameraPosition belongs to the full-screen quad's camera)
uniform float regionR;
uniform vec2 resolution;
uniform float pxScale;       // pixels per world unit at distance 1
uniform float camNear;
uniform float camFar;
uniform float texelWorld;    // shadow map texel size, world units
uniform float shadowTexel;   // shadow map texel size, uv units
uniform float shadowRange;   // shadow camera depth range, world units
uniform float sunLum;
uniform float ambLum;
uniform float aoStrength;
uniform float shadowStrength;
uniform float contactLength;
uniform int shadowTaps;      // shadow-map taps per pixel (1 = single filtered tap)
uniform int contactSteps;    // 0 = no contact shadows
uniform sampler2D tAO;       // half-res ambient occlusion (r) and its linear depth (g), see ao.frag.glsl
uniform vec2 aoSize;
uniform float aoOn;          // 0 = no ambient occlusion
uniform sampler2D tBloom;    // half-res HDR bloom (postfx.ts), linear filtered
uniform float bloomStrength; // 0 = off
uniform sampler2D tGod;      // half-res sun god rays (postfx.ts)
uniform float godOn;
// Debug views (debugView.ts DEBUG_SHADER_ID): 0 normal, 1 shadows, 2 AO, 3 local lights, 4 depth, 5 normals (each one shows
// its term alone), 6 triangles only (scene colour as drawn, no lighting extras), 7 triangles overlay (normal image).
uniform int debugView;
varying vec2 vUv;

#include ./chunks/fog.glsl; // fogFade (fogNear / fogFar are copied from the light field every frame) + the aerial LUT
#include ./chunks/grade.glsl;

// Sun shadows fade out between these camera distances (m); keep in sync with SHADOW_FADE_END in lighting.ts.
#define SHADOW_FADE_START 500.0
#define SHADOW_FADE_END 700.0

// Contact shadows fade out between these camera distances (m) and are not marched beyond.
#define CONTACT_FADE_START 45.0
#define CONTACT_FADE_END 110.0

vec3 worldAt(vec2 uv, float d) {
  vec4 c = invViewProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return c.xyz / c.w;
}

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * camNear * camFar / (camFar + camNear - z * (camFar - camNear));
}

// The light buffer is drawn at a lower resolution: upsample it with bilinear weights cut where a texel's depth (taken
// where light.frag took it, at the texel centre) lies on another surface, so light doesn't bleed across silhouettes.
vec3 lightAt(float z0) {
  vec2 pos = vUv * lightSize - 0.5;
  vec2 base = floor(pos), f = pos - base;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i - (i / 2) * 2), float(i / 2));
    vec2 uv = (base + o + 0.5) / lightSize;
    float z = linearDepth(texture2D(tDepth, uv).r);
    vec2 b = mix(1.0 - f, f, o);
    float w = b.x * b.y * max(1e-3, 1.0 - abs(z - z0) / (0.03 * z0)) + 1e-5;
    sum += texture2D(tLight, uv).rgb * w;
    wsum += w;
  }
  return sum / wsum;
}

void main() {
  vec4 src = texture2D(tColor, vUv);
  vec3 col = src.rgb;
  bool showTerm = debugView >= 1 && debugView <= 5;
  vec3 term = vec3(0.03); // the debug term shown for this pixel (sky and anything the term doesn't reach stay dark)
  float d0 = texture2D(tDepth, vUv).r;
  if (debugView == 4 && d0 < 1.0) term = vec3(exp(-linearDepth(d0) / 400.0));

  // src.a < 0.5 marks far-LOD sprite pixels (see billboard.frag.glsl): left untouched. (Triangles-only view: no extras.)
  if (d0 < 1.0 && src.a > 0.5 && debugView != 6) {
    vec3 P = worldAt(vUv, d0);
    float region = 1.0 - smoothstep(0.75 * regionR, regionR, distance(P.xz, focus.xz));
    // Pixels that melted into the map-edge haze (fogdist.glsl) keep no shadows / occlusion: they are haze colour already.
    region *= 1.0 - fogFade(P);
    // Shadows / AO darken the finished colour, which already has the aerial haze and ground mist in it: fade them with
    // the share of the surface's own light that survives the air (same terms as applyFog), so haze isn't darkened.
    if (region > 0.001) {
      vec3 v = P - fogOrigin;
      float dist = length(v);
      vec4 ap = texture(tAerial, aerialUvw(v / max(dist, 1e-3), sqrt(min(dist * aerialScale, 1.0)), apSize));
      float mist = (1.0 - exp(-dist * MIST_PER_M)) * exp(-max(P.y - MIST_BASE, 0.0) / MIST_HEIGHT) * MIST_MAX;
      region *= ap.a * (1.0 - mist * smoothstep(0.02, 0.15, 1.0 - ap.a));
    }
    vec3 irradiance = lightOn > 0.5 ? lightAt(linearDepth(d0)) : vec3(0.0);
    bool lit = dot(irradiance, irradiance) > 1e-6;
    // Debug terms where the effects don't reach: no shadow, no occlusion; local lights everywhere.
    if (debugView == 1 || debugView == 2) term = vec3(1.0);
    else if (debugView == 3) term = min(irradiance * 0.5, vec3(1.0));

    if (region > 0.001 || lit || debugView == 5) {
      // Normal from depth: use the neighbour with the smaller depth step so silhouettes don't smear.
      vec2 px = 1.0 / resolution;
      float dR = texture2D(tDepth, vUv + vec2(px.x, 0.0)).r;
      float dL = texture2D(tDepth, vUv - vec2(px.x, 0.0)).r;
      float dU = texture2D(tDepth, vUv + vec2(0.0, px.y)).r;
      float dD = texture2D(tDepth, vUv - vec2(0.0, px.y)).r;
      vec3 ex = abs(dR - d0) < abs(d0 - dL) ? worldAt(vUv + vec2(px.x, 0.0), dR) - P : P - worldAt(vUv - vec2(px.x, 0.0), dL);
      vec3 ey = abs(dU - d0) < abs(d0 - dD) ? worldAt(vUv + vec2(0.0, px.y), dU) - P : P - worldAt(vUv - vec2(0.0, px.y), dD);
      vec3 N = cross(ex, ey);
      N = length(N) > 1e-6 ? normalize(N) : vec3(0.0, 1.0, 0.0);
      float viewDist = distance(camPos, P);
      if (dot(N, camPos - P) < 0.0) N = -N;

      // Smooth normal for shading terms (sun share, shadow bias, AO): the 1-pixel normal is flat per triangle, so
      // anything weighted by it steps at every triangle edge of the faceted terrain. Central differences over at
      // least one terrain cell (2 m) average neighbouring facets; one-sided across depth jumps, and the sharp normal
      // where the two disagree a lot (silhouettes, real edges).
      vec3 NS = N;
      {
        vec2 o = vec2(clamp(2.5 * pxScale / viewDist, 2.0, 24.0)) * px;
        vec2 uR = vUv + vec2(o.x, 0.0), uL = vUv - vec2(o.x, 0.0), uU = vUv + vec2(0.0, o.y), uD = vUv - vec2(0.0, o.y);
        float wR = texture2D(tDepth, uR).r, wL = texture2D(tDepth, uL).r, wU = texture2D(tDepth, uU).r, wD = texture2D(tDepth, uD).r;
        vec3 pR = worldAt(uR, wR), pL = worldAt(uL, wL), pU = worldAt(uU, wU), pD = worldAt(uD, wD);
        float jR = distance(pR, P), jL = distance(pL, P), jU = distance(pU, P), jD = distance(pD, P);
        vec3 ax = max(jR, jL) < 2.0 * min(jR, jL) ? pR - pL : (jR < jL ? pR - P : P - pL);
        vec3 ay = max(jU, jD) < 2.0 * min(jU, jD) ? pU - pD : (jU < jD ? pU - P : P - pD);
        vec3 w = cross(ax, ay);
        if (length(w) > 1e-6) {
          w = normalize(w);
          if (dot(w, camPos - P) < 0.0) w = -w;
          if (dot(w, N) > 0.7) NS = w;
        }
      }

      // One baked-noise fetch per pixel: filter direction (rg) and jitter value (b). Blue noise keeps neighbouring
      // pixels' directions well spread, so the few shadow taps dither into a soft edge instead of a noisy one.
      vec4 nz = texture2D(tNoise, gl_FragCoord.xy / 64.0);
      vec2 nDir = nz.rg * 2.0 - 1.0;
      float noise = nz.b;
      float ndl = max(dot(NS, sunDir), 0.0);
      // Share of the pixel's light that came from the sun: only that part can be shadowed.
      float direct = sunLum * ndl;
      float sunShare = direct / (ambLum + direct);

      // ---- sun shadow map (1-4 hardware-PCF taps along a baked blue-noise direction) ----
      float shadow = 0.0;
      // Far from the camera nothing is shadowed (the shadow map isn't even drawn when the whole region is that far).
      float shadowFade = 1.0 - smoothstep(SHADOW_FADE_START, SHADOW_FADE_END, viewDist);
      if (region > 0.001 && shadowFade > 0.001 && sunShare > 0.01 && shadowStrength > 0.001) {
        vec4 lc = shadowVP * vec4(P + NS * texelWorld * 1.5, 1.0);
        vec3 sc = lc.xyz * 0.5 + 0.5;
        if (all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xy, vec2(1.0))) && sc.z < 1.0) {
          float bias = (0.1 + 0.3 * (1.0 - ndl)) / shadowRange;
          float lit = 0.0;
          if (shadowTaps <= 1) {
            lit = texture(tShadow, vec3(sc.xy, sc.z - bias));
          } else {
            // Taps on opposite sides of the pixel's direction (and, for 4, its perpendicular).
            vec2 dirs[4] = vec2[4](nDir, -nDir, vec2(-nDir.y, nDir.x), vec2(nDir.y, -nDir.x));
            for (int i = 0; i < 4; i++) {
              if (i >= shadowTaps) break;
              lit += texture(tShadow, vec3(sc.xy + dirs[i] * shadowTexel * 1.5, sc.z - bias));
            }
            lit /= float(min(shadowTaps, 4));
          }
          shadow = (1.0 - lit) * shadowFade;
        }
      }

      // ---- contact shadows: short march towards the sun through the depth buffer ----
      float contact = 0.0;
      // Only where the shadow map left the pixel lit (it would add nothing in shade) and close to the camera (the march
      // is a few metres long, so it is invisible further away): the other pixels skip the whole march.
      float contactFade = 1.0 - smoothstep(CONTACT_FADE_START, CONTACT_FADE_END, viewDist);
      if (contactSteps > 0 && shadow < 0.9 && contactFade > 0.001 && region > 0.001 && sunShare > 0.01 && shadowStrength > 0.001) {
        vec3 o = P + NS * (0.04 + viewDist * 0.0008);
        float jitter = texture2D(tNoise, (gl_FragCoord.xy + vec2(17.0, 31.0)) / 64.0).b;
        float tol = 0.05 + viewDist * 0.002;
        for (int i = 0; i < 24; i++) {
          if (i >= contactSteps) break;
          float t = (float(i) + jitter + 0.5) / float(contactSteps);
          vec3 Q = o + sunDir * (t * t * contactLength);
          vec4 qc = viewProj * vec4(Q, 1.0);
          if (qc.w <= 0.0) break;
          vec3 qn = qc.xyz / qc.w;
          vec2 quv = qn.xy * 0.5 + 0.5;
          if (quv.x < 0.0 || quv.y < 0.0 || quv.x > 1.0 || quv.y > 1.0) break;
          float sd = texture2D(tDepth, quv).r;
          float diff = linearDepth(qn.z * 0.5 + 0.5) - linearDepth(sd);
          if (diff > tol && diff < 0.9) {
            contact = contactFade;
            break;
          }
        }
      }

      // ---- ambient occlusion: depth-aware upsample of the half-res result ----
      float ao = 1.0;
      if (aoOn > 0.5 && region > 0.001) {
        float z0 = linearDepth(d0);
        vec2 pos = vUv * aoSize - 0.5;
        vec2 base = floor(pos), f = pos - base;
        float sum = 0.0, wsum = 0.0;
        for (int i = 0; i < 4; i++) {
          vec2 o = vec2(float(i - (i / 2) * 2), float(i / 2));
          vec2 s = texture2D(tAO, (base + o + 0.5) / aoSize).rg;
          vec2 b = mix(1.0 - f, f, o);
          // Bilinear weight, cut where the half-res texel lies on another surface (edges stay crisp).
          float w = b.x * b.y * max(1e-3, 1.0 - abs(s.g - z0) / (0.03 * z0)) + 1e-5;
          sum += s.r * w;
          wsum += w;
        }
        ao = 1.0 - (1.0 - sum / wsum) * aoStrength;
      }

      float sh = 1.0 - (1.0 - shadow) * (1.0 - contact * 0.8);
      if (debugView == 1) term = vec3(1.0 - sh * region);
      else if (debugView == 2) term = vec3(mix(1.0, ao, region));
      else if (debugView == 5) term = NS * 0.5 + 0.5;
      col *= 1.0 - sh * sunShare * shadowStrength * region;
      col *= mix(1.0, ao, region * (0.35 + 0.65 * (1.0 - sunShare)));

      // Local lights: the scene colour is unshadowed sun + ambient light times the surface colour, so dividing
      // by that light gives the surface colour back; it is then lit by the local lights (after sun shadows).
      if (lit) {
        vec3 albedo = min(src.rgb / max(ambLum + direct, 0.04), vec3(1.5));
        col += albedo * irradiance * mix(1.0, ao, 0.6);
      }
    }
  }

  if (debugView != 6) {
    if (rayOn > 0.5) col += texture2D(tRay, vUv).rgb;
    if (bloomStrength > 0.0) col += texture2D(tBloom, vUv).rgb * bloomStrength;
    if (godOn > 0.5) col += texture2D(tGod, vUv).rgb;
  }

  col = colorGrade(col); // display-encoded from here on: the final pass (final.frag.glsl) reads it
  if (showTerm) col = term; // debug views: the term itself, already display values

  gl_FragColor = vec4(col, 1.0);
}
