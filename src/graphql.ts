// The GraphQL v4 surface at /api/graphql: a small parser for the document
// shapes gh and github-mcp-server send (operations, aliases, variables, input
// objects, enums, inline fragments, batching) and an executor over a schema
// table that resolves against the same store as every other surface.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createIssue, createPull, globalId, mergePull, parseGlobalId, pullFiles } from './domain.ts';
import { mergesCleanly } from './merge.ts';
import { branchTip, mergeBase, type Forge, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';
import { isRecord, readBody } from './util.ts';

// --------------------------------------------------------------------- parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  defaults: Record<string, Value>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (/\s|,/.test(ch)) {
      i += 1;
    } else if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
    } else if (PUNCT.has(ch)) {
      tokens.push(ch);
      i += 1;
    } else if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
      } else {
        let j = i + 1;
        let value = '';
        while (j < source.length && source[j] !== '"') {
          if (source[j] === '\\') {
            value += source[j + 1] === 'u' ? String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)) : escapeChar(source[j + 1]!);
            j += source[j + 1] === 'u' ? 6 : 2;
          } else {
            value += source[j];
            j += 1;
          }
        }
        if (j >= source.length) throw new Error('unterminated string');
        tokens.push(`"${value}"`);
        i = j + 1;
      }
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
    } else if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
    } else {
      throw new Error(`unexpected character ${JSON.stringify(ch)}`);
    }
  }
  return tokens;
}

function escapeChar(ch: string): string {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'b': return '\b';
    case 'f': return '\f';
    default: return ch;
  }
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ type: 'query', name: null, defaults: {}, selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        const defaults: Record<string, Value> = {};
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            this.expect('$');
            const varName = this.next();
            this.expect(':');
            this.parseType();
            if (this.peek() === '=') {
              this.next();
              defaults[varName] = this.parseValue();
            }
            if (this.peek() === '@') this.skipDirective();
          }
          this.expect(')');
        }
        if (this.peek() === '@') this.skipDirective();
        operations.push({ type: head, name, defaults, selectionSet: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        this.next(); // the type condition
        if (this.peek() === '@') this.skipDirective();
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private skipDirective(): void {
    this.expect('@');
    this.next();
    if (this.peek() === '(') {
      let depth = 0;
      do {
        const token = this.next();
        if (token === '(') depth += 1;
        else if (token === ')') depth -= 1;
      } while (depth > 0);
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          if (this.peek() === '@') this.skipDirective();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
      } else {
        selections.push(this.parseField());
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, Value> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    if (this.peek() === '@') this.skipDirective();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

/** Turn a parsed Value into plain JS data, substituting variables. */
function materialize(value: Value, variables: Record<string, unknown>, defaults: Record<string, Value>): unknown {
  switch (value.kind) {
    case 'var': {
      if (value.name in variables) return variables[value.name];
      const fallback = defaults[value.name];
      return fallback === undefined ? null : materialize(fallback, variables, defaults);
    }
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => materialize(item, variables, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value.fields)) out[key] = materialize(inner, variables, defaults);
      return out;
    }
  }
}

// ------------------------------------------------------------------ execution

/** A resolved object value: its GraphQL type and the record it wraps. */
interface GNode {
  __type: string;
  data: unknown;
}

function node(type: string, data: unknown): GNode {
  return { __type: type, data };
}

function isNode(value: unknown): value is GNode {
  return isRecord(value) && typeof value.__type === 'string';
}

type Resolver = (forge: Forge, parent: unknown, args: Record<string, unknown>) => unknown;

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  defaults: Record<string, Value>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string; path: Array<string | number> }>;
}

/** The field names __type reports for each object type. */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'url',
    'createdAt', 'updatedAt', 'closed', 'labels', 'comments',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'closed',
  ],
  Ref: ['name', 'prefix'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

/** The values __type reports for each enum type. */
const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function repoByDbId(forge: Forge, dbId: number): RepoRecord | undefined {
  for (const repo of forge.repos.values()) if (repo.dbId === dbId) return repo;
  return undefined;
}

function issueNode(repo: RepoRecord, issue: IssueRecord): GNode {
  return node('Issue', { repo, issue });
}

function pullNode(repo: RepoRecord, pull: PullRecord): GNode {
  return node('PullRequest', { repo, pull });
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: string): number | null {
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface PageSlice<T> {
  items: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Apply Relay-style first/after paging to a number-ordered list. */
function pageByCursor<T extends { number: number }>(list: T[], args: Record<string, unknown>): PageSlice<T> {
  let start = 0;
  if (typeof args.after === 'string') {
    const afterNumber = numberOfCursor(args.after);
    const index = afterNumber === null ? -1 : list.findIndex((entry) => entry.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : list.length;
  const items = list.slice(start, start + first);
  return {
    items,
    hasNextPage: start + first < list.length,
    endCursor: items.length > 0 ? cursorOf(items[items.length - 1]!.number) : null,
  };
}

function mergeableState(forge: Forge, repo: RepoRecord, pull: PullRecord): string {
  void forge;
  if (pull.merged) return 'MERGEABLE';
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const common = mergeBase(repo, baseTip, headTip);
  if (common === undefined) return 'UNKNOWN';
  return mergesCleanly(repo, baseTip, headTip, common) ? 'MERGEABLE' : 'CONFLICTING';
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (forge) => node('User', { login: forge.canonicalOwner }),
    repository: (forge, _parent, args) => {
      const repo = forge.lookupRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : node('Repository', repo);
    },
    node: (forge, _parent, args) => resolveGlobalNode(forge, String(args.id ?? '')),
  },
  Mutation: {
    createIssue: (forge, _parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByDbId(forge, Number(parsed.key)) : undefined;
      if (repo === undefined) throw new Error('repository not found');
      const issue = createIssue(forge, repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), labels: [] });
      return node('CreateIssuePayload', { issue: issueNode(repo, issue) });
    },
    closeIssue: (forge, _parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = findIssueByGlobalId(forge, String(input.issueId ?? ''));
      if (found === undefined) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.updatedAt = forge.clock.nextIso();
      return node('CloseIssuePayload', { issue: issueNode(found.repo, found.issue) });
    },
    createPullRequest: (forge, _parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.type === 'Repository' ? repoByDbId(forge, Number(parsed.key)) : undefined;
      if (repo === undefined) throw new Error('repository not found');
      const pull = createPull(forge, repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (pull === null) throw new Error('the head or base branch does not exist');
      return node('CreatePullRequestPayload', { pullRequest: pullNode(repo, pull) });
    },
    mergePullRequest: (forge, _parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = findPullByGlobalId(forge, String(input.pullRequestId ?? ''));
      if (found === undefined) throw new Error('pull request not found');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const result = mergePull(forge, found.repo, found.pull, method);
      if (!result.ok) throw new Error('pull request is not mergeable');
      return node('MergePullRequestPayload', { pullRequest: pullNode(found.repo, found.pull) });
    },
    addComment: (forge, _parent, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = findIssueByGlobalId(forge, String(input.subjectId ?? ''));
      if (found === undefined) throw new Error('subject not found');
      const comment = { id: forge.newCommentId(), body: String(input.body ?? '') };
      found.issue.comments.push(comment);
      const commentNode = node('IssueComment', { id: globalId('IssueComment', String(comment.id)), body: comment.body });
      return node('AddCommentPayload', { commentEdge: node('CommentEdge', { node: commentNode }) });
    },
  },
  User: {
    login: (_forge, parent) => (parent as { login: string }).login,
    id: () => globalId('User', '1000'),
    name: (_forge, parent) => (parent as { login: string }).login,
    url: (_forge, parent) => `https://forge.invalid/${(parent as { login: string }).login}`,
  },
  Repository: {
    id: (_forge, parent) => globalId('Repository', String((parent as RepoRecord).dbId)),
    databaseId: (_forge, parent) => (parent as RepoRecord).dbId,
    name: (_forge, parent) => (parent as RepoRecord).name,
    nameWithOwner: (forge, parent) => `${forge.canonicalOwner}/${(parent as RepoRecord).name}`,
    owner: (forge) => node('User', { login: forge.canonicalOwner }),
    description: (_forge, parent) => (parent as RepoRecord).description,
    isPrivate: (_forge, parent) => (parent as RepoRecord).isPrivate,
    defaultBranchRef: (_forge, parent) => node('Ref', { name: (parent as RepoRecord).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (forge, parent) => `https://forge.invalid/${forge.canonicalOwner}/${(parent as RepoRecord).name}`,
    createdAt: (_forge, parent) => (parent as RepoRecord).createdAt,
    updatedAt: (_forge, parent) => (parent as RepoRecord).createdAt,
    issue: (_forge, parent, args) => {
      const repo = parent as RepoRecord;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueNode(repo, issue);
    },
    pullRequest: (_forge, parent, args) => {
      const repo = parent as RepoRecord;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullNode(repo, pull);
    },
    issues: (_forge, parent, args) => {
      const repo = parent as RepoRecord;
      let list = [...repo.issues.values()];
      if (Array.isArray(args.states)) {
        const states = args.states.map((state) => String(state));
        list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
      const descending = orderBy !== null && orderBy.direction !== 'ASC';
      list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      const page = pageByCursor(list, args);
      return node('IssueConnection', {
        nodes: page.items.map((issue) => issueNode(repo, issue)),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        totalCount: list.length,
      });
    },
    pullRequests: (_forge, parent, args) => {
      const repo = parent as RepoRecord;
      let list = [...repo.pulls.values()];
      if (Array.isArray(args.states)) {
        const states = args.states.map((state) => String(state));
        list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      list.sort((a, b) => a.number - b.number);
      const page = pageByCursor(list, args);
      return node('PullRequestConnection', {
        nodes: page.items.map((pull) => pullNode(repo, pull)),
        pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        totalCount: list.length,
      });
    },
  },
  Issue: {
    id: (_forge, parent) => {
      const { repo, issue } = parent as { repo: RepoRecord; issue: IssueRecord };
      return globalId('Issue', `${repo.dbId}:${issue.number}`);
    },
    number: (_forge, parent) => (parent as { issue: IssueRecord }).issue.number,
    title: (_forge, parent) => (parent as { issue: IssueRecord }).issue.title,
    body: (_forge, parent) => (parent as { issue: IssueRecord }).issue.body,
    state: (_forge, parent) => (parent as { issue: IssueRecord }).issue.state.toUpperCase(),
    closed: (_forge, parent) => (parent as { issue: IssueRecord }).issue.state === 'closed',
    author: (forge) => node('User', { login: forge.canonicalOwner }),
    repository: (_forge, parent) => node('Repository', (parent as { repo: RepoRecord }).repo),
    url: (forge, parent) => {
      const { repo, issue } = parent as { repo: RepoRecord; issue: IssueRecord };
      return `https://forge.invalid/${forge.canonicalOwner}/${repo.name}/issues/${issue.number}`;
    },
    createdAt: (_forge, parent) => (parent as { issue: IssueRecord }).issue.createdAt,
    updatedAt: (_forge, parent) => (parent as { issue: IssueRecord }).issue.updatedAt,
    labels: (_forge, parent) => {
      const { repo, issue } = parent as { repo: RepoRecord; issue: IssueRecord };
      void repo;
      return node('LabelConnection', {
        nodes: issue.labels.map((name) => node('Label', { name })),
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: issue.labels.length,
      });
    },
    comments: (_forge, parent) => {
      const { issue } = parent as { issue: IssueRecord };
      return node('IssueCommentConnection', {
        nodes: issue.comments.map((comment) => node('IssueComment', { id: globalId('IssueComment', String(comment.id)), body: comment.body })),
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: issue.comments.length,
      });
    },
  },
  PullRequest: {
    id: (_forge, parent) => {
      const { repo, pull } = parent as { repo: RepoRecord; pull: PullRecord };
      return globalId('PullRequest', `${repo.dbId}:${pull.number}`);
    },
    number: (_forge, parent) => (parent as { pull: PullRecord }).pull.number,
    title: (_forge, parent) => (parent as { pull: PullRecord }).pull.title,
    body: (_forge, parent) => (parent as { pull: PullRecord }).pull.body,
    state: (_forge, parent) => {
      const pull = (parent as { pull: PullRecord }).pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_forge, parent) => (parent as { pull: PullRecord }).pull.merged,
    closed: (_forge, parent) => (parent as { pull: PullRecord }).pull.state === 'closed',
    mergeable: (forge, parent) => {
      const { repo, pull } = parent as { repo: RepoRecord; pull: PullRecord };
      return mergeableState(forge, repo, pull);
    },
    headRefName: (_forge, parent) => (parent as { pull: PullRecord }).pull.headRef,
    baseRefName: (_forge, parent) => (parent as { pull: PullRecord }).pull.baseRef,
    headRefOid: (_forge, parent) => {
      const { repo, pull } = parent as { repo: RepoRecord; pull: PullRecord };
      return branchTip(repo, pull.headRef) ?? pull.headSha;
    },
    baseRefOid: (_forge, parent) => {
      const { repo, pull } = parent as { repo: RepoRecord; pull: PullRecord };
      return branchTip(repo, pull.baseRef) ?? pull.baseSha;
    },
    author: (forge) => node('User', { login: forge.canonicalOwner }),
    createdAt: (_forge, parent) => (parent as { pull: PullRecord }).pull.createdAt,
    updatedAt: (_forge, parent) => (parent as { pull: PullRecord }).pull.updatedAt,
    files: (_forge, parent, args) => {
      const { repo, pull } = parent as { repo: RepoRecord; pull: PullRecord };
      const files = pullFiles(repo, pull);
      const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : files.length;
      return node('PullRequestChangedFileConnection', {
        nodes: files.slice(0, first).map((file) => node('PullRequestChangedFile', { path: file.filename })),
        pageInfo: { hasNextPage: first < files.length, endCursor: null },
        totalCount: files.length,
      });
    },
  },
  Ref: {
    name: (_forge, parent) => (parent as { name: string }).name,
    prefix: () => 'refs/heads/',
  },
  PageInfo: {
    hasNextPage: (_forge, parent) => (parent as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: () => false,
    endCursor: (_forge, parent) => (parent as { endCursor: string | null }).endCursor,
    startCursor: () => null,
  },
  IssueConnection: connectionResolvers(),
  PullRequestConnection: connectionResolvers(),
  PullRequestChangedFileConnection: connectionResolvers(),
  LabelConnection: connectionResolvers(),
  IssueCommentConnection: connectionResolvers(),
  Label: {
    name: (_forge, parent) => (parent as { name: string }).name,
  },
  PullRequestChangedFile: {
    path: (_forge, parent) => (parent as { path: string }).path,
  },
  IssueComment: {
    id: (_forge, parent) => (parent as { id: string }).id,
    body: (_forge, parent) => (parent as { body: string }).body,
    author: (forge) => node('User', { login: forge.canonicalOwner }),
    createdAt: (forge) => forge.clock.nextIso(),
  },
  CreateIssuePayload: { issue: (_forge, parent) => (parent as { issue: GNode }).issue, clientMutationId: () => null },
  CloseIssuePayload: { issue: (_forge, parent) => (parent as { issue: GNode }).issue, clientMutationId: () => null },
  CreatePullRequestPayload: { pullRequest: (_forge, parent) => (parent as { pullRequest: GNode }).pullRequest, clientMutationId: () => null },
  MergePullRequestPayload: { pullRequest: (_forge, parent) => (parent as { pullRequest: GNode }).pullRequest, clientMutationId: () => null },
  AddCommentPayload: { commentEdge: (_forge, parent) => (parent as { commentEdge: GNode }).commentEdge, clientMutationId: () => null },
  CommentEdge: { node: (_forge, parent) => (parent as { node: GNode }).node, cursor: () => null },
  __Type: {
    name: (_forge, parent) => (parent as { name: string }).name,
    kind: (_forge, parent) => {
      const name = (parent as { name: string }).name;
      return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
    },
    description: () => null,
    fields: (_forge, parent) => (TYPE_FIELDS[(parent as { name: string }).name] ?? []).map((name) => node('__Field', { name })),
    enumValues: (_forge, parent) => (ENUM_VALUES[(parent as { name: string }).name] ?? []).map((name) => node('__EnumValue', { name })),
  },
  __Field: { name: (_forge, parent) => (parent as { name: string }).name },
  __EnumValue: { name: (_forge, parent) => (parent as { name: string }).name },
  __Schema: {
    queryType: () => node('__Type', { name: 'Query' }),
    mutationType: () => node('__Type', { name: 'Mutation' }),
    types: () => [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => node('__Type', { name })),
  },
};

/** The resolvers every connection type shares. */
function connectionResolvers(): Record<string, Resolver> {
  return {
    nodes: (_forge, parent) => (parent as { nodes: GNode[] }).nodes,
    pageInfo: (_forge, parent) => node('PageInfo', (parent as { pageInfo: unknown }).pageInfo),
    totalCount: (_forge, parent) => (parent as { totalCount: number }).totalCount,
  };
}

/** Find an issue by its global id. */
function findIssueByGlobalId(forge: Forge, id: string): { repo: RepoRecord; issue: IssueRecord } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return undefined;
  const [dbId, number] = parsed.key.split(':').map(Number);
  const repo = dbId === undefined ? undefined : repoByDbId(forge, dbId);
  const issue = repo?.issues.get(number ?? -1);
  return repo !== undefined && issue !== undefined ? { repo, issue } : undefined;
}

/** Find a pull request by its global id. */
function findPullByGlobalId(forge: Forge, id: string): { repo: RepoRecord; pull: PullRecord } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return undefined;
  const [dbId, number] = parsed.key.split(':').map(Number);
  const repo = dbId === undefined ? undefined : repoByDbId(forge, dbId);
  const pull = repo?.pulls.get(number ?? -1);
  return repo !== undefined && pull !== undefined ? { repo, pull } : undefined;
}

/** Resolve any global id to its node (Query.node). */
function resolveGlobalNode(forge: Forge, id: string): GNode | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoByDbId(forge, Number(parsed.key));
    return repo === undefined ? null : node('Repository', repo);
  }
  if (parsed.type === 'Issue') {
    const found = findIssueByGlobalId(forge, id);
    return found === undefined ? null : issueNode(found.repo, found.issue);
  }
  if (parsed.type === 'PullRequest') {
    const found = findPullByGlobalId(forge, id);
    return found === undefined ? null : pullNode(found.repo, found.pull);
  }
  if (parsed.type === 'User') return node('User', { login: forge.canonicalOwner });
  return null;
}

/** Execute one selection set against a typed parent, collecting field errors. */
function executeSelections(ctx: ExecCtx, typeName: string, parent: unknown, selections: SelectionNode[], path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(ctx, typeName, parent, selection.selectionSet, path));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelections(ctx, typeName, parent, fragment, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (selection.name === '__type' && typeName === 'Query') {
      const args = materializeArgs(ctx, selection.args);
      const name = String(args.name ?? '');
      out[key] = TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined
        ? completeValue(ctx, node('__Type', { name }), selection, fieldPath)
        : null;
      continue;
    }
    if (selection.name === '__schema' && typeName === 'Query') {
      out[key] = completeValue(ctx, node('__Schema', {}), selection, fieldPath);
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const parentData = isNode(parent) ? parent.data : parent;
    let raw: unknown;
    try {
      raw = resolver(ctx.forge, parentData, materializeArgs(ctx, selection.args));
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, raw, selection, fieldPath);
  }
  return out;
}

/** Finish a resolved value: recurse into nodes with the field's selection set. */
function completeValue(ctx: ExecCtx, raw: unknown, selection: FieldNode, path: Array<string | number>): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((entry, index) => completeValue(ctx, entry, selection, [...path, index]));
  if (isNode(raw)) {
    if (selection.selectionSet === null) return {};
    return executeSelections(ctx, raw.__type, raw, selection.selectionSet, path);
  }
  return raw;
}

/** Materialize a field's arguments against the operation's variables. */
function materializeArgs(ctx: ExecCtx, args: Record<string, Value>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = materialize(value, ctx.variables, ctx.defaults);
  return out;
}

/** Run one operation document (one entry of a possibly batched request). */
function runOperation(forge: Forge, entry: Record<string, unknown>): Record<string, unknown> {
  const query = typeof entry.query === 'string' ? entry.query : '';
  if (query === '') return { errors: [{ message: 'a query document is required' }] };
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  const operation = operationName === null ? document.operations[0] : document.operations.find((op) => op.name === operationName);
  if (operation === undefined) return { errors: [{ message: 'operation not found' }] };
  const ctx: ExecCtx = {
    forge,
    variables: isRecord(entry.variables) ? entry.variables : {},
    defaults: operation.defaults,
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, node(rootType, null), operation.selectionSet, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one POST /api/graphql (a single operation or a batched array). */
export async function handleGraphql(forge: Forge, req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ errors: [{ message: 'Invalid JSON' }] }));
    return;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const results = entries.map((entry) => (isRecord(entry) ? runOperation(forge, entry) : { errors: [{ message: 'each operation must be an object' }] }));
  const body = Array.isArray(parsed) ? results : results[0];
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
  res.end(JSON.stringify(body));
}
