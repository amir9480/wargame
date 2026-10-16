// Jolt physics bootstrap (JoltPhysics.js, single-thread wasm-compat build: WASM embedded, same in Worker and Node).
// Only the authoritative sim owns a PhysicsWorld; replicas never run physics.
import initJolt from 'jolt-physics/wasm-compat';

export type JoltModule = Awaited<ReturnType<typeof initJolt>>;

let modulePromise: Promise<JoltModule> | null = null;

export function loadJolt(): Promise<JoltModule> {
  modulePromise ??= initJolt();
  return modulePromise;
}

// Object layers: static geometry, kinematic/dynamic movers, sensors-only queries.
export const LAYER_STATIC = 0;
export const LAYER_MOVING = 1;
const LAYER_COUNT = 2;
const BP_STATIC = 0;
const BP_MOVING = 1;

export class PhysicsWorld {
  readonly jolt: JoltModule;
  readonly iface: InstanceType<JoltModule['JoltInterface']>;
  readonly system: InstanceType<JoltModule['PhysicsSystem']>;
  readonly bodies: InstanceType<JoltModule['BodyInterface']>;
  private readonly settings: InstanceType<JoltModule['JoltSettings']>;
  private readonly owned: Array<{ id: number }> = [];

  constructor(jolt: JoltModule) {
    this.jolt = jolt;
    const settings = new jolt.JoltSettings();
    const objectFilter = new jolt.ObjectLayerPairFilterTable(LAYER_COUNT);
    objectFilter.EnableCollision(LAYER_STATIC, LAYER_MOVING);
    objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);
    const bpInterface = new jolt.BroadPhaseLayerInterfaceTable(LAYER_COUNT, 2);
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_STATIC, new jolt.BroadPhaseLayer(BP_STATIC));
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, new jolt.BroadPhaseLayer(BP_MOVING));
    settings.mObjectLayerPairFilter = objectFilter;
    settings.mBroadPhaseLayerInterface = bpInterface;
    settings.mObjectVsBroadPhaseLayerFilter = new jolt.ObjectVsBroadPhaseLayerFilterTable(
      settings.mBroadPhaseLayerInterface, 2, settings.mObjectLayerPairFilter, LAYER_COUNT);
    this.settings = settings;
    this.iface = new jolt.JoltInterface(settings);
    this.system = this.iface.GetPhysicsSystem();
    this.bodies = this.system.GetBodyInterface();
  }

  /** Static terrain from a row-major height array (heights[j*N+i], metres). Returns the body id. */
  addHeightField(heights: Float32Array, n: number, cell: number, originX: number, originZ: number): number {
    const J = this.jolt;
    const settings = new J.HeightFieldShapeSettings();
    // Jolt wants sampleCount multiple of blockSize; pad by repeating the last row/column.
    const block = 4;
    const count = Math.ceil(n / block) * block;
    settings.mHeightSamples.resize(count * count);
    const samples = new Float32Array(J.HEAPF32.buffer, J.getPointer(settings.mHeightSamples.data()), count * count);
    for (let j = 0; j < count; j++) {
      const sj = Math.min(j, n - 1);
      for (let i = 0; i < count; i++) samples[j * count + i] = heights[sj * n + Math.min(i, n - 1)];
    }
    settings.mSampleCount = count;
    settings.mBlockSize = block;
    settings.mOffset = new J.Vec3(originX, 0, originZ);
    settings.mScale = new J.Vec3(cell, 1, cell);
    const shape = settings.Create().Get();
    const cs = new J.BodyCreationSettings(shape, new J.RVec3(0, 0, 0), new J.Quat(0, 0, 0, 1),
      J.EMotionType_Static, LAYER_STATIC);
    const body = this.bodies.CreateBody(cs);
    this.bodies.AddBody(body.GetID(), J.EActivation_DontActivate);
    J.destroy(cs);
    J.destroy(settings);
    this.owned.push({ id: body.GetID().GetIndexAndSequenceNumber() });
    return body.GetID().GetIndexAndSequenceNumber();
  }

  step(dt: number, substeps = 1): void {
    this.iface.Step(dt, substeps);
  }

  /** Cast a ray; returns hit distance fraction (0..1 of the ray length) or -1. */
  castRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const J = this.jolt;
    const ray = new J.RRayCast(new J.RVec3(ox, oy, oz), new J.Vec3(dx, dy, dz));
    const rs = new J.RayCastSettings();
    const collector = new J.CastRayClosestHitCollisionCollector();
    const bp = new J.DefaultBroadPhaseLayerFilter(this.iface.GetObjectVsBroadPhaseLayerFilter(), LAYER_MOVING);
    const ol = new J.DefaultObjectLayerFilter(this.iface.GetObjectLayerPairFilter(), LAYER_MOVING);
    const body = new J.BodyFilter();
    const shape = new J.ShapeFilter();
    this.system.GetNarrowPhaseQuery().CastRay(ray, rs, collector, bp, ol, body, shape);
    const f = collector.HadHit() ? collector.mHit.mFraction : -1;
    for (const o of [shape, body, ol, bp, collector, rs, ray]) J.destroy(o);
    return f;
  }

  dispose(): void {
    this.jolt.destroy(this.iface);
    this.jolt.destroy(this.settings);
  }
}
