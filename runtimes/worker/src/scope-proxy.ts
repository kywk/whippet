import { Agent, createServer, request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { AIOriginGate } from "./author/scope.js";
import { deploymentHeadersMatch, type RetestTarget } from "./deployment-retest.js";
import type { WorkspaceConfig } from "./workspace-context.js";

const loopback = "127.0.0.1";
const denied = "scope_confirmation_required";
const idleTimeout = 60_000;
const hopByHop = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionHeaders = headers.connection?.toLowerCase().split(",").map(name => name.trim()) ?? [];
  for (const name of [...hopByHop, ...connectionHeaders]) delete result[name];
  return result;
}

function host(target: URL): string {
  return target.hostname.replace(/^\[|\]$/g, "");
}

function endSocket(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

// Only this process can open an upstream socket. Absolute URLs and CONNECT
// authorities are validated before lookup, and redirects are returned to the
// client so each subsequent destination goes through the same checks.
export async function startScopeProxy(scope: WorkspaceConfig, retest?: RetestTarget) {
  const gate = new AIOriginGate(scope);
  const agent = new Agent({ maxSockets: 32 });
  const sockets = new Set<Socket>();
  const tunnels = new WeakMap<Duplex, URL>();
  const targetOrigin = scope.targets.length === 1 ? scope.targets[0]?.origin : undefined;
  let reachedTarget = false;
  let consistentDeployment = true;
  let receivedDeploymentTraffic = false;
  function track(socket: Socket) {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(idleTimeout, () => socket.destroy());
  }

  function httpTarget(req: IncomingMessage): URL | undefined {
    try {
      const tunnel = tunnels.get(req.socket);
      const url = req.url ?? "";
      if (tunnel ? !url.startsWith("/") || url.startsWith("//") : !/^http:\/\//i.test(url)) return;
      const target = new URL(url, tunnel);
      if (target.protocol === "http:" && !gate.check(target.href, "transport") &&
          (!tunnel || tunnel.origin === target.origin) && !target.hash) return target;
    } catch { /* Reject invalid URLs. */ }
  }

  const server = createServer((incoming, outgoing) => {
    const target = httpTarget(incoming);
    if (!target || incoming.method === "CONNECT") {
      outgoing.writeHead(403, { connection: "close" }).end(denied);
      return;
    }
    const headers = forwardHeaders(incoming.headers);
    headers.host = target.host;
    const upstream = request(target, { agent, method: incoming.method, headers }, response => {
      if (target.origin === retest?.origin) {
        receivedDeploymentTraffic = true;
        consistentDeployment &&= response.statusCode !== undefined && response.statusCode < 500 &&
          deploymentHeadersMatch(retest, response.headers["x-whippet-deployment-id"], response.headers["x-whippet-artifact-revision"]);
      }
      if (target.origin === targetOrigin && response.statusCode && response.statusCode < 500) reachedTarget = true;
      outgoing.writeHead(response.statusCode ?? 502, forwardHeaders(response.headers));
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.setTimeout(idleTimeout, () => upstream.destroy());
    upstream.on("error", () => {
      if (target.origin === retest?.origin) consistentDeployment = false;
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502, { connection: "close" }).end();
    });
    outgoing.once("close", () => { if (!outgoing.writableFinished) upstream.destroy(); });
    incoming.pipe(upstream);
  });
  server.headersTimeout = 10_000;

  server.on("upgrade", (incoming, socket, head) => {
    const target = httpTarget(incoming);
    if (!target || incoming.method !== "GET" || incoming.headers.upgrade?.toLowerCase() !== "websocket") {
      endSocket(socket, 403, "Forbidden");
      return;
    }
    if (target.origin === retest?.origin) consistentDeployment = false;
    const headers = { ...forwardHeaders(incoming.headers), host: target.host, connection: "Upgrade", upgrade: "websocket" };
    const upstream = request(target, { agent, headers });
    upstream.on("upgrade", (response, peer, pending) => {
      track(peer);
      const lines = response.rawHeaders.flatMap((key, i, all) => i % 2 === 0 ? [`${key}: ${all[i + 1]}`] : []);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (pending.length) socket.write(pending);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
      socket.once("close", () => peer.destroy());
      peer.once("close", () => socket.destroy());
    });
    upstream.setTimeout(idleTimeout, () => upstream.destroy());
    upstream.on("response", response => { response.resume(); endSocket(socket, 502, "Bad Gateway"); });
    upstream.on("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.end();
  });

  server.on("connect", (incoming, socket, head) => {
    const authority = incoming.url ?? "";
    if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):[0-9]{1,5}$/i.test(authority) || tunnels.has(socket)) {
      endSocket(socket, 403, "Forbidden");
      return;
    }
    let plain: URL;
    let secure: URL;
    try {
      plain = new URL(`http://${authority}`);
      secure = new URL(`https://${authority}`);
    } catch {
      endSocket(socket, 403, "Forbidden");
      return;
    }
    const allowPlain = !gate.check(plain.href, "transport");
    const allowSecure = !gate.check(secure.href, "transport");
    if (!allowPlain && !allowSecure) {
      endSocket(socket, 403, "Forbidden");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const route = (first: Buffer) => {
      if (first[0] !== 0x16) {
        if (!allowPlain) { socket.destroy(); return; }
        socket.pause();
        tunnels.set(socket, plain);
        socket.unshift(first);
        server.emit("connection", socket);
        socket.resume();
        return;
      }
      if (!allowSecure) { socket.destroy(); return; }
      const upstream = connect({ host: host(secure), port: Number(secure.port || 443) });
      track(upstream);
      if (secure.origin === targetOrigin) upstream.once("data", () => { reachedTarget = true; });
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
      upstream.write(first);
      socket.pipe(upstream).pipe(socket);
    };
    if (head.length) route(head);
    else socket.once("data", route);
  });

  server.on("connection", track);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, loopback, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://${loopback}:${port}`,
    verifiedDeploymentTraffic: () => receivedDeploymentTraffic && consistentDeployment,
    reachedTargetOrigin: () => reachedTarget ? targetOrigin : undefined,
    async close() {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
