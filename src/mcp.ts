// The MCP surface at /mcp: JSON-RPC 2.0 over streamable HTTP. It speaks the
// current revision's server/discover (no handshake) and the older initialize
// handshake, and its six tools act on the same store as the REST surface, so
// an object made through a tool is the same object everywhere else.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './domain.ts';
import type { Forge, RepoRecord } from './store.ts';
import { isRecord, readBody, stringField } from './util.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required };
}

const STRING = { type: 'string' };

/** The tool list: built once, so two tools/list answers are byte-identical. */
const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema({ name: STRING, description: STRING, private: { type: 'boolean' } }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List a repository’s issues, optionally filtered by state (open, closed, all).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, pull_number: { type: 'number' } }, ['owner', 'repo', 'pull_number']),
  },
];

interface RpcError {
  code: number;
  message: string;
}

function toolResult(view: unknown, structured: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(view) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run one tool against the store; a string return is a tool-level failure message. */
function runTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | string {
  const repoOf = (): RepoRecord | string => {
    const repo = forge.lookupRepo(stringField(args, 'owner'), stringField(args, 'repo'));
    return repo === undefined ? 'repository not found' : repo;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = stringField(args, 'name');
      if (repoName === '') return 'a repository name is required';
      const existing = forge.repos.get(repoName);
      if (existing !== undefined) return toolResult(repoJson(forge, existing), repoJson(forge, existing));
      const repo = forge.createRepo(repoName, stringField(args, 'description'), args.private === true);
      if (repo === null) return 'could not create the repository';
      const view = repoJson(forge, repo);
      return toolResult(view, view);
    }
    case 'get_repo': {
      const repo = repoOf();
      if (typeof repo === 'string') return repo;
      const view = repoJson(forge, repo);
      return toolResult(view, view);
    }
    case 'create_issue': {
      const repo = repoOf();
      if (typeof repo === 'string') return repo;
      const issue = createIssue(forge, repo, { title: stringField(args, 'title'), body: stringField(args, 'body'), labels: [] });
      const view = issueJson(forge, repo, issue);
      return toolResult(view, view);
    }
    case 'list_issues': {
      const repo = repoOf();
      if (typeof repo === 'string') return repo;
      const state = stringField(args, 'state');
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      const views = issues.map((issue) => issueJson(forge, repo, issue));
      return toolResult(views, { issues: views });
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (typeof repo === 'string') return repo;
      const pull = createPull(forge, repo, {
        title: stringField(args, 'title'),
        body: stringField(args, 'body'),
        head: stringField(args, 'head'),
        base: stringField(args, 'base'),
      });
      if (pull === null) return 'the head or base branch does not exist';
      const view = pullJson(forge, repo, pull);
      return toolResult(view, view);
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (typeof repo === 'string') return repo;
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return 'pull request not found';
      const result = mergePull(forge, repo, pull, 'squash');
      if (!result.ok) return 'pull request is not mergeable';
      const view = pullJson(forge, repo, pull);
      return toolResult(view, view);
    }
    default:
      return 'unknown tool';
  }
}

/** Answer one JSON-RPC request object; null when it is a notification (no answer owed). */
function dispatch(forge: Forge, message: Record<string, unknown>, res: ServerResponse): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  if (id === undefined) return null; // a notification
  const params = isRecord(message.params) ? message.params : {};
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const fail = (error: RpcError): Record<string, unknown> => ({ jsonrpc: '2.0', id, error });
  switch (method) {
    case 'server/discover':
      return ok({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      res.setHeader('mcp-session-id', 'forge-session');
      return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) return fail({ code: -32602, message: `unknown tool: ${toolName}` });
      const args = isRecord(params.arguments) ? params.arguments : {};
      const schema = tool.inputSchema as { required?: unknown };
      const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
      for (const key of required) {
        if (args[key] === undefined || args[key] === null || args[key] === '') {
          return fail({ code: -32602, message: `missing required argument: ${key}` });
        }
      }
      const outcome = runTool(forge, toolName, args);
      return ok(typeof outcome === 'string' ? toolFailure(outcome) : outcome);
    }
    default:
      return fail({ code: -32601, message: `method not found: ${method}` });
  }
}

/** Handle one POST /mcp. */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
    return;
  }
  const answer = dispatch(forge, parsed, res);
  if (answer === null) {
    res.writeHead(202, { 'x-github-request-id': requestId, 'content-length': 0 });
    res.end();
    return;
  }
  const text = JSON.stringify(answer);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
