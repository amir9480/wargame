// Atmosphere model (Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique"): Rayleigh,
// Mie and ozone layers over a spherical planet. Units are km, the planet centre is the origin and +Y is up at the
// observer. The parameters come in as defines from atmosphere.ts (`atmosphereDefines`), so TS and GLSL share them.
// Used by the LUT bakes (atmosphere.frag.glsl) and the sky dome (sky.frag.glsl).

const float PI = 3.14159265359;

/** Nearest non-negative hit of a ray with the origin-centred sphere of radius `R`; -1 if none. */
float raySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  if (-b - s >= 0.0) return -b - s;
  if (-b + s >= 0.0) return -b + s;
  return -1.0;
}

/** Scattering / extinction coefficients (per km) at altitude `h` km. */
void medium(float h, out vec3 rayS, out float mieS, out vec3 ext) {
  h = max(h, 0.0);
  float dr = exp(-h / RAY_H);
  float dm = exp(-h / MIE_H);
  float dozone = max(0.0, 1.0 - abs(h - OZONE_CENTER) / OZONE_WIDTH);
  rayS = RAY_S * dr;
  mieS = MIE_S * dm;
  ext = rayS + vec3(mieS + MIE_A * dm) + OZONE_A * dozone;
}

float rayleighPhase(float c) {
  return 3.0 / (16.0 * PI) * (1.0 + c * c);
}

// Cornette-Shanks; `g` = forward peak (MIE_G for the sky).
float miePhase(float c, float g) {
  float k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5);
}

/** Soft planet shadow: 0 when the direction `mu` (cosine from the zenith at radius `r`) points below the horizon. */
float planetShadow(float r, float mu) {
  float q = GROUND_R / r;
  float muH = -sqrt(max(1.0 - q * q, 0.0));
  return smoothstep(muH - 0.01, muH + 0.01, mu);
}

// ---- transmittance LUT (TRANS_W x TRANS_H): transmittance from radius r towards mu up to the top of the atmosphere ----
// Bruneton's mapping (more resolution near the horizon). Texel centres hit x / y = 0 and 1 exactly.

const float ATMO_H = sqrt(TOP_R * TOP_R - GROUND_R * GROUND_R);

vec2 transmittanceUv(float r, float mu) {
  float rho = sqrt(max(r * r - GROUND_R * GROUND_R, 0.0));
  float disc = r * r * (mu * mu - 1.0) + TOP_R * TOP_R;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = TOP_R - r, dMax = rho + ATMO_H;
  vec2 x = clamp(vec2((d - dMin) / (dMax - dMin), rho / ATMO_H), 0.0, 1.0);
  vec2 size = vec2(TRANS_W, TRANS_H);
  return (0.5 + x * (size - 1.0)) / size;
}

/** (r, mu) of a transmittance LUT coordinate in 0..1 (texel centres at 0 and 1). */
void transmittanceRMu(vec2 x, out float r, out float mu) {
  float rho = ATMO_H * x.y;
  r = sqrt(rho * rho + GROUND_R * GROUND_R);
  float dMin = TOP_R - r, dMax = rho + ATMO_H;
  float d = dMin + x.x * (dMax - dMin);
  mu = d <= 0.0 ? 1.0 : clamp((ATMO_H * ATMO_H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
}

vec3 transmittance(sampler2D lut, float r, float mu) {
  return texture(lut, transmittanceUv(r, mu)).rgb;
}

// ---- multiple-scattering LUT (MS_SIZE^2): x = sun cosine from the zenith, y = altitude ----

vec2 multiScatterUv(float r, float mu) {
  vec2 x = clamp(vec2(mu * 0.5 + 0.5, (r - GROUND_R) / (TOP_R - GROUND_R)), 0.0, 1.0);
  return (0.5 + x * (MS_SIZE - 1.0)) / MS_SIZE;
}
