# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ndhhrnll-sys/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ndhhrnll-sys/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard library only: git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API, GraphQL v4 and an MCP endpoint, all over its own object store. Local conformance against the competition suite: 120/120.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=keh3491z&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

---

A single-process forge implementing the surfaces the suite drives, in Node
TypeScript with the standard library only — no dependencies, no git binary:
git objects and packs are implemented in `src/gitobj.ts` over `node:crypto`
and `node:zlib`.

- `main.ts` — the trial lifecycle: bind an ephemeral port, POST it to
  `$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`, exit 0.
- `src/server.ts` — one HTTP listener, the bearer-token check, and routing.
- `src/git.ts` — git smart HTTP at `/{owner}/{repo}.git`: reference
  advertisement, protocol v2 `ls-refs` and `fetch` (full, incremental and
  shallow), a protocol v0 fetch fallback, and `git-receive-pack` pushes with
  report-status and fast-forward enforcement.
- `src/rest.ts` — REST v3 under `/api/v3`: repositories, branches, commits,
  contents (with sha conflicts), labels, issues, comments, pull requests and
  squash merges.
- `src/graphql.ts` — the GraphQL v4 subset at `/api/graphql`: a small
  document parser and a schema-table executor with Relay-style global ids,
  connections with cursor paging, introspection, mutations and batching.
- `src/mcp.ts` — MCP at `/mcp`: `server/discover`, the legacy `initialize`
  handshake, and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) over the same
  store.
- `src/store.ts`, `src/domain.ts`, `src/merge.ts` — the shared state and the
  operations every surface uses, so an object created through one surface is
  the same object through all of them.

State is in memory and deterministic: timestamps come from a counter over
the trial's opening instant, never from the wall clock.

## Development

The kit's own suite is the test: point `sdk/run.ts` at a locally started
forge (a stub env that serves `/register` and `/done` is enough for the
lifecycle in `main.ts`), or grade the whole trial the way the server does:

```
node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process
```

The forge also speaks to a real git client: create a repository over REST,
then `git clone` / `git push` against `/{owner}/{repo}.git` with the bearer
token in an `http.extraHeader`.
