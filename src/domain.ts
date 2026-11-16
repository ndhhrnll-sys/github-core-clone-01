// The domain operations every surface shares: the JSON views of a repository,
// an issue and a pull request, and the writes behind them (contents commits,
// issue and pull creation, pull merges). REST, GraphQL and MCP all call into
// here, so an object made through one surface is the same object in all.

import { buildCommit } from './gitobj.ts';
import { changedFiles, mergeTrees, type ChangedFile } from './merge.ts';
import {
  branchTip,
  buildTreeFromFlat,
  commitInfo,
  commitTree,
  flattenTree,
  mergeBase,
  putObject,
  type Forge,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';

// --------------------------------------------------------------------- views

/** The REST view of a repository. */
export function repoJson(forge: Forge, repo: RepoRecord): Record<string, unknown> {
  const owner = forge.canonicalOwner;
  return {
    id: repo.dbId,
    node_id: globalId('Repository', String(repo.dbId)),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${owner}/${repo.name}`,
    url: `https://forge.invalid/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

/** The REST view of a label. */
export function labelJson(repo: RepoRecord, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { id: 0, name, color: label?.color ?? '000000', default: false };
}

/** The REST view of an issue. */
export function issueJson(forge: Forge, repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.dbId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    comments: issue.comments.length,
    user: { login: forge.canonicalOwner, id: 1000, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://forge.invalid/${forge.canonicalOwner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The REST view of an issue comment. */
export function commentJson(forge: Forge, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: forge.canonicalOwner, id: 1000, type: 'User' },
  };
}

/** The REST view of a pull request. */
export function pullJson(forge: Forge, repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.dbId}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${forge.canonicalOwner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${forge.canonicalOwner}:${pull.baseRef}` },
    user: { login: forge.canonicalOwner, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://forge.invalid/${forge.canonicalOwner}/${repo.name}/pull/${pull.number}`,
  };
}

// --------------------------------------------------------------- global ids

/** An opaque, stable global id for a stored object (the GraphQL `id`). */
export function globalId(type: string, key: string): string {
  return Buffer.from(`v1:${type}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back into its type and key; null when it is not one of ours. */
export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^v1:([A-Za-z]+):(.+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1]!, key: match[2]! };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ contents

export type WriteResult =
  | { kind: 'created' | 'updated'; blobSha: string; commitSha: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'missing'; message: string };

/** The commit a contents write on `branch` builds on, and its flattened tree. */
function branchBase(repo: RepoRecord, branch: string): { parent: string | null; flat: Map<string, { mode: string; oid: string }> } {
  const tip = branchTip(repo, branch);
  if (tip !== undefined) {
    const info = commitInfo(repo, tip);
    return { parent: tip, flat: info === undefined ? new Map() : flattenTree(repo, info.tree) };
  }
  if (branch !== repo.defaultBranch) {
    // A contents write names a branch that does not exist yet: it starts
    // from the default branch's tip, the way the suite's setup uses it.
    const baseTip = branchTip(repo, repo.defaultBranch);
    if (baseTip !== undefined) {
      const info = commitInfo(repo, baseTip);
      return { parent: baseTip, flat: info === undefined ? new Map() : flattenTree(repo, info.tree) };
    }
  }
  return { parent: null, flat: new Map() };
}

/** Create or update one file through the contents model, committing it on a branch. */
export function writeContent(
  forge: Forge,
  repo: RepoRecord,
  input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): WriteResult {
  const branch = input.branch === undefined || input.branch === '' ? repo.defaultBranch : input.branch;
  const { parent, flat } = branchBase(repo, branch);
  const existing = flat.get(input.path);
  if (existing !== undefined) {
    if (input.sha === undefined || input.sha !== existing.oid) {
      return { kind: 'conflict', message: `the file's sha does not match the current blob sha` };
    }
    const blobSha = putObject(repo, 'blob', input.content);
    flat.set(input.path, { mode: existing.mode, oid: blobSha });
    const commitSha = commitTree(forge, repo, branch, flat, input.message, parent);
    return { kind: 'updated', blobSha, commitSha };
  }
  const blobSha = putObject(repo, 'blob', input.content);
  flat.set(input.path, { mode: '100644', oid: blobSha });
  const commitSha = commitTree(forge, repo, branch, flat, input.message, parent);
  return { kind: 'created', blobSha, commitSha };
}

/** Delete one file through the contents model, committing the removal. */
export function deleteContent(
  forge: Forge,
  repo: RepoRecord,
  input: { path: string; message: string; branch?: string; sha?: string },
): WriteResult {
  const branch = input.branch === undefined || input.branch === '' ? repo.defaultBranch : input.branch;
  const tip = branchTip(repo, branch);
  if (tip === undefined) return { kind: 'missing', message: 'the branch does not exist' };
  const info = commitInfo(repo, tip);
  const flat = info === undefined ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo, info.tree);
  const existing = flat.get(input.path);
  if (existing === undefined) return { kind: 'missing', message: 'the file does not exist' };
  if (input.sha === undefined || input.sha !== existing.oid) {
    return { kind: 'conflict', message: `the file's sha does not match the current blob sha` };
  }
  flat.delete(input.path);
  const commitSha = commitTree(forge, repo, branch, flat, input.message, tip);
  return { kind: 'updated', blobSha: existing.oid, commitSha };
}

// -------------------------------------------------------------------- issues

/** Create an issue (its labels already validated against the repository). */
export function createIssue(forge: Forge, repo: RepoRecord, input: { title: string; body: string; labels: string[] }): IssueRecord {
  const now = forge.clock.nextIso();
  const issue: IssueRecord = {
    id: forge.newIssueId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

// --------------------------------------------------------------------- pulls

/** Create a pull request between two existing branches; null when a branch is missing. */
export function createPull(forge: Forge, repo: RepoRecord, input: { title: string; body: string; head: string; base: string }): PullRecord | null {
  const headSha = branchTip(repo, input.head);
  const baseSha = branchTip(repo, input.base);
  if (headSha === undefined || baseSha === undefined) return null;
  const now = forge.clock.nextIso();
  const pull: PullRecord = {
    id: forge.newPullId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    headSha,
    baseSha,
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The changed files of a pull request, diffed from its merge base to its head. */
export function pullFiles(repo: RepoRecord, pull: PullRecord): ChangedFile[] {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo, baseTip, headTip) ?? pull.baseSha;
  return changedFiles(repo, base, headTip);
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'already' | 'missing' };

/** Merge a pull request into its base branch (squash by default, or a merge commit). */
export function mergePull(forge: Forge, repo: RepoRecord, pull: PullRecord, method: string): MergeResult {
  if (pull.merged) return { ok: false, reason: 'already' };
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  if (baseTip === undefined) return { ok: false, reason: 'missing' };
  const common = mergeBase(repo, baseTip, headTip);
  if (common === undefined) return { ok: false, reason: 'conflict' };
  const baseInfo = commitInfo(repo, baseTip);
  const headInfo = commitInfo(repo, headTip);
  const commonInfo = commitInfo(repo, common);
  if (baseInfo === undefined || headInfo === undefined || commonInfo === undefined) return { ok: false, reason: 'missing' };
  const outcome = mergeTrees(repo, commonInfo.tree, baseInfo.tree, headInfo.tree);
  if (!outcome.ok || outcome.flat === undefined) return { ok: false, reason: 'conflict' };
  const mergedTree = buildTreeFromFlat(repo, outcome.flat);
  const identity = `${forge.canonicalOwner} <${forge.canonicalOwner}@example.invalid> ${Math.floor(forge.clock.nextMs() / 1000)} +0000`;
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const data = buildCommit({ tree: mergedTree, parents, author: identity, committer: identity, message: pull.title });
  const sha = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.clock.nextIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { ok: true, sha };
}
