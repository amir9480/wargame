uniform sampler2D tDirt;
uniform sampler2D tAsphalt;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUV;
varying float vKind;
varying vec4 vLot;

#include ./chunks/fog.glsl;
#include ./chunks/lod.glsl;

void main() {
  vec3 col;
  float paint = 0.0;
  float detail = surfaceDetail(vWorldPos);
  if (vKind < 1.5) {
    // Paving slabs, as on the sidewalks (road.frag.glsl); far: the average slab.
    col = vec3(0.66, 0.64, 0.6) * PAVING_AVG;
    if (detail > 0.0) {
      vec2 j = abs(fract(vWorldPos.xz / 0.5) - 0.5);
      float joint = smoothstep(0.43, 0.48, max(j.x, j.y));
      col = mix(col, vec3(0.66, 0.64, 0.6) * (0.85 + 0.25 * texture2D(tDirt, vWorldPos.xz / 3.0).r) * (1.0 - joint * 0.25), detail);
    }
  } else {
    col = texture2D(tAsphalt, vWorldPos.xz / 7.0).rgb;
    if (vKind > 2.5) {
      // Car park: two rows of bays along X, entrance (bays gate, gate + 1) in the front row; the driveway beyond the
      // front edge only in front of the entrance. Its markings are near detail.
      float w = vLot.x, d = vLot.y, bays = vLot.z, gate = vLot.w;
      float x0 = -w * 0.5 + 0.5;
      float gateA = x0 + gate * 2.6, gateB = gateA + 5.2;
      if (vUV.y > d * 0.5 && (vUV.x < gateA || vUV.x > gateB)) discard;
      if (detail > 0.0) {
        float u = (vUV.x - x0) / 2.6;
        float k = floor(u + 0.5);
        float line = step(abs(vUV.x - (x0 + k * 2.6)), 0.06) * step(0.0, k) * step(k, bays);
        float back = step(-d * 0.5 + 0.4, vUV.y) * step(vUV.y, -d * 0.5 + 5.7);
        float front = step(d * 0.5 - 5.7, vUV.y) * step(vUV.y, d * 0.5 - 0.4) * (1.0 - step(gate + 0.5, k) * step(k, gate + 1.5));
        paint = line * max(back, front);
        // Kerb line round the lot, open at the entrance.
        float edge = min(min(vUV.x + w * 0.5, w * 0.5 - vUV.x), min(vUV.y + d * 0.5, d * 0.5 - vUV.y));
        float gap = step(gateA, vUV.x) * step(vUV.x, gateB) * step(0.0, vUV.y);
        paint = max(paint, step(0.0, edge) * step(edge, 0.22) * (1.0 - gap) * 0.7);
      }
    }
  }
  col = mix(col, vec3(0.82, 0.8, 0.72), paint * 0.85 * detail);

  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 lit = col * (ambient + sunColor * ndl);
  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
