// Debug views of the render pipeline, picked in the panel (Engine.debugView). Not persisted; `final` is the normal image.

export const DEBUG_VIEWS = [
  { id: 'final', label: 'Final image', post: false },
  { id: 'overlay', label: 'Triangles overlay', post: false },
  { id: 'wire', label: 'Triangles only', post: false },
  { id: 'lod', label: 'LOD levels (colour per level)', post: false },
  { id: 'shadows', label: 'Sun + contact shadows', post: true },
  { id: 'ao', label: 'Ambient occlusion', post: true },
  { id: 'lights', label: 'Local lights', post: true },
  { id: 'depth', label: 'Depth', post: true },
  { id: 'normals', label: 'Normals (from depth)', post: true },
] as const;

export type DebugView = (typeof DEBUG_VIEWS)[number]['id'];

export function isDebugView(v: unknown): v is DebugView {
  return DEBUG_VIEWS.some((d) => d.id === v);
}

/** Value of the post shader's `debugView` uniform (post.frag.glsl): 0 = normal; keep in sync with the shader. */
export const DEBUG_SHADER_ID: Record<DebugView, number> = { final: 0, shadows: 1, ao: 2, lights: 3, depth: 4, normals: 5, wire: 6, overlay: 7, lod: 0 };
