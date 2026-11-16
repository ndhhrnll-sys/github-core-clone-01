// The git object model, implemented from the format itself: loose objects
// hashed with SHA-1, trees and commits parsed and rebuilt byte-exactly, packs
// written plainly (no deltas) and read fully (deltas applied), and the
// pkt-line framing the smart-HTTP protocol speaks. Standard library only:
// node:crypto for the hashes, node:zlib for the compression.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'commit' | 'tree' | 'tag';

export interface GitObject {
  type: GitObjectType;
  /** The object's raw content (for a commit or tag, its exact stored bytes). */
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of a typed payload. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** SHA-1 of a whole buffer (the pack trailer). */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  /** The raw author line's timestamp, seconds since the epoch (0 when unparseable). */
  authorEpoch: number;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let authorEpoch = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match) authorEpoch = Number(match[1]);
    }
  }
  return { tree, parents, message, authorEpoch };
}

/** Build a commit object byte-exactly from its parts. */
export function buildCommit(parts: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.author}`, `committer ${parts.committer}`, '', parts.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse an annotated tag object: the object it points at and that object's type. */
export function parseTag(data: Buffer): { target: string; targetType: string } {
  const text = data.toString('utf8');
  let target = ZERO_OID;
  let targetType = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) targetType = line.slice(5).trim();
  }
  return { target, targetType };
}

// -------------------------------------------------------------------- trees

export interface TreeEntry {
  /** The mode as git writes it in the tree: '100644', '100755', '40000', ... (no leading zero). */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: by name, with directories compared as if they ended in '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
  const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

/** Serialize tree entries, sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------- pack write

/** The variable-length type-and-size header of one pack object. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  let value = size;
  const bytes: number[] = [(TYPE_CODES[type] << 4) | (value & 0x0f)];
  value >>= 4;
  while (value > 0) {
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! | 0x80;
    bytes.push(value & 0x7f);
    value >>= 7;
  }
  return Buffer.from(bytes);
}

/** Build a complete pack holding the given objects, plainly (never deltaed). */
export function buildPack(objects: Array<{ oid: string; type: GitObjectType; data: Buffer }>): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length), deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// ---------------------------------------------------------------- pack read

/**
 * Inflate the deflate stream starting at `offset`, finding its exact end.
 * zlib's synchronous inflate tolerates trailing bytes and fails on a truncated
 * stream, so the shortest prefix that inflates is the stream's true end: a
 * doubling scan brackets it, a binary search pins it down.
 */
function inflateExact(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const remaining = buffer.length - offset;
  let low = 0; // known too short
  let high = Math.min(remaining, 64);
  const attempt = (length: number): Buffer | null => {
    try {
      return inflateSync(buffer.subarray(offset, offset + length));
    } catch {
      return null;
    }
  };
  let data = attempt(high);
  while (data === null) {
    low = high;
    if (high >= remaining) throw new Error('pack object does not inflate');
    high = Math.min(remaining, high * 2);
    data = attempt(high);
  }
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    const probe = attempt(mid);
    if (probe === null) low = mid;
    else {
      high = mid;
      data = probe;
    }
  }
  return { data: data!, next: offset + high };
}

/** Read a variable-length little-endian size from a delta header. */
function readDeltaSize(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = buffer[cursor]!;
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: cursor };
}

/** Apply a git delta to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaSize(delta, 0);
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const target = readDeltaSize(delta, source.next);
  const out: Buffer[] = [];
  let cursor = target.next;
  let produced = 0;
  while (cursor < delta.length) {
    const opcode = delta[cursor]!;
    cursor += 1;
    if ((opcode & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          offset |= delta[cursor]! << (8 * bit);
          cursor += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          size |= delta[cursor]! << (8 * bit);
          cursor += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode !== 0) {
      out.push(delta.subarray(cursor, cursor + opcode));
      produced += opcode;
      cursor += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== target.value || produced !== target.value) throw new Error('delta target size mismatch');
  return result;
}

export interface PackReadResult {
  objects: GitObject[];
  /** The object ids, in pack order, parallel to `objects`. */
  oids: string[];
}

/**
 * Read a whole pack, resolving OFS_DELTA and REF_DELTA objects against bases
 * from the pack itself or from `external` (the receiving store's lookup).
 */
export function readPack(pack: Buffer, external: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 + 20 || pack.toString('utf8', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface RawEntry {
    type: GitObjectType;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const rawIndexByOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset back to the base object's pack offset.
      let back = pack[offset]! & 0x7f;
      let b = pack[offset]!;
      offset += 1;
      while ((b & 0x80) !== 0) {
        b = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateExact(pack, offset);
      offset = inflated.next;
      raw.push({ type: 'blob', data: inflated.data, baseOffset: start - back });
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id, in this pack or already stored.
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateExact(pack, offset);
      offset = inflated.next;
      raw.push({ type: 'blob', data: inflated.data, baseOid });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateExact(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      raw.push({ type, data: inflated.data });
    }
    rawIndexByOffset.set(start, raw.length - 1);
  }
  const resolved: Array<GitObject | undefined> = raw.map(() => undefined);
  const resolvedByOid = new Map<string, GitObject>();
  const resolve = (index: number): GitObject => {
    const done = resolved[index];
    if (done !== undefined) return done;
    const entry = raw[index]!;
    let object: GitObject;
    if (entry.baseOffset === undefined && entry.baseOid === undefined) {
      object = { type: entry.type, data: entry.data };
    } else {
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseIndex = rawIndexByOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('delta base offset not in pack');
        base = resolve(baseIndex);
      } else {
        // A REF_DELTA base may itself be a delta elsewhere in this pack, so
        // consult everything resolved so far before the receiving store.
        base = resolvedByOid.get(entry.baseOid!) ?? external(entry.baseOid!);
        if (base === undefined) {
          for (let j = 0; j < raw.length; j += 1) {
            const candidate = raw[j]!;
            if (candidate.baseOffset === undefined && candidate.baseOid === undefined && hashObject(candidate.type, candidate.data) === entry.baseOid) {
              base = resolve(j);
              break;
            }
          }
        }
      }
      if (base === undefined) throw new Error('delta base object is missing');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolved[index] = object;
    resolvedByOid.set(hashObject(object.type, object.data), object);
    return object;
  };
  const objects: GitObject[] = [];
  const oids: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const object = resolve(i);
    objects.push(object);
    oids.push(hashObject(object.type, object.data));
  }
  return { objects, oids };
}

// ----------------------------------------------------------------- pkt-line

/** Encode one pkt-line (a payload under 65520 bytes), or the flush packet for null. */
export function pktLine(payload: Buffer | string | null): Buffer {
  if (payload === null) return Buffer.from('0000', 'utf8');
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'utf8'), data]);
}

/** The delimiter packet that separates protocol v2 sections. */
export const PKT_DELIM = Buffer.from('0001', 'utf8');
/** The response-end packet of protocol v2. */
export const PKT_END = Buffer.from('0002', 'utf8');

export interface PktFrame {
  /** The payload; null for a flush, 'delim' for a delimiter, 'end' for response-end. */
  payload: Buffer | null | 'delim' | 'end';
  /** The offset just past this frame. */
  next: number;
}

/** Read one pkt-line frame at `offset`; null when the bytes there are not a frame. */
export function readPktFrame(buffer: Buffer, offset: number): PktFrame | null {
  if (offset + 4 > buffer.length) return null;
  const head = buffer.toString('utf8', offset, offset + 4);
  if (!/^[0-9a-f]{4}$/.test(head)) return null;
  const length = parseInt(head, 16);
  if (length === 0) return { payload: null, next: offset + 4 };
  if (length === 1) return { payload: 'delim', next: offset + 4 };
  if (length === 2) return { payload: 'end', next: offset + 4 };
  if (length < 4 || offset + length > buffer.length) return null;
  return { payload: buffer.subarray(offset + 4, offset + length), next: offset + length };
}

/** Read frames until a flush (or the buffer ends); returns the payloads and where parsing stopped. */
export function readPktSection(buffer: Buffer, offset: number): { payloads: Buffer[]; next: number; flushed: boolean } {
  const payloads: Buffer[] = [];
  let cursor = offset;
  for (;;) {
    const frame = readPktFrame(buffer, cursor);
    if (frame === null) return { payloads, next: cursor, flushed: false };
    cursor = frame.next;
    if (frame.payload === null) return { payloads, next: cursor, flushed: true };
    if (frame.payload === 'delim' || frame.payload === 'end') return { payloads, next: cursor, flushed: false };
    payloads.push(frame.payload);
  }
}
