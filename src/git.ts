// Git smart HTTP at /{owner}/{repo}.git: the reference advertisement,
// protocol v2 ls-refs and fetch over git-upload-pack, a protocol v0 fetch
// fallback, and pushes over git-receive-pack with report-status. The wire
// shapes follow the git protocol itself; the object selection follows git's
// rule that a fetch delivers the wanted closure minus what the client has.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PKT_DELIM, ZERO_OID, buildPack, parseTag, parseTree, pktLine, readPack, readPktFrame, type GitObject } from './gitobj.ts';
import { commitInfo, getObject, isAncestor, peelTag, peelToCommit, putObject, reachableObjects, type Forge, type RepoRecord } from './store.ts';
import { readBody } from './util.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_CAPS = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

/** A ref's advertised lines: the ref itself and, for an annotated tag, its peeled target. */
function refLines(repo: RepoRecord, ref: string, oid: string): string[] {
  const lines = [`${oid} ${ref}`];
  const object = getObject(repo, oid);
  if (object !== undefined && object.type === 'tag') {
    lines.push(`${peelTag(repo, oid)} ${ref}^{}`);
  }
  return lines;
}

/** The reference advertisement body for one service. */
function advertisement(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS} agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}` : `${RECEIVE_CAPS} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktLine(null)];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refNames = [...repo.refs.keys()].sort();
  let first = true;
  const emit = (line: string): void => {
    if (first) {
      parts.push(pktLine(`${line}\0${caps}`));
      first = false;
    } else {
      parts.push(pktLine(line));
    }
  };
  if (headOid !== undefined) emit(`${headOid} HEAD`);
  else if (refNames.length > 0) emit(`${ZERO_OID} HEAD`);
  for (const ref of refNames) {
    for (const line of refLines(repo, ref, repo.refs.get(ref)!)) emit(line);
  }
  if (first) emit(`${ZERO_OID} capabilities^{}`);
  parts.push(pktLine(null));
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement (no refs: v2 discovers them with ls-refs). */
function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(null),
  ]);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

function sendPlain(res: ServerResponse, status: number, text: string): void {
  sendBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

// ------------------------------------------------------------------ ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Answer a protocol v2 ls-refs command. */
function lsRefs(repo: RepoRecord, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const ref of [...repo.refs.keys()].sort()) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref)!;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const object = getObject(repo, oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${peelTag(repo, oid)}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), pktLine(null)]);
}

// -------------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

/** The commits within `depth` generations of the wants, and the boundary they stop at. */
function depthLimitedCommits(repo: RepoRecord, wants: string[], depth: number): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  let frontier: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== undefined) frontier.push(commit);
  }
  for (let generation = 0; generation < depth; generation += 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid)) continue;
      included.add(oid);
      const info = commitInfo(repo, oid);
      if (info === undefined) continue;
      if (generation === depth - 1) {
        if (info.parents.length > 0) boundary.add(oid);
      } else {
        next.push(...info.parents);
      }
    }
    frontier = next;
  }
  // A commit reached before the last generation whose parents are all outside
  // the depth window is a boundary too (merged histories).
  for (const oid of included) {
    const info = commitInfo(repo, oid);
    if (info !== undefined && info.parents.length > 0 && info.parents.every((parent) => !included.has(parent))) boundary.add(oid);
  }
  return { included, boundary };
}

/** A commit's own layer: itself plus its tree's whole closure, never its parents'. */
function commitOwnObjects(repo: RepoRecord, commitOid: string): Set<string> {
  const own = new Set<string>([commitOid]);
  const info = commitInfo(repo, commitOid);
  if (info !== undefined) {
    for (const inner of reachableObjects(repo, [info.tree])) own.add(inner);
  }
  return own;
}

/**
 * The closure of the haves as a shallow client actually holds it: a commit
 * the client lists as shallow contributes its own layer, but its ancestors
 * are beyond the client's boundary and are not had.
 */
function haveClosureCut(repo: RepoRecord, haves: string[], shallow: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = commitInfo(repo, oid);
      if (info === undefined) continue;
      stack.push(info.tree);
      if (!shallow.has(oid)) stack.push(...info.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).target);
    }
  }
  return seen;
}

/** Choose the objects a fetch delivers and the shallow bookkeeping that goes with them. */
function planFetch(repo: RepoRecord, request: FetchRequest): { objects: string[]; boundary: Set<string>; includedCommits: Set<string> } {
  const haveClosure = request.haves.length === 0
    ? new Set<string>()
    : request.shallow.length > 0
      ? haveClosureCut(repo, request.haves, new Set(request.shallow))
      : reachableObjects(repo, request.haves);
  let wanted: Set<string>;
  let boundary = new Set<string>();
  let includedCommits = new Set<string>();
  if (request.deepen !== null) {
    const limited = depthLimitedCommits(repo, request.wants, request.deepen);
    includedCommits = limited.included;
    boundary = limited.boundary;
    wanted = new Set<string>();
    for (const oid of includedCommits) {
      for (const inner of commitOwnObjects(repo, oid)) wanted.add(inner);
    }
    // Non-commit wants (a tag, a tree) ride along whole.
    for (const want of request.wants) {
      const object = getObject(repo, want);
      if (object !== undefined && object.type !== 'commit') {
        for (const inner of reachableObjects(repo, [want])) wanted.add(inner);
      }
    }
  } else {
    wanted = reachableObjects(repo, request.wants);
    for (const oid of wanted) {
      const object = getObject(repo, oid);
      if (object !== undefined && object.type === 'commit') includedCommits.add(oid);
    }
  }
  const objects = [...wanted].filter((oid) => !haveClosure.has(oid));
  return { objects, boundary, includedCommits };
}

/** Frame pack bytes as sideband-64k packets (band 1), ready to append to a response. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return packets;
}

/** Build the pack for a planned fetch. */
function fetchPack(repo: RepoRecord, oids: string[]): Buffer {
  const objects = oids
    .map((oid) => {
      const object = getObject(repo, oid);
      return object === undefined ? null : { oid, type: object.type, data: object.data };
    })
    .filter((entry): entry is { oid: string; type: GitObject['type']; data: Buffer } => entry !== null);
  return buildPack(objects);
}

/** The first have the store knows as a commit, in request order. */
function knownHave(repo: RepoRecord, haves: string[]): string | undefined {
  for (const have of haves) {
    const commit = peelToCommit(repo, have);
    if (commit !== undefined) return commit;
  }
  return undefined;
}

/** Answer a protocol v2 fetch command. */
function fetchV2(repo: RepoRecord, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  // The acknowledgments section belongs to the negotiation rounds. Once the
  // client says `done` it must not appear at all (real git refuses it); when
  // it does appear with `ready`, the pack must follow in the same response.
  // With no common object and no `done`, a bare NAK ends the round.
  const known = request.haves.length > 0 ? knownHave(repo, request.haves) : undefined;
  if (!request.done && known === undefined && request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktLine(null));
    return Buffer.concat(parts);
  }
  // Sections are separated by a delimiter packet; a flush ends the response.
  let separated = false;
  const section = (header: string, lines: string[]): void => {
    if (separated) parts.push(PKT_DELIM);
    parts.push(pktLine(`${header}\n`), ...lines.map((line) => pktLine(`${line}\n`)));
    separated = true;
  };
  if (!request.done && known !== undefined) {
    section('acknowledgments', [`ACK ${known}`, 'ready']);
  }
  // shallow-info, when the exchange touches shallow history at all
  if (request.deepen !== null || request.shallow.length > 0) {
    const lines: string[] = [];
    for (const oid of [...plan.boundary].sort()) lines.push(`shallow ${oid}`);
    for (const previous of request.shallow) {
      if (plan.includedCommits.has(previous) && !plan.boundary.has(previous)) lines.push(`unshallow ${previous}`);
    }
    section('shallow-info', lines);
  }
  // wanted-refs, only when asked
  if (request.wantRefs.length > 0) {
    section('wanted-refs', request.wantRefs.map((ref) => `${repo.refs.get(ref) ?? ZERO_OID} ${ref}`));
  }
  // packfile
  if (separated) parts.push(PKT_DELIM);
  parts.push(pktLine('packfile\n'), ...sidebandPackets(fetchPack(repo, plan.objects)), pktLine(null));
  return Buffer.concat(parts);
}

/** Answer a protocol v0 fetch (the two-section request git sends without v2). */
function fetchV0(repo: RepoRecord, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (request.deepen !== null) {
    for (const oid of [...plan.boundary].sort()) parts.push(pktLine(`shallow ${oid}\n`));
  }
  const known = request.haves.length > 0 ? knownHave(repo, request.haves) : undefined;
  parts.push(pktLine(known === undefined ? 'NAK\n' : `ACK ${known} common\n`));
  parts.push(...sidebandPackets(fetchPack(repo, plan.objects)), pktLine(null));
  return Buffer.concat(parts);
}

/** Parse the pkt-line argument block of an upload-pack POST into a command and its lines. */
function parseUploadBody(body: Buffer): { command: string; caps: string[]; args: string[]; rest: Buffer } | null {
  const lines: string[] = [];
  let cursor = 0;
  let sawDelim = false;
  for (;;) {
    const frame = readPktFrame(body, cursor);
    if (frame === null) return null;
    cursor = frame.next;
    if (frame.payload === null) break;
    if (frame.payload === 'delim') {
      sawDelim = true;
      break;
    }
    if (frame.payload === 'end') break;
    lines.push(frame.payload.toString('utf8').replace(/\n$/, ''));
  }
  const args: string[] = [];
  if (sawDelim) {
    for (;;) {
      const frame = readPktFrame(body, cursor);
      if (frame === null) break;
      cursor = frame.next;
      if (frame.payload === null || frame.payload === 'end') break;
      if (frame.payload === 'delim') continue;
      args.push(frame.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  const commandLine = lines.find((line) => line.startsWith('command='));
  return {
    command: commandLine === undefined ? '' : commandLine.slice('command='.length),
    caps: lines.filter((line) => !line.startsWith('command=')),
    args,
    rest: body.subarray(cursor),
  };
}

/** Parse a protocol v0 upload-pack request (wants section, then haves section). */
function parseUploadBodyV0(body: Buffer): FetchRequest | null {
  const wants: string[] = [];
  const shallow: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let cursor = 0;
  let section = 0;
  let done = false;
  while (!done) {
    const frame = readPktFrame(body, cursor);
    if (frame === null) return null;
    cursor = frame.next;
    if (frame.payload === null) {
      section += 1;
      if (section >= 2) break;
      continue;
    }
    if (frame.payload === 'delim' || frame.payload === 'end') break;
    const line = frame.payload.toString('utf8').replace(/\n$/, '');
    const [head, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    if (head === 'want') wants.push(arg.split(' ')[0]!);
    else if (head === 'have') haves.push(arg);
    else if (head === 'shallow') shallow.push(arg);
    else if (head === 'deepen') deepen = Number(arg);
    else if (head === 'done') done = true;
  }
  return { wants, wantRefs: [], haves, shallow, deepen, done };
}

/** Handle POST git-upload-pack (v2 ls-refs / fetch, or a v0 fetch). */
async function uploadPack(repo: RepoRecord, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const protocol = req.headers['git-protocol'];
  const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
  if (!isV2) {
    const request = parseUploadBodyV0(body);
    if (request === null) {
      sendPlain(res, 400, 'unparsable upload-pack request\n');
      return;
    }
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchV0(repo, request));
    return;
  }
  const parsed = parseUploadBody(body);
  if (parsed === null) {
    sendPlain(res, 400, 'unparsable upload-pack request\n');
    return;
  }
  if (parsed.command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of parsed.args) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, args));
    return;
  }
  if (parsed.command === 'fetch') {
    const request: FetchRequest = { wants: [], wantRefs: [], haves: [], shallow: [], deepen: null, done: false };
    for (const line of parsed.args) {
      const [head, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      if (head === 'want') request.wants.push(arg);
      else if (head === 'want-ref') request.wantRefs.push(arg);
      else if (head === 'have') request.haves.push(arg);
      else if (head === 'shallow') request.shallow.push(arg);
      else if (head === 'deepen') request.deepen = Number(arg);
      else if (head === 'done') request.done = true;
    }
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchV2(repo, request));
    return;
  }
  sendPlain(res, 400, `unknown command ${parsed.command}\n`);
}

// --------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle POST git-receive-pack: store the pack, move the refs, report per ref. */
async function receivePack(repo: RepoRecord, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const commands: PushCommand[] = [];
  let cursor = 0;
  let clientCaps = '';
  for (;;) {
    const frame = readPktFrame(body, cursor);
    if (frame === null || frame.payload === 'delim' || frame.payload === 'end') {
      sendPlain(res, 400, 'unparsable receive-pack request\n');
      return;
    }
    cursor = frame.next;
    if (frame.payload === null) break;
    let line = frame.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      clientCaps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3) {
      sendPlain(res, 400, 'unparsable receive-pack request\n');
      return;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const packBytes = body.subarray(cursor);
  let unpackLine = 'unpack ok';
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes, (oid) => getObject(repo, oid));
      for (let i = 0; i < pack.objects.length; i += 1) {
        putObject(repo, pack.objects[i]!.type, pack.objects[i]!.data);
      }
    } catch (err) {
      unpackLine = `unpack error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const report: string[] = [unpackLine];
  for (const command of commands) {
    if (unpackLine !== 'unpack ok') {
      report.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    report.push(applyPushCommand(repo, command));
  }
  const inner = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), pktLine(null)]);
  const sideband = clientCaps.split(' ').includes('side-band-64k');
  const out = sideband ? Buffer.concat([...sidebandPackets(inner), pktLine(null)]) : inner;
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', out);
}

/** Apply one ref update from a push, returning its report line. */
function applyPushCommand(repo: RepoRecord, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return `ng ${ref} invalid ref`;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  if (getObject(repo, newOid) === undefined) return `ng ${ref} unknown object`;
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return `ng ${ref} already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return `ng ${ref} stale info`;
  if (current === newOid) return `ok ${ref}`;
  const oldCommit = peelToCommit(repo, oldOid);
  const newCommit = peelToCommit(repo, newOid);
  if (oldCommit !== undefined && newCommit !== undefined && oldCommit !== newCommit && !isAncestor(repo, oldCommit, newCommit)) {
    return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// -------------------------------------------------------------------- routing

/**
 * Serve one git smart-HTTP request. Returns false when the path is not a git
 * path at all (the caller answers 404), true once answered.
 */
export async function handleGit(forge: Forge, req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams): Promise<boolean> {
  const [owner, repoSegment] = segments;
  const sub = segments.slice(2).join('/');
  if (owner === undefined || repoSegment === undefined || !repoSegment.endsWith('.git')) return false;
  const repoName = repoSegment.slice(0, -'.git'.length);
  const repo = forge.lookupRepo(owner, repoName);
  if (sub === 'info/refs' && req.method === 'GET') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendPlain(res, 400, 'missing or unknown service\n');
      return true;
    }
    if (repo === undefined) {
      sendPlain(res, 404, 'repository not found\n');
      return true;
    }
    const protocol = req.headers['git-protocol'];
    if (service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2')) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV2());
    } else {
      sendBuffer(res, 200, `application/x-${service}-advertisement`, advertisement(repo, service));
    }
    return true;
  }
  if (sub === 'git-upload-pack' && req.method === 'POST') {
    if (repo === undefined) {
      sendPlain(res, 404, 'repository not found\n');
      return true;
    }
    await uploadPack(repo, req, res);
    return true;
  }
  if (sub === 'git-receive-pack' && req.method === 'POST') {
    if (repo === undefined) {
      sendPlain(res, 404, 'repository not found\n');
      return true;
    }
    await receivePack(repo, req, res);
    return true;
  }
  return false;
}
