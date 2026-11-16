// The HTTP server: one listener routing the four surfaces (git smart HTTP,
// REST v3, GraphQL, MCP) plus the health probe. Authentication is decided
// here, once: every surface but /healthz requires the trial's bearer token,
// and a repository the token does not own is a 404 inside the surfaces.

import { createServer, type Server } from 'node:http';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { Forge } from './store.ts';
import { decodeSegment, sendJson } from './util.ts';

/** Build the forge's HTTP server (it binds nothing until the caller listens). */
export function createApp(forge: Forge, token: string): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const requestId = forge.nextRequestId();
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
        if (segments.length === 1 && segments[0] === 'healthz' && req.method === 'GET') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }
        const authorization = req.headers.authorization ?? '';
        if (token === '' || authorization !== `Bearer ${token}`) {
          req.resume(); // drain any body so the connection stays reusable
          sendJson(res, 401, { message: 'Bad credentials' }, requestId);
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'v3') {
          await handleRest(forge, req, res, segments, url.searchParams, requestId);
          return;
        }
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (req.method !== 'POST') {
            req.resume();
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
            return;
          }
          await handleGraphql(forge, req, res, requestId);
          return;
        }
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (req.method !== 'POST') {
            req.resume();
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
            return;
          }
          await handleMcp(forge, req, res, requestId);
          return;
        }
        if (await handleGit(forge, req, res, segments, url.searchParams)) return;
        req.resume();
        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        console.error('request failed:', err);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Error' }, requestId);
        else res.end();
      }
    })();
  });
  return server;
}
