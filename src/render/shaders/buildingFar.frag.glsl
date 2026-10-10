uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 skyAmbient;
uniform vec3 groundAmbient;
uniform float lampLevel;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vColor;
varying vec4 vFacade;
flat varying vec4 vGrid;
flat varying float vSeed;
flat varying vec4 vCols;
flat varying vec4 vDoor;
flat varying vec3 vGlass;

// Camera distances (m) over which the far windows shrink to ~40% of their area (more wall between them) and dim.
#define FAR_SHRINK_START 90.0
#define FAR_SHRINK_END 420.0
// The halo spilling over the wall fades out sooner than the shrink: it would fill the gaps between neighbouring panes.
#define FAR_HALO_START 40.0
#define FAR_HALO_END 160.0

uniform float time; // seconds on the shared render clock

#include ./chunks/fog.glsl;
#include ./chunks/windows.glsl;
#include ./chunks/twinkle.glsl;

void main() {
  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, sunDir), 0.0);
  vec3 ambient = mix(groundAmbient, skyAmbient, n.y * 0.5 + 0.5);
  vec3 col = vColor;

  float win = 0.0;
  float glow = 0.0;
  vec3 warm = vec3(1.0, 0.68, 0.34);
  if (vFacade.z > 0.0 && vCols.y > 0.0) {
    // The near level's grid: columns at start + i * spacing, rows per floor, sill .. sill + height.
    float fh = vFacade.z, spacing = vFacade.w;
    float colI = clamp(floor((vFacade.x - vCols.x) / spacing + 0.5), 0.0, vCols.y - 1.0);
    float centre = vCols.x + colI * spacing;
    float floorI = floor(vFacade.y / fh);
    float fy = vFacade.y - floorI * fh;
    // From afar the windows shrink (more wall between them), or the lit panes of a big block merge into one bright slab.
    float farK = smoothstep(FAR_SHRINK_START, FAR_SHRINK_END, distance(cameraPosition, vWorldPos));
    float haloK = smoothstep(FAR_HALO_START, FAR_HALO_END, distance(cameraPosition, vWorldPos));
    float inset = farK * 0.3 * min(vGrid.z, vGrid.y);
    vec2 d = vec2(max(abs(vFacade.x - centre) - vGrid.z * 0.5 + inset, 0.0), max(max(vGrid.x + inset - fy, fy - vGrid.x - vGrid.y + inset), 0.0));
    float dist = length(d);
    float exists = step(0.0, vFacade.y) * step(floorI, vCols.w - 1.0);
    // Ground-floor windows give way to doors on the front wall (same rule as doorBlocks in geometry.ts).
    if (floorI < 0.5 && vDoor.x > 0.0 && vGrid.x < vDoor.z) {
      for (int i = 0; i < 8; i++) {
        if (float(i) >= vDoor.x) break;
        float du = (float(i) + 0.5) / vDoor.x * vDoor.w;
        if (abs(du - centre) < (vDoor.y + vGrid.z) * 0.5 + 0.2) exists = 0.0;
      }
    }
    float aa = min(max(fwidth(vFacade.x), fwidth(vFacade.y)), 0.15); // capped: a wide blur would melt neighbouring windows together
    win = (1.0 - smoothstep(0.0, aa + 0.05, dist)) * exists;
    vec3 key = vec3(colI, floorI, vCols.z);
    float isLit = windowLit(key, vSeed, vGrid.w) * exists;
    warm = windowColor(key, vSeed) * 1.15;
    // Lit window plus a soft halo spilling over the wall around it.
    glow = isLit * (win + 0.35 * (1.0 - haloK) * exp(-dist * 1.8) * (1.0 - win));
    glow *= 1.0 - 0.3 * farK; // dimmer from afar too
    // Each lit window twinkles on its own, from afar only (see twinkleFar).
    glow *= twinkleFar(key + vec3(0.0, 0.0, vSeed * 97.0), time, distance(cameraPosition, vWorldPos));
  }
  col = mix(col, vGlass, win);
  vec3 lit = col * (ambient + sunColor * ndl);
  lit = mix(lit, warm, clamp(glow, 0.0, 1.0) * lampLevel);

  gl_FragColor = vec4(applyFog(lit, vWorldPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
