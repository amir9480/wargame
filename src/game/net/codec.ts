// Compact binary codec for commands / events. Messages are plain objects described by a registered schema, so adding
// a field or a message is one line and the wire format stays versionable.

export type FieldType = 'u8' | 'u16' | 'u32' | 'i16' | 'f32' | 'ids';
export type Fields = ReadonlyArray<readonly [string, FieldType]>;

export class ByteWriter {
  buf = new Uint8Array(256);
  view = new DataView(this.buf.buffer);
  pos = 0;
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): void { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  u16(v: number): void { this.ensure(2); this.view.setUint16(this.pos, v, true); this.pos += 2; }
  i16(v: number): void { this.ensure(2); this.view.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v: number): void { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  f32(v: number): void { this.ensure(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; }
  bytes(): Uint8Array { return this.buf.slice(0, this.pos); }
}

export class ByteReader {
  view: DataView;
  pos = 0;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get done(): boolean { return this.pos >= this.buf.length; }
  u8(): number { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  f32(): number { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
}

function writeField(w: ByteWriter, t: FieldType, v: unknown): void {
  switch (t) {
    case 'u8': w.u8(v as number); break;
    case 'u16': w.u16(v as number); break;
    case 'i16': w.i16(v as number); break;
    case 'u32': w.u32(v as number); break;
    case 'f32': w.f32(v as number); break;
    case 'ids': { const a = v as number[]; w.u16(a.length); for (const id of a) w.u32(id); break; }
  }
}

function readField(r: ByteReader, t: FieldType): number | number[] {
  switch (t) {
    case 'u8': return r.u8();
    case 'u16': return r.u16();
    case 'i16': return r.i16();
    case 'u32': return r.u32();
    case 'f32': return r.f32();
    case 'ids': { const n = r.u16(); const a: number[] = []; for (let i = 0; i < n; i++) a.push(r.u32()); return a; }
  }
}

export interface MessageRegistry<K extends string> {
  /** Register a message kind; ids are explicit and never renumbered (they end up in saves). */
  define(kind: K, id: number, fields: Fields): void;
  encode(w: ByteWriter, msg: { kind: K }): void;
  decode(r: ByteReader): { kind: K };
}

export function createRegistry<K extends string>(): MessageRegistry<K> {
  const byKind = new Map<string, { id: number; fields: Fields }>();
  const byId = new Map<number, { kind: K; fields: Fields }>();
  return {
    define(kind, id, fields) {
      if (byId.has(id) || byKind.has(kind)) throw new Error(`duplicate message ${kind}/${id}`);
      byKind.set(kind, { id, fields });
      byId.set(id, { kind, fields });
    },
    encode(w, msg) {
      const def = byKind.get(msg.kind);
      if (!def) throw new Error(`unknown message ${msg.kind}`);
      w.u8(def.id);
      for (const [name, type] of def.fields) writeField(w, type, (msg as Record<string, unknown>)[name]);
    },
    decode(r) {
      const id = r.u8();
      const def = byId.get(id);
      if (!def) throw new Error(`unknown message id ${id}`);
      const out: Record<string, unknown> = { kind: def.kind };
      for (const [name, type] of def.fields) out[name] = readField(r, type);
      return out as { kind: K };
    },
  };
}
