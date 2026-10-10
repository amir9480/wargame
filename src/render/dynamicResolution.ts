// Dynamic resolution: keeps the frame rate near 60 fps on GPUs that are limited by pixel work (the scene and post passes
// scale with the number of pixels) by lowering the render resolution in small steps, and raising it again when there is
// headroom. Pure logic: the engine feeds frame times and applies the returned scale to the renderer's pixel ratio.
//
// Only reacts when the GPU is the limit: if the JS main thread takes most of the frame, fewer pixels would not help.

/** Frames slower than this (ms, smoothed) start lowering the resolution. */
const SLOW_MS = 18.5;
/** Much slower: step by 10% instead of 5%. */
const VERY_SLOW_MS = 24;
/** Share of the frame the main thread may use for the GPU to count as the limit. */
const CPU_BOUND_SHARE = 0.75;
const STEP = 0.05;
/** Smoothing of the frame times (per frame). */
const EMA = 0.05;
/** Frames to skip after a resolution change (the targets were just re-created) or at start. */
const SETTLE_FRAMES = 45;
/** Seconds to wait before trying a higher resolution after lowering it; doubles when the higher one fails again. */
const RETRY_FIRST_S = 8;
const RETRY_MAX_S = 64;

export class DynamicResolution {
  /** Share of the preset's pixel ratio currently rendered (1 = full). */
  scale = 1;
  private wall = 0;
  private cpu = 0;
  private settle = SETTLE_FRAMES;
  private retryAt = 0;
  private retryDelay = RETRY_FIRST_S;
  private lastUp = -1;

  reset(): void {
    this.scale = 1;
    this.wall = this.cpu = 0;
    this.settle = SETTLE_FRAMES;
    this.retryAt = 0;
    this.retryDelay = RETRY_FIRST_S;
    this.lastUp = -1;
  }

  /**
   * Call once per frame with the frame's wall time and main-thread time (ms), the clock (s) and the preset's lowest scale
   * (0 = disabled). Returns the new scale when it changed, else null.
   */
  update(wallMs: number, cpuMs: number, now: number, min: number): number | null {
    if (min <= 0 || min >= 1) {
      if (this.scale === 1) return null;
      this.reset();
      return 1;
    }
    // Skip stalls (tab switches, map builds, shader compiles): they say nothing about the steady frame cost.
    if (wallMs > 100) {
      this.settle = Math.max(this.settle, 10);
      return null;
    }
    if (this.settle > 0) {
      this.settle--;
      this.wall = wallMs;
      this.cpu = cpuMs;
      return null;
    }
    this.wall += (wallMs - this.wall) * EMA;
    this.cpu += (cpuMs - this.cpu) * EMA;

    if (this.wall > SLOW_MS && this.cpu < CPU_BOUND_SHARE * this.wall && this.scale > min) {
      // A raise that failed straight away: wait longer before the next attempt.
      if (this.lastUp >= 0 && now - this.lastUp < 6) this.retryDelay = Math.min(RETRY_MAX_S, this.retryDelay * 2);
      this.lastUp = -1;
      this.retryAt = now + this.retryDelay;
      return this.change(Math.max(min, this.scale - (this.wall > VERY_SLOW_MS ? 2 * STEP : STEP)));
    }
    // Wall time is capped by vsync, so headroom can't be measured: try a step up now and then; a failed try is undone above.
    if (this.scale < 1 && this.wall < SLOW_MS - 1.5 && now >= this.retryAt) {
      this.lastUp = now;
      this.retryAt = now + this.retryDelay;
      return this.change(Math.min(1, this.scale + STEP));
    }
    return null;
  }

  private change(scale: number): number {
    this.scale = Math.round(scale * 100) / 100;
    this.settle = SETTLE_FRAMES;
    return this.scale;
  }
}
