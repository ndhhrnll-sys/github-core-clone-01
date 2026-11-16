// The REST v3 surface under /api/v3: repositories and their git data views,
// contents, labels, issues, comments and pull requests, with GitHub's status
// codes and error shapes. Every reply is JSON (except the 204) and carries
// the request id the server assigned.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './gitobj.ts';
import { commentJson, createIssue, createPull, deleteContent, issueJson, labelJson, mergePull, pullFiles, pullJson, repoJson, writeContent } from './domain.ts';
import { branchTip, commitInfo, flattenTree, getObject, listTreeDir, peelToCommit, type Forge, type RepoRecord } from './store.ts';
import { b64decode, b64encode, isRecord, readBody, sendEmpty, sendJson, stringField } from './util.ts';

/** The scopes header the API root advertises. */
const OAUTH_SCOPES = 'repo, read:org';

interface RestContext {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  requestId: string;
  query: URLSearchParams;
}

function notFound(ctx: RestContext): void {
  sendJson(ctx.res, 404, { message: 'Not Found' }, ctx.requestId);
}

function badRequest(ctx: RestContext, message: string): void {
  sendJson(ctx.res, 400, { message }, ctx.requestId);
}

function unprocessable(ctx: RestContext, message: string): void {
  sendJson(ctx.res, 422, { message }, ctx.requestId);
}

/** Read a JSON request body; answers 400 and returns undefined when it is malformed. */
async function jsonBody(ctx: RestContext): Promise<Record<string, unknown> | undefined> {
  const raw = await readBody(ctx.req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    badRequest(ctx, 'Invalid JSON');
    return undefined;
  }
}

/** An integer query parameter with a fallback. */
function intParam(ctx: RestContext, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Slice a list by page/per_page and set the Link header when a next page exists. */
function paginate<T>(ctx: RestContext, items: T[], path: string): T[] {
  const perPage = Math.min(intParam(ctx, 'per_page', 30), 100);
  const page = intParam(ctx, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? 'localhost';
    const next = `http://${host}${path}?per_page=${perPage}&page=${page + 1}`;
    const last = `http://${host}${path}?per_page=${perPage}&page=${Math.ceil(items.length / perPage)}`;
    ctx.res.setHeader('link', `<${next}>; rel="next", <${last}>; rel="last"`);
  }
  return slice;
}

// ---------------------------------------------------------------- repository

function createRepo(ctx: RestContext, body: Record<string, unknown>): void {
  const name = stringField(body, 'name');
  if (name === '') {
    unprocessable(ctx, 'name is required');
    return;
  }
  const repo = ctx.forge.createRepo(name, stringField(body, 'description'), body.private === true);
  if (repo === null) {
    unprocessable(ctx, 'name already exists on this account');
    return;
  }
  if (body.auto_init === true) {
    writeContent(ctx.forge, repo, { path: 'README.md', content: Buffer.from(`# ${name}\n`, 'utf8'), message: 'Initial commit' });
  }
  sendJson(ctx.res, 201, repoJson(ctx.forge, repo), ctx.requestId);
}

function listUserRepos(ctx: RestContext): void {
  const all = [...ctx.forge.repos.values()].sort((a, b) => a.dbId - b.dbId);
  const page = paginate(ctx, all, '/api/v3/user/repos');
  sendJson(ctx.res, 200, page.map((repo) => repoJson(ctx.forge, repo)), ctx.requestId);
}

// ------------------------------------------------------------------- commits

/** Resolve a ?sha= or ?ref= value to a commit id: branch, ref, tag or commit. */
function resolveCommit(repo: RepoRecord, value: string): string | undefined {
  const byBranch = branchTip(repo, value);
  if (byBranch !== undefined) return byBranch;
  const byRef = repo.refs.get(value) ?? repo.refs.get(`refs/heads/${value}`) ?? repo.refs.get(`refs/tags/${value}`);
  const start = byRef ?? value;
  const object = getObject(repo, start);
  if (object === undefined) return undefined;
  if (object.type === 'commit') return start;
  if (object.type === 'tag') return peelToCommit(repo, start);
  return undefined;
}

/** An author/committer line split into the REST shape. */
function personJson(line: string, data: Buffer): { name: string; email: string; date: string } {
  const text = data.toString('utf8');
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') break;
    if (rawLine.startsWith(`${line} `)) {
      const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(rawLine.slice(line.length + 1));
      if (match) return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString() };
    }
  }
  return { name: '', email: '', date: new Date(0).toISOString() };
}

function listCommits(ctx: RestContext, repo: RepoRecord): void {
  const shaParam = ctx.query.get('sha');
  const start = shaParam === null ? branchTip(repo, repo.defaultBranch) : resolveCommit(repo, shaParam);
  if (start === undefined) {
    sendJson(ctx.res, 200, [], ctx.requestId);
    return;
  }
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const info = commitInfo(repo, oid);
    if (info === undefined) continue;
    seen.add(oid);
    order.push(oid);
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]!);
  }
  const perPage = Math.min(intParam(ctx, 'per_page', 30), 100);
  const page = intParam(ctx, 'page', 1);
  const slice = order.slice((page - 1) * perPage, page * perPage);
  const body = slice.map((oid) => {
    const object = repo.objects.get(oid)!;
    const info = parseCommit(object.data);
    return {
      sha: oid,
      commit: {
        message: info.message,
        author: personJson('author', object.data),
        committer: personJson('committer', object.data),
        tree: { sha: info.tree },
      },
      parents: info.parents.map((parent) => ({ sha: parent })),
    };
  });
  sendJson(ctx.res, 200, body, ctx.requestId);
}

// ------------------------------------------------------------------ contents

function getContents(ctx: RestContext, repo: RepoRecord, path: string): void {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const commit = resolveCommit(repo, ref);
  if (commit === undefined) {
    notFound(ctx);
    return;
  }
  const info = commitInfo(repo, commit);
  if (info === undefined) {
    notFound(ctx);
    return;
  }
  if (path === '') {
    const entries = listTreeDir(repo, info.tree, '');
    sendJson(ctx.res, 200, (entries ?? []).map((entry) => dirEntryJson(repo, '', entry)), ctx.requestId);
    return;
  }
  const flat = flattenTree(repo, info.tree);
  const file = flat.get(path);
  if (file !== undefined) {
    const blob = getObject(repo, file.oid);
    const data = blob?.data ?? Buffer.alloc(0);
    sendJson(ctx.res, 200, {
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: file.oid,
      size: data.length,
      encoding: 'base64',
      content: b64encode(data),
    }, ctx.requestId);
    return;
  }
  const entries = listTreeDir(repo, info.tree, path);
  if (entries !== undefined) {
    sendJson(ctx.res, 200, entries.map((entry) => dirEntryJson(repo, path, entry)), ctx.requestId);
    return;
  }
  notFound(ctx);
}

function dirEntryJson(repo: RepoRecord, base: string, entry: { mode: string; name: string; oid: string }): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const blob = isDir ? undefined : getObject(repo, entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: base === '' ? entry.name : `${base}/${entry.name}`,
    sha: entry.oid,
    size: blob?.data.length ?? 0,
  };
}

async function putContents(ctx: RestContext, repo: RepoRecord, path: string): Promise<void> {
  const body = await jsonBody(ctx);
  if (body === undefined) return;
  const result = writeContent(ctx.forge, repo, {
    path,
    content: b64decode(stringField(body, 'content')),
    message: stringField(body, 'message'),
    branch: typeof body.branch === 'string' ? body.branch : undefined,
    sha: typeof body.sha === 'string' ? body.sha : undefined,
  });
  if (result.kind === 'conflict') {
    sendJson(ctx.res, 409, { message: result.message }, ctx.requestId);
    return;
  }
  if (result.kind === 'missing') {
    notFound(ctx);
    return;
  }
  const blob = getObject(repo, result.blobSha);
  sendJson(ctx.res, result.kind === 'created' ? 201 : 200, {
    content: { name: path.split('/').pop(), path, sha: result.blobSha, size: blob?.data.length ?? 0, encoding: 'base64' },
    commit: { sha: result.commitSha },
  }, ctx.requestId);
}

async function deleteContents(ctx: RestContext, repo: RepoRecord, path: string): Promise<void> {
  const body = await jsonBody(ctx);
  if (body === undefined) return;
  const result = deleteContent(ctx.forge, repo, {
    path,
    message: stringField(body, 'message'),
    branch: typeof body.branch === 'string' ? body.branch : undefined,
    sha: typeof body.sha === 'string' ? body.sha : undefined,
  });
  if (result.kind === 'conflict') {
    sendJson(ctx.res, 409, { message: result.message }, ctx.requestId);
    return;
  }
  if (result.kind === 'missing') {
    notFound(ctx);
    return;
  }
  sendJson(ctx.res, 200, { content: null, commit: { sha: result.commitSha } }, ctx.requestId);
}

// -------------------------------------------------------------------- issues

async function createIssueRoute(ctx: RestContext, repo: RepoRecord): Promise<void> {
  const body = await jsonBody(ctx);
  if (body === undefined) return;
  const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) {
      unprocessable(ctx, `Validation Failed: the label "${label}" does not exist`);
      return;
    }
  }
  const issue = createIssue(ctx.forge, repo, { title: stringField(body, 'title'), body: stringField(body, 'body'), labels });
  sendJson(ctx.res, 201, issueJson(ctx.forge, repo, issue), ctx.requestId);
}

function listIssues(ctx: RestContext, repo: RepoRecord): void {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = paginate(ctx, issues, `/api/v3/repos/${ctx.forge.canonicalOwner}/${repo.name}/issues`);
  sendJson(ctx.res, 200, page.map((issue) => issueJson(ctx.forge, repo, issue)), ctx.requestId);
}

// --------------------------------------------------------------------- pulls

async function createPullRoute(ctx: RestContext, repo: RepoRecord): Promise<void> {
  const body = await jsonBody(ctx);
  if (body === undefined) return;
  const stripLabel = (ref: string): string => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
  const pull = createPull(ctx.forge, repo, {
    title: stringField(body, 'title'),
    body: stringField(body, 'body'),
    head: stripLabel(stringField(body, 'head')),
    base: stripLabel(stringField(body, 'base')),
  });
  if (pull === null) {
    unprocessable(ctx, 'Validation Failed: the head or base branch does not exist');
    return;
  }
  sendJson(ctx.res, 201, pullJson(ctx.forge, repo, pull), ctx.requestId);
}

function listPulls(ctx: RestContext, repo: RepoRecord): void {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => a.number - b.number);
  const page = paginate(ctx, pulls, `/api/v3/repos/${ctx.forge.canonicalOwner}/${repo.name}/pulls`);
  sendJson(ctx.res, 200, page.map((pull) => pullJson(ctx.forge, repo, pull)), ctx.requestId);
}

async function mergePullRoute(ctx: RestContext, repo: RepoRecord, number: number): Promise<void> {
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    notFound(ctx);
    return;
  }
  const body = await jsonBody(ctx);
  if (body === undefined) return;
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  const result = mergePull(ctx.forge, repo, pull, method);
  if (!result.ok) {
    sendJson(ctx.res, 405, { message: result.reason === 'already' ? 'Pull Request has already been merged' : 'Pull Request is not mergeable' }, ctx.requestId);
    return;
  }
  sendJson(ctx.res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' }, ctx.requestId);
}

// -------------------------------------------------------------------- routing

/** Handle one request under /api/v3. Returns false when the path is not REST. */
export async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, requestId: string): Promise<boolean> {
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const ctx: RestContext = { forge, req, res, requestId, query };
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        meta_url: '/api/v3/meta',
      }, requestId, { 'x-oauth-scopes': OAUTH_SCOPES });
    } else notFound(ctx);
    return true;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0', api_version: '3' }, requestId);
    else notFound(ctx);
    return true;
  }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') sendJson(res, 200, { login: forge.canonicalOwner, id: 1000, type: 'User' }, requestId);
    else notFound(ctx);
    return true;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') listUserRepos(ctx);
    else if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body !== undefined) createRepo(ctx, body);
    } else notFound(ctx);
    return true;
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1]!;
    const repo = forge.lookupRepo(owner, rest[2]!);
    if (repo === undefined) {
      notFound(ctx);
      return true;
    }
    await routeRepo(ctx, repo, rest.slice(3), method);
    return true;
  }
  notFound(ctx);
  return true;
}

/** The routes inside one repository. */
async function routeRepo(ctx: RestContext, repo: RepoRecord, parts: string[], method: string): Promise<void> {
  const { forge, res, requestId } = ctx;
  if (parts.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(forge, repo), requestId);
    } else if (method === 'PATCH') {
      const body = await jsonBody(ctx);
      if (body === undefined) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, 200, repoJson(forge, repo), requestId);
    } else if (method === 'DELETE') {
      forge.repos.delete(repo.name);
      sendEmpty(res, 204, requestId);
    } else notFound(ctx);
    return;
  }
  const [head, ...tail] = parts;
  if (head === 'git' && tail[0] === 'refs') {
    await routeRefs(ctx, repo, tail.slice(1), method);
    return;
  }
  if (head === 'branches') {
    if (method === 'GET' && tail.length === 0) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, branches, requestId);
    } else if (method === 'GET') {
      const name = tail.join('/');
      const sha = branchTip(repo, name);
      if (sha === undefined) notFound(ctx);
      else sendJson(res, 200, { name, commit: { sha }, protected: false }, requestId);
    } else notFound(ctx);
    return;
  }
  if (head === 'commits' && tail.length === 0) {
    if (method === 'GET') listCommits(ctx, repo);
    else notFound(ctx);
    return;
  }
  if (head === 'contents') {
    const path = tail.join('/');
    if (method === 'GET') getContents(ctx, repo, path);
    else if (method === 'PUT') await putContents(ctx, repo, path);
    else if (method === 'DELETE') await deleteContents(ctx, repo, path);
    else notFound(ctx);
    return;
  }
  if (head === 'labels') {
    if (method === 'GET' && tail.length === 0) {
      sendJson(res, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)), requestId);
    } else if (method === 'POST' && tail.length === 0) {
      const body = await jsonBody(ctx);
      if (body === undefined) return;
      const name = stringField(body, 'name');
      if (name === '') {
        unprocessable(ctx, 'name is required');
        return;
      }
      if (repo.labels.has(name)) {
        unprocessable(ctx, 'Validation Failed: the label already exists');
        return;
      }
      repo.labels.set(name, { name, color: stringField(body, 'color') || '000000' });
      sendJson(res, 201, labelJson(repo, name), requestId);
    } else if (method === 'GET') {
      const name = tail.join('/');
      if (repo.labels.has(name)) sendJson(res, 200, labelJson(repo, name), requestId);
      else notFound(ctx);
    } else notFound(ctx);
    return;
  }
  if (head === 'issues') {
    await routeIssues(ctx, repo, tail, method);
    return;
  }
  if (head === 'pulls') {
    await routePulls(ctx, repo, tail, method);
    return;
  }
  notFound(ctx);
}

/** The /git/refs routes (branch creation and single-ref reads). */
async function routeRefs(ctx: RestContext, repo: RepoRecord, parts: string[], method: string): Promise<void> {
  const { res, requestId } = ctx;
  if (method === 'POST' && parts.length === 0) {
    const body = await jsonBody(ctx);
    if (body === undefined) return;
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (!ref.startsWith('refs/')) {
      unprocessable(ctx, 'ref must be a fully qualified ref');
      return;
    }
    if (repo.refs.has(ref)) {
      unprocessable(ctx, 'Reference already exists');
      return;
    }
    const object = getObject(repo, sha);
    if (object === undefined) {
      unprocessable(ctx, 'the object does not exist');
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: object.type } }, requestId);
    return;
  }
  if (method === 'GET') {
    const ref = `refs/${parts.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      notFound(ctx);
      return;
    }
    const object = getObject(repo, sha);
    sendJson(res, 200, { ref, object: { sha, type: object?.type ?? 'commit' } }, requestId);
    return;
  }
  notFound(ctx);
}

/** The /issues routes. */
async function routeIssues(ctx: RestContext, repo: RepoRecord, parts: string[], method: string): Promise<void> {
  const { forge, res, requestId } = ctx;
  if (parts.length === 0) {
    if (method === 'GET') listIssues(ctx, repo);
    else if (method === 'POST') await createIssueRoute(ctx, repo);
    else notFound(ctx);
    return;
  }
  const number = Number.parseInt(parts[0]!, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) {
    notFound(ctx);
    return;
  }
  if (parts.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(forge, repo, issue), requestId);
    } else if (method === 'PATCH') {
      const body = await jsonBody(ctx);
      if (body === undefined) return;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((entry): entry is string => typeof entry === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            unprocessable(ctx, `Validation Failed: the label "${label}" does not exist`);
            return;
          }
        }
        issue.labels = labels;
      }
      issue.updatedAt = forge.clock.nextIso();
      sendJson(res, 200, issueJson(forge, repo, issue), requestId);
    } else notFound(ctx);
    return;
  }
  if (parts.length === 2 && parts[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentJson(forge, comment)), requestId);
    } else if (method === 'POST') {
      const body = await jsonBody(ctx);
      if (body === undefined) return;
      const comment = { id: forge.newCommentId(), body: stringField(body, 'body') };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(forge, comment), requestId);
    } else notFound(ctx);
    return;
  }
  notFound(ctx);
}

/** The /pulls routes. */
async function routePulls(ctx: RestContext, repo: RepoRecord, parts: string[], method: string): Promise<void> {
  const { forge, res, requestId } = ctx;
  if (parts.length === 0) {
    if (method === 'GET') listPulls(ctx, repo);
    else if (method === 'POST') await createPullRoute(ctx, repo);
    else notFound(ctx);
    return;
  }
  const number = Number.parseInt(parts[0]!, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (parts.length === 2 && parts[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) {
      notFound(ctx);
      return;
    }
    await mergePullRoute(ctx, repo, number);
    return;
  }
  if (pull === undefined) {
    notFound(ctx);
    return;
  }
  if (parts.length === 1) {
    if (method === 'GET') sendJson(res, 200, pullJson(forge, repo, pull), requestId);
    else notFound(ctx);
    return;
  }
  if (parts.length === 2 && parts[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: file.sha,
    }));
    sendJson(res, 200, files, requestId);
    return;
  }
  notFound(ctx);
}
