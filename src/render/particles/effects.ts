// Particle effect definitions: the look and motion of one kind of emitter (smoke, steam...). Pure data; the
// `ParticleSystem` turns each effect into two shader materials (near / far level of detail). To add an effect: add an entry
// to `EFFECTS`, then emit it from `sources.ts` (see skill `particles`).

export interface ParticleEffect {
  /** Particles alive per emitter in the near level of detail (evenly spread over the effect's life). */
  count: number;
  /** Particles per emitter in the far level (fewer, bigger puffs: `farSize` times the radius). */
  farCount: number;
  farSize: number;
  /** Seconds a particle lives (age 0 at the emitter, 1 = gone). */
  life: number;
  /** Initial rise speed (m/s) and how much it slows by the end of life (0 = constant speed, 1 = stops at the end). */
  rise: number;
  riseDecay: number;
  /** Horizontal turbulence radius at the end of life (m, times the emitter's scale). */
  spread: number;
  /** Share of the wind speed the plume bends with (0 = straight up, 1 = fully carried). */
  windDrift: number;
  /** Puff radius (m, times the emitter's scale) at birth and at the end of life. */
  sizeStart: number;
  sizeEnd: number;
  /** Peak opacity, and the share of life a puff takes to fade in (hides the pop at the emitter). */
  opacity: number;
  fadeIn: number;
  /** Colour (0xRRGGBB, sRGB) at birth and at the end of life. */
  colorStart: number;
  colorEnd: number;
  /** Turn speed of the puff's pattern (rad per life). */
  spin: number;
  /** Camera distance (m) where the near level gives way to the far one, and where the far one has faded out entirely. */
  nearDistance: number;
  farDistance: number;
}

export type EffectId = 'stackSmoke' | 'steam' | 'factorySmoke' | 'chimney';

export const EFFECTS: Record<EffectId, ParticleEffect> = {
  /** Power plant chimney: a big, dark, slowly widening plume. */
  stackSmoke: {
    count: 26, farCount: 9, farSize: 1.7,
    life: 16, rise: 6, riseDecay: 0.5, spread: 6, windDrift: 1,
    sizeStart: 2.5, sizeEnd: 11, opacity: 0.55, fadeIn: 0.08,
    colorStart: 0x4b4d50, colorEnd: 0x90949a, spin: 1.2,
    nearDistance: 700, farDistance: 2300,
  },
  /** Cooling tower: pale, billowing water vapour. */
  steam: {
    count: 24, farCount: 8, farSize: 1.7,
    life: 14, rise: 5, riseDecay: 0.4, spread: 4, windDrift: 0.9,
    sizeStart: 5, sizeEnd: 20, opacity: 0.6, fadeIn: 0.1,
    colorStart: 0xf4f6f8, colorEnd: 0xdde3e9, spin: 0.8,
    nearDistance: 700, farDistance: 2300,
  },
  /** Factory smoke stack: a thinner grey plume. */
  factorySmoke: {
    count: 18, farCount: 7, farSize: 1.6,
    life: 10, rise: 3.5, riseDecay: 0.4, spread: 2.5, windDrift: 1,
    sizeStart: 0.9, sizeEnd: 5, opacity: 0.5, fadeIn: 0.1,
    colorStart: 0x3e3f42, colorEnd: 0x7d8186, spin: 1.5,
    nearDistance: 350, farDistance: 1200,
  },
  /** House chimney: a faint wisp. */
  chimney: {
    count: 12, farCount: 4, farSize: 1.5,
    life: 8, rise: 1.6, riseDecay: 0.5, spread: 1.2, windDrift: 1,
    sizeStart: 0.35, sizeEnd: 2.2, opacity: 0.35, fadeIn: 0.15,
    colorStart: 0x8a8a8c, colorEnd: 0xb4b7ba, spin: 1.5,
    nearDistance: 140, farDistance: 340,
  },
};

/** One place that emits an effect. Positions are world coordinates (the emitter's mouth: a stack top, a chimney pot...). */
export interface ParticleEmitter {
  effect: EffectId;
  x: number;
  y: number;
  z: number;
  /** Seeds the emitter's phase and randomness (any integer; use the owner's seed). */
  seed: number;
  /** Size multiplier of puffs and spread (default 1). */
  scale?: number;
  /** 0-1: share of the particles that are emitted (default 1). Can be changed later with `ParticleSystem.setIntensity`. */
  intensity?: number;
}
