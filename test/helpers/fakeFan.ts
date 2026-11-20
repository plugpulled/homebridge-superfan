import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

export type Responder = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

export interface FakeFan {
  host: string;
  requests: RecordedRequest[];
  respond: Responder;
  close(): Promise<void>;
}

/** Local HTTP server standing in for a fan. `respond` can be swapped per test. */
export async function startFakeFan(respond: Responder = (_req, res) => json(res, 200, { relays: [0, 0] })): Promise<FakeFan> {
  const fake: FakeFan = {
    host: '',
    requests: [],
    respond,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
      };
      fake.requests.push(recorded);
      void fake.respond(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}
