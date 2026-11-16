// The forge's state: repositories, their object stores and refs, and the
// issues, pull requests, labels and comments that live beside the git data.
// One in-memory store serves every surface (REST, git, GraphQL, MCP), so an
// object created through one is the same object through all the others.

import { buildCommit, buildTree, hashObject, parseCommit, parseTag, parseTree, type CommitInfo, type GitObject, type GitObjectType, type TreeEntry } from './gitobj.ts';
import { Clock } from './util.ts';

/** The login the token names until a request teaches the forge otherwise. */
export const DEFAULT_VIEWER_LOGIN = 'adaiversen';

export interface CommentRecord {
  id: number;
  body: string;
}

export interface IssueRecord {
  /** A store-wide stable id (the REST object's `id`). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** The branch tips as they stood when the pull request was opened. */
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface LabelRecord {
  name: string;
  color: string;
}

export interface RepoRecord {
  /** A stable positive integer (the REST `id`, the GraphQL `databaseId`). */
  dbId: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  /** Full ref names ('refs/heads/main') to object ids. */
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  /** The number the next issue or pull request in this repository takes. */
  nextNumber: number;
  createdAt: string;
}

export class Forge {
  readonly clock: Clock;
  readonly repos = new Map<string, RepoRecord>();
  /** The login the token names; locked in by the first owner-bearing access. */
  canonicalOwner: string = DEFAULT_VIEWER_LOGIN;
  private ownerLocked = false;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private requestSeq = 0;

  constructor(trialNow: string | undefined) {
    this.clock = new Clock(trialNow);
  }

  /** A fresh, non-empty request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `forge-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  /** Create a repository owned by the token's login. Null when the name is taken. */
  createRepo(name: string, description: string, isPrivate: boolean): RepoRecord | null {
    if (this.repos.has(name)) return null;
    const repo: RepoRecord = {
      dbId: this.nextRepoId,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: this.clock.nextIso(),
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * The repository `owner/name` as the token may see it: a repository belongs
   * to the login the token names, so a name that exists under another login
   * is not there at all. The first owner-bearing access to an existing
   * repository teaches the forge the token's login.
   */
  lookupRepo(owner: string, name: string): RepoRecord | undefined {
    const repo = this.repos.get(name);
    if (repo === undefined) return undefined;
    if (!this.ownerLocked && owner !== '') {
      this.canonicalOwner = owner;
      this.ownerLocked = true;
      return repo;
    }
    return owner === this.canonicalOwner ? repo : undefined;
  }

  /** Delete a repository the token owns (same visibility rule as lookupRepo). */
  deleteRepo(owner: string, name: string): boolean {
    if (this.lookupRepo(owner, name) === undefined) return false;
    return this.repos.delete(name);
  }

  newIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  newPullId(): number {
    const id = this.nextPullId;
    this.nextPullId += 1;
    return id;
  }

  newCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

// ------------------------------------------------------------ object access

/** Store an object in a repository, returning its id. */
export function putObject(repo: RepoRecord, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** A repository's object by id. */
export function getObject(repo: RepoRecord, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

const commitInfoCache = new WeakMap<RepoRecord, Map<string, CommitInfo>>();

/** A commit's parsed form (cached per repository). */
export function commitInfo(repo: RepoRecord, oid: string): CommitInfo | undefined {
  let cache = commitInfoCache.get(repo);
  if (cache === undefined) {
    cache = new Map();
    commitInfoCache.set(repo, cache);
  }
  const hit = cache.get(oid);
  if (hit !== undefined) return hit;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return undefined;
  const info = parseCommit(object.data);
  cache.set(oid, info);
  return info;
}

/** Follow tag objects until a non-tag object; returns its id (or the input when not a tag). */
export function peelTag(repo: RepoRecord, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).target;
  }
  return current;
}

/** The commit a ref tip or tag ultimately points at, when there is one. */
export function peelToCommit(repo: RepoRecord, oid: string): string | undefined {
  const peeled = peelTag(repo, oid);
  const object = repo.objects.get(peeled);
  return object !== undefined && object.type === 'commit' ? peeled : undefined;
}

/** The tip of a branch, or undefined when the branch does not exist. */
export function branchTip(repo: RepoRecord, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Every commit reachable from a tip, the tip included (empty when the tip is no commit). */
export function ancestorSet(repo: RepoRecord, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const info = commitInfo(repo, oid);
    if (info === undefined) continue;
    seen.add(oid);
    for (const parent of info.parents) stack.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is `tip` itself or one of its ancestors. */
export function isAncestor(repo: RepoRecord, ancestor: string, tip: string): boolean {
  return ancestorSet(repo, tip).has(ancestor);
}

/** The nearest common ancestor of two commits, when they share history. */
export function mergeBase(repo: RepoRecord, a: string, b: string): string | undefined {
  const ancestorsOfA = ancestorSet(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const info = commitInfo(repo, oid);
    if (info !== undefined) queue.push(...info.parents);
  }
  return undefined;
}

/**
 * The full object closure of the given tips: commits, their trees and blobs
 * recursively, and tag objects with their targets.
 */
export function reachableObjects(repo: RepoRecord, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree, ...info.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).target);
    }
  }
  return seen;
}

// --------------------------------------------------------------------- trees

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (recursively) into a path → entry map. */
export function flattenTree(repo: RepoRecord, treeOid: string, prefix = '', into = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return into;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, into);
    else into.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return into;
}

/** Rebuild nested trees from a flattened map, storing every new tree object. */
export function buildTreeFromFlat(repo: RepoRecord, flat: Map<string, FlatEntry>): string {
  interface DirNode {
    files: TreeEntry[];
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ mode: entry.mode, name: parts[parts.length - 1]!, oid: entry.oid });
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The entries of one directory inside a tree (non-recursive). */
export function listTreeDir(repo: RepoRecord, treeOid: string, dirPath: string): TreeEntry[] | undefined {
  let current = treeOid;
  if (dirPath !== '') {
    for (const part of dirPath.split('/')) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
      if (entry === undefined) return undefined;
      current = entry.oid;
    }
  }
  const object = repo.objects.get(current);
  if (object === undefined || object.type !== 'tree') return undefined;
  return parseTree(object.data);
}

/** The flat entry at an exact path inside a tree. */
export function treeEntryAt(repo: RepoRecord, treeOid: string, path: string): FlatEntry | undefined {
  return flattenTree(repo, treeOid).get(path);
}

// ------------------------------------------------------------------- commits

/** The forge's own author identity line for commits it creates itself. */
export function forgeIdentity(forge: Forge): string {
  const epoch = Math.floor(forge.clock.nextMs() / 1000);
  return `${forge.canonicalOwner} <${forge.canonicalOwner}@example.invalid> ${epoch} +0000`;
}

/**
 * Create a commit on a branch from a whole flattened tree, moving the branch.
 * The parent is the branch's current tip unless `parentOverride` is given
 * (null for a root commit, a commit id to build on an unborn branch).
 * Returns the new commit's id.
 */
export function commitTree(forge: Forge, repo: RepoRecord, branch: string, flat: Map<string, FlatEntry>, message: string, parentOverride?: string | null): string {
  const treeOid = buildTreeFromFlat(repo, flat);
  const parent = parentOverride === undefined ? branchTip(repo, branch) : parentOverride ?? undefined;
  const identity = forgeIdentity(forge);
  const data = buildCommit({
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    author: identity,
    committer: identity,
    message,
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}
