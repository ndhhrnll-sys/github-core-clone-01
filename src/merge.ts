// Pull-request mechanics over the object store: the changed-file list between
// two trees (with line counts) and the file-level three-way merge a squash or
// merge commit is built from.

import { commitInfo, flattenTree, type FlatEntry, type RepoRecord } from './store.ts';

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  /** The blob id on the head side (the base side for a removal). */
  sha: string;
}

/** The lines of a blob, for diffing: a trailing newline ends the last line rather than adding one. */
function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level add/remove counts between two texts, from a longest-common-subsequence walk. */
export function lineDiff(base: Buffer, head: Buffer): { additions: number; deletions: number } {
  const a = linesOf(base);
  const b = linesOf(head);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // Files in this forge are small; a full LCS table is fine, with a cheap
  // fallback for anything unexpectedly large.
  if (a.length * b.length > 4_000_000) {
    const inB = new Set(b);
    const inA = new Set(a);
    return {
      additions: b.filter((line) => !inA.has(line)).length,
      deletions: a.filter((line) => !inB.has(line)).length,
    };
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const common = table[0]!;
  return { additions: b.length - common, deletions: a.length - common };
}

/** Every path that differs between two commits' trees. */
export function changedFiles(repo: RepoRecord, baseCommit: string, headCommit: string): ChangedFile[] {
  const baseInfo = commitInfo(repo, baseCommit);
  const headInfo = commitInfo(repo, headCommit);
  if (baseInfo === undefined || headInfo === undefined) return [];
  const baseFlat = flattenTree(repo, baseInfo.tree);
  const headFlat = flattenTree(repo, headInfo.tree);
  const files: ChangedFile[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const baseEntry = baseFlat.get(path);
    const headEntry = headFlat.get(path);
    if (baseEntry !== undefined && headEntry === undefined) {
      const blob = repo.objects.get(baseEntry.oid);
      const deletions = blob === undefined ? 0 : linesOf(blob.data).length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: baseEntry.oid });
    } else if (baseEntry === undefined && headEntry !== undefined) {
      const blob = repo.objects.get(headEntry.oid);
      const additions = blob === undefined ? 0 : linesOf(blob.data).length;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: headEntry.oid });
    } else if (baseEntry !== undefined && headEntry !== undefined && (baseEntry.oid !== headEntry.oid || baseEntry.mode !== headEntry.mode)) {
      const baseBlob = repo.objects.get(baseEntry.oid);
      const headBlob = repo.objects.get(headEntry.oid);
      const diff = baseEntry.oid === headEntry.oid ? { additions: 0, deletions: 0 } : lineDiff(baseBlob?.data ?? Buffer.alloc(0), headBlob?.data ?? Buffer.alloc(0));
      files.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions, sha: headEntry.oid });
    }
  }
  return files;
}

export interface MergeOutcome {
  ok: boolean;
  /** The merged tree's flattened form, when the merge is clean. */
  flat?: Map<string, FlatEntry>;
}

/**
 * A file-level three-way merge of two trees against their merge-base tree:
 * a path changed on only one side takes that side's version; a path changed
 * on both sides to the same content takes it; anything else conflicts.
 */
export function mergeTrees(repo: RepoRecord, baseTree: string, ourTree: string, theirTree: string): MergeOutcome {
  const base = flattenTree(repo, baseTree);
  const ours = flattenTree(repo, ourTree);
  const theirs = flattenTree(repo, theirTree);
  const result = new Map<string, FlatEntry>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOT = o?.oid === t?.oid && o?.mode === t?.mode;
    if (sameOT) {
      if (o !== undefined) result.set(path, o);
      continue;
    }
    const baseEqualsOurs = b?.oid === o?.oid && b?.mode === o?.mode;
    const baseEqualsTheirs = b?.oid === t?.oid && b?.mode === t?.mode;
    if (baseEqualsOurs && !baseEqualsTheirs) {
      if (t !== undefined) result.set(path, t);
    } else if (baseEqualsTheirs && !baseEqualsOurs) {
      if (o !== undefined) result.set(path, o);
    } else {
      return { ok: false };
    }
  }
  return { ok: true, flat: result };
}

/** Whether the pull between two commits merges cleanly (same test the merge itself runs). */
export function mergesCleanly(repo: RepoRecord, baseCommit: string, headCommit: string, base: string | undefined): boolean {
  if (base === undefined) return false;
  const baseInfo = commitInfo(repo, baseCommit);
  const headInfo = commitInfo(repo, headCommit);
  const mergeBaseInfo = commitInfo(repo, base);
  if (baseInfo === undefined || headInfo === undefined || mergeBaseInfo === undefined) return false;
  return mergeTrees(repo, mergeBaseInfo.tree, baseInfo.tree, headInfo.tree).ok;
}
