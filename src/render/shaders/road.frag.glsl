// Road surface drawn as a ribbon over the terrain. RAIL is defined for the railway; ASPHALT for paved roads;
// PAVEMENT (with ASPHALT) is a second pass drawing only the paved surface inside the
// shoulders, so where roads meet no shoulder or cap rim shows on top of the asphalt.
/** Centre-line dash pattern length, m. */
#define DASH_PERIOD 3.5

uniform sampler2D tDirt;
uniform sampler2D tGrass;
uniform sampler2D tAsphalt;
uniform float halfWidth;
uniform vec4 townPos;
uniform float townCount;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vRoad;
varying vec4 vEnds;
varying vec4 vGaps;
varying vec2 vSkip;
varying vec2 vCross;
varying vec3 vWalk;
varying vec4 vJunc;
varying vec4 vJuncW;

#include ./chunks/fog.glsl;
#include ./chunks/lod.glsl;
#include ./chunks/paving.glsl;

void main() {
  float x = abs(vRoad.x);
  float along = vRoad.y;
  float detail = surfaceDetail(vWorldPos);
  // Ragged edges so roads blend into the ground instead of looking cut out.
  float rag = texture2D(tDirt, vWorldPos.xz / 9.0).r - 0.35;

#if defined(RAIL)
  // Grey stone ballast, timber sleepers and two steel rails (standard gauge: 1.435 m). Far away: their average colours
  // (sleepers cover 38% of the band, the rails ~6%; stone shading at the dirt texture's mean, 0.06 linear), no texture
  // tap and no pattern.
  vec3 ballast = vec3(0.45, 0.43, 0.41);
  vec3 timber = vec3(0.24, 0.17, 0.11), steel = vec3(0.6, 0.6, 0.62);
  float band = 1.0 - smoothstep(1.25, 1.3, x);
  vec3 stoneAvg = ballast * 0.605;
  vec3 col = mix(stoneAvg, mix(mix(stoneAvg, timber, 0.38), steel, 0.06), band);
  float rail = 0.0;
  if (detail > 0.0) {
    float stone = dot(texture2D(tDirt, vWorldPos.xz / 2.5).rgb, vec3(0.333));
    vec3 near = ballast * (0.55 + 0.9 * stone);
    near = mix(near, timber, band * step(fract(along / 0.65), 0.38));
    float aa = fwidth(x) + 0.01;
    rail = 1.0 - smoothstep(0.035, 0.035 + aa, abs(x - 0.7175));
    near = mix(near, steel, rail);
    col = mix(col, near, detail);
  }
  float alpha = 1.0 - smoothstep(halfWidth - 0.25, halfWidth + 0.3 + rag, x);
  // Level crossing (clip distance at either end): only the rails, set into the road (sub-pixel far away: none).
  if (vEnds.x < vEnds.z || vEnds.y < vEnds.w) alpha = rail * detail;
#elif defined(ASPHALT)
  vec3 col = texture2D(tAsphalt, vWorldPos.xz / 7.0).rgb;
  // Town streets: curb and paved sidewalk beyond the carriageway, painted flat on the same (wider) ribbon.
  // Town junction / dead-end plates (vWalk.x 2 / 3): carriageway where a meeting road runs, curb + paving between.
  float plate = step(1.5, vWalk.x);
  float town = step(0.5, vWalk.x) * (1.0 - plate);
  float walkOn = town * step(vWalk.y, vEnds.x) * step(vWalk.z, vEnds.y);
  float plateRoad = 0.0;
  float curbDist = 1e3;
  if (plate > 0.5) {
    vec2 p = vRoad.xy;
    if (vWalk.x > 2.5) {
      plateRoad = step(length(p), vJuncW.x);
      curbDist = length(p) - vJuncW.x;
    } else {
      for (int i = 0; i < 4; i++) {
        if (vJunc[i] > 50.0) continue;
        // Each road's strip, plus a disc of its half width round the node: where two roads meet at a bend the outer
        // corner is rounded carriageway, not a V of paving between two square strip ends.
        curbDist = min(curbDist, length(p) - vJuncW[i]);
        vec2 d = vec2(cos(vJunc[i]), sin(vJunc[i]));
        if (dot(p, d) < 0.0) continue;
        float across = abs(d.x * p.y - d.y * p.x);
        curbDist = min(curbDist, across - vJuncW[i]);
      }
      plateRoad = step(curbDist, 0.0);
    }
  }
#ifndef PAVEMENT
  // Gravel shoulder outside the paint (country roads only).
  float shoulder = smoothstep(halfWidth - 0.55, halfWidth - 0.35, x) * (1.0 - town) * (1.0 - plate);
  col = mix(col, texture2D(tDirt, vWorldPos.xz / 5.0).rgb * 1.2, shoulder);
  if ((walkOn > 0.0 && x > halfWidth - 0.02) || (plate > 0.5 && plateRoad < 0.5)) {
    float o = plate > 0.5 ? curbDist : x - halfWidth;
    // 0.5 m paving slabs with dark joints, a little texture variation (near only; far: the average slab).
    // Every sidewalk of a town is connected: one colour per town (the nearest town centre).
    float town_key = 1.0;
    if (townCount > 1.5 && distance(vWorldPos.xz, townPos.zw) < distance(vWorldPos.xz, townPos.xy)) town_key = 2.0;
    vec3 pave = vec3(0.66, 0.64, 0.6) * pavingTint(town_key);
    vec3 paving = pave * PAVING_AVG;
    if (detail > 0.0) {
      vec2 slab = (plate > 0.5 ? vWorldPos.xz : vec2(along, o)) / 0.5;
      vec2 j = abs(fract(slab) - 0.5);
      float joint = smoothstep(0.43, 0.48, max(j.x, j.y));
      vec3 near = pave * (0.85 + 0.25 * texture2D(tDirt, vWorldPos.xz / 3.0).r) * (1.0 - joint * 0.25);
      paving = mix(paving, near, detail);
    }
    vec3 curb = vec3(0.78, 0.77, 0.74);
    col = o < CURB_GAP ? curb : paving;
  }
#endif
  // Paint fades out with camera distance and isn't computed at all beyond MARK_FADE_END (sub-pixel there).
  float markFade = 1.0 - smoothstep(MARK_FADE_START, MARK_FADE_END, distance(fogOrigin, vWorldPos));
  if (markFade > 0.0 && vRoad.z > 0.999) {
    // Solid edge lines and a dashed centre line (DASH_PERIOD m per dash + gap, half of it painted).
    float edgeLine = 1.0 - smoothstep(0.05, 0.09, abs(x - (halfWidth - 0.8)));
    float dash = step(fract(along / DASH_PERIOD), 0.5) * (1.0 - smoothstep(0.07, 0.11, x));
    // Markings only on plain road (never on junction caps), clipped where roads meet.
    float paint = step(vEnds.z, vEnds.x) * step(vEnds.w, vEnds.y);
    // Only whole dashes where markings are clipped (no stubs at a junction).
    float phase = mod(along, DASH_PERIOD);
    if (vEnds.z > 0.0) dash *= step(vEnds.z, vEnds.x - phase);
    if (vEnds.w > 0.0) dash *= step(vEnds.w, vEnds.y - (DASH_PERIOD * 0.5 - phase));
    vec2 gap = vRoad.x > 0.0 ? vGaps.xz : vGaps.yw;
    edgeLine *= step(gap.x, vEnds.x) * step(gap.y, vEnds.y);
    float mark = max(edgeLine, dash) * paint;
    // Town intersections: zebra crosswalk across the road, then a stop line on the arriving half.
    // Traffic arriving at the start node drives on the -x half, at the end node on the +x half.
    float inside = 1.0 - smoothstep(halfWidth - 0.75, halfWidth - 0.6, x);
    float stripes = smoothstep(0.22, 0.27, abs(fract(vRoad.x / 1.1) - 0.5)); // half of every 1.1 m painted
    for (int end = 0; end < 2; end++) {
      float start = end == 0 ? vCross.x : vCross.y;
      if (start <= 0.0) continue;
      float d = (end == 0 ? vEnds.x : vEnds.y) - start;
      float arriving = end == 0 ? step(vRoad.x, 0.0) : step(0.0, vRoad.x);
      mark = max(mark, step(0.0, d) * step(d, CROSSWALK) * stripes * inside);
      mark = max(mark, step(STOP_LINE_START, d) * step(d, STOP_LINE_END) * arriving * inside);
    }
    col = mix(col, vec3(0.82, 0.8, 0.72), mark * 0.85 * markFade);
  }
#ifdef PAVEMENT
  float alpha = (1.0 - smoothstep(halfWidth - 0.6, halfWidth - 0.5, x)) * (1.0 - plate);
  // Where a side road lies inside the through road's pavement, leave the through road showing.
  alpha *= step(vSkip.x, vEnds.x) * step(vSkip.y, vEnds.y);
#else
  float alpha = 1.0 - smoothstep(halfWidth - 0.1, halfWidth + 0.35 + rag, x);
  // Town streets have clean edges: the carriageway alone where the sidewalk gives way to a junction plate.
  if (town > 0.5) alpha = 1.0 - smoothstep(halfWidth - 0.04, halfWidth + 0.04, x);
  alpha = max(alpha, walkOn * (1.0 - smoothstep(halfWidth + SIDEWALK_OUTER - 0.04, halfWidth + SIDEWALK_OUTER + 0.04, x)));
  alpha = mix(alpha, 1.0, plate);
#endif
#else
  vec3 col = texture2D(tDirt, vWorldPos.xz / 6.0).rgb * vec3(1.12, 1.04, 0.94);
  // Two wheel ruts, with grass trying to grow back between them.
  float rut = 1.0 - smoothstep(0.0, 0.35, abs(x - halfWidth * 0.45));
  col *= 1.0 - rut * 0.25;
  float crown = (1.0 - smoothstep(0.05, 0.4, x)) * 0.35;
  col = mix(col, texture2D(tGrass, vWorldPos.xz / 8.0).rgb, crown);
  float alpha = 1.0 - smoothstep(halfWidth * 0.65, halfWidth + 0.5, x + rag * 2.0);
#endif

  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = col * (ambient + sunColor * ndl);

  gl_FragColor = vec4(applyFog(lit, vWorldPos), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
