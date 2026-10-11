import Alpine from 'alpinejs';
import './style.css';
import { Engine, type LoadProgress, type MapInfo } from './engine.ts';
import { normalizeSeed, MAX_SEED } from './core/rng.ts';
import { DEFAULT_HOUR } from './render/timeOfDay.ts';
import { DEFAULT_QUALITY, QUALITY_SETTINGS, isQuality, type Quality, type QualitySettings } from './render/quality.ts';
import { DEBUG_VIEWS, isDebugView, type DebugView } from './render/debugView.ts';
import type { CameraView } from './render/rtsCamera.ts';
import { profiler } from './core/profiler.ts';

const DEFAULT_SEED = 42;
const STORAGE_KEY = 'wargame.settings';

/** Settings kept between visits: the map seed, time of day, graphics quality and camera view. */
interface Saved {
  seed: number;
  /** Time of day, hours 0-24. */
  hour: number;
  quality: Quality;
  camera: CameraView | null;
  /** Control panel folded to its title bar. */
  collapsed: boolean;
}

function isCameraView(v: unknown): v is CameraView {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return ['x', 'z', 'yaw', 'pitch', 'distance'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

/** localStorage can be missing, full or blocked: every access is guarded and falls back to the defaults. */
function loadSaved(): Saved {
  const saved: Saved = { seed: DEFAULT_SEED, hour: DEFAULT_HOUR, quality: DEFAULT_QUALITY, camera: null, collapsed: false };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (typeof raw.seed === 'number' && Number.isFinite(raw.seed)) saved.seed = normalizeSeed(raw.seed);
    if (typeof raw.hour === 'number' && raw.hour >= 0 && raw.hour <= 24) saved.hour = raw.hour;
    if (isQuality(raw.quality)) saved.quality = raw.quality;
    if (isCameraView(raw.camera)) saved.camera = raw.camera;
    if (typeof raw.collapsed === 'boolean') saved.collapsed = raw.collapsed;
  } catch {
    // keep the defaults
  }
  return saved;
}

function save(patch: Partial<Saved>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadSaved(), ...patch }));
  } catch {
    // not persisted; the page still works
  }
}

const saved = loadSaved();

/** F11 / Alt+Enter toggle fullscreen (in the Tauri app WebView2 turns the element's fullscreen into the window's). */
window.addEventListener('keydown', (e) => {
  const key = e.key === 'F11' || (e.key === 'Enter' && e.altKey);
  if (!key || e.repeat) return;
  e.preventDefault();
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void document.documentElement.requestFullscreen().catch(() => {});
});

let engine: Engine | null = null;
let engineError = '';
try {
  engine = new Engine(document.getElementById('viewport')!, saved.quality);
  engine.timeOfDay = saved.hour;
  if (saved.camera) engine.cameraView = saved.camera;
  // The camera moves every frame: save it when the page is hidden or unloaded (refresh, tab switch, close).
  const saveCamera = () => save({ camera: engine!.cameraView });
  window.addEventListener('pagehide', saveCamera);
  // Dev only: `__quality({ msaa: 2, aoSamples: 0 })` overrides fields of the current preset, to find what a preset costs.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__quality = (o: Partial<QualitySettings>) => {
      Object.assign(QUALITY_SETTINGS[engine!.quality], o);
      engine!.quality = engine!.quality;
      return QUALITY_SETTINGS[engine!.quality];
    };
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveCamera();
  });
} catch (err) {
  engineError = err instanceof Error ? err.message : String(err);
  console.error(err);
}

Alpine.data('mapPanel', () => ({
  seed: saved.seed as number | string,
  info: null as MapInfo | null,
  busy: false,
  /** Map loading state while a map streams in. */
  progress: null as LoadProgress | null,
  fps: 0,
  /** Dynamic resolution share of the preset's pixel ratio (1 = full). */
  resScale: 1,
  drawn: 0,
  chunks: 0,
  drawCalls: 0,
  triangles: 0,
  maxSeed: MAX_SEED,
  quality: saved.quality as Quality,
  /** Debug view of the render pipeline (not persisted). */
  debugView: 'final' as DebugView,
  debugViews: DEBUG_VIEWS,
  hour: saved.hour as number | string,
  error: engineError,
  collapsed: saved.collapsed,
  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    save({ collapsed: this.collapsed });
  },
  /** Buildings destroyed on the current map (destruction test buttons). */
  destroyed: 0,
  /** Debug snapshot shown in the panel (refreshed with the stats). */
  debug: '',
  copied: false,
  /** Debug: camera frustum frozen (see Engine.cameraFrozen). */
  frozen: false,
  /** Profiler recording (core/profiler.ts): seconds so far, and the report text after stopping. */
  profiling: false,
  /** Detail mode: per-layer / per-pass timings (see Profiler.setDetailed). */
  profileDetail: true,
  profileSecs: 0,
  report: '',
  reportCopied: false,

  init() {
    if (!engine) return;
    engine.onStats = ({ fps, drawn, total, scale, calls, triangles }) => {
      this.drawCalls = calls;
      this.triangles = triangles;
      this.fps = fps;
      this.resScale = scale;
      this.drawn = drawn;
      this.chunks = total;
      this.debug = this.debugText();
      if (profiler.isRecording) this.profileSecs = profiler.elapsed;
    };
    engine.onProgress = (progress) => {
      this.progress = progress;
    };
    this.generate();
  },

  async generate() {
    if (this.busy || !engine) return;
    this.busy = true;
    const seed = normalizeSeed(this.seed);
    this.seed = seed;
    try {
      this.info = await engine.generate(seed);
      this.destroyed = 0;
      save({ seed });
    } finally {
      this.busy = false;
    }
  },

  setHour(value: string) {
    this.hour = value;
    if (engine) engine.timeOfDay = Number(value);
    save({ hour: Number(value) });
  },

  get hourLabel(): string {
    const h = Number(this.hour);
    const total = Math.round(h * 60) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  },

  setQuality() {
    if (!isQuality(this.quality)) return;
    if (engine) engine.quality = this.quality;
    save({ quality: this.quality });
    // Views built from the post pass don't exist on low quality.
    if (this.quality === 'low' && DEBUG_VIEWS.some((v) => v.id === this.debugView && v.post)) {
      this.debugView = 'final';
      this.setDebugView();
    }
  },

  setDebugView() {
    if (!isDebugView(this.debugView)) return;
    if (engine) engine.debugView = this.debugView;
  },

  /** Destruction test: knocks down a random tenth of the standing buildings (gameplay will do this per hit). */
  destroySome() {
    const state = engine?.buildingState;
    if (!state) return;
    const standing = Array.from({ length: state.count }, (_, i) => i).filter((i) => !state.isDestroyed(i));
    for (let n = Math.ceil(standing.length / 10); n > 0 && standing.length; n--)
      state.setDestroyed(standing.splice(Math.floor(Math.random() * standing.length), 1)[0]);
    this.destroyed = state.destroyedCount;
  },

  /** Starts / stops the profiler recording; stopping fills the report box. */
  toggleProfile() {
    if (!this.profiling) {
      this.report = '';
      this.profileSecs = 0;
      profiler.setDetailed(this.profileDetail);
      profiler.start();
      this.profiling = true;
    } else {
      this.report = profiler.stop();
      this.profiling = false;
    }
  },

  async copyReport() {
    try {
      await navigator.clipboard.writeText(this.report);
    } catch {
      const box = document.getElementById('profiler-text') as HTMLTextAreaElement | null;
      box?.select();
      document.execCommand('copy');
    }
    this.reportCopied = true;
    setTimeout(() => (this.reportCopied = false), 1200);
  },

  toggleFreeze() {
    if (!engine) return;
    engine.cameraFrozen = !engine.cameraFrozen;
    this.frozen = engine.cameraFrozen;
  },

  repairAll() {
    engine?.buildingState?.reset();
    this.destroyed = 0;
  },

  /** One-block state summary to paste into a bug report. */
  debugText(): string {
    if (!engine) return '';
    const v = engine.cameraView;
    const f = (n: number, d = 1) => n.toFixed(d);
    const i = this.info;
    return [
      `seed=${i?.seed ?? this.seed} quality=${this.quality} hour=${f(Number(this.hour), 2)}`,
      `camera focus x=${f(v.x)} z=${f(v.z)} yaw=${f(v.yaw, 3)} pitch=${f(v.pitch, 3)} distance=${f(v.distance)}`,
      i
        ? `map sea=${i.seaSides} mountains=${i.mountainSides} rivers=${i.riverCount} towns=${i.cityCount} buildings=${i.buildingCount} destroyed=${this.destroyed} rail=${i.railKm}km`
        : 'map not loaded',
      `fps=${this.fps} drawn=${this.drawn}/${this.chunks} viewport=${innerWidth}x${innerHeight}@${devicePixelRatio}` +
        (this.resScale < 1 ? ` resolution=${Math.round(this.resScale * 100)}%` : ''),
    ].join('\n');
  },

  async copyDebug() {
    this.debug = this.debugText();
    try {
      await navigator.clipboard.writeText(this.debug);
    } catch {
      const box = document.getElementById('debug-text') as HTMLTextAreaElement | null;
      box?.select();
      document.execCommand('copy');
    }
    this.copied = true;
    setTimeout(() => (this.copied = false), 1200);
  },

  randomSeed() {
    this.seed = Math.floor(Math.random() * MAX_SEED);
    this.generate();
  },

  get seaLabel(): string {
    const sides = this.info?.seaSides ?? [];
    return sides.length ? sides.join(', ') : 'none (landlocked)';
  },

  get mountainLabel(): string {
    const sides = this.info?.mountainSides ?? [];
    return sides.length ? sides.join(', ') : 'none';
  },
}));

Alpine.start();
