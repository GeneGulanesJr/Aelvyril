// sandboxd: the only part of Aelvyril that holds the Docker socket. It makes one locked-down container per project and
// does a few fixed things with it (run a command, read or write a file, start, stop, measure, show its web app). Callers
// can't choose the image, add host folders, privileges or networks: every container gets the same shape below.
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

const TOKEN = process.env.SANDBOXD_TOKEN ?? "";
const IMAGE = process.env.SANDBOX_IMAGE ?? "aelvyril-sandbox";
const NET = process.env.SANDBOX_NETWORK ?? "aelvyril-sandbox";
const CPUS = Number(process.env.SANDBOX_CPUS ?? 2);
const MEM = Number(process.env.SANDBOX_MEMORY_MB ?? 2048) * 1024 * 1024;
const SOCK = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const name = (id: string) => `aelv-sb-${id}`;

// ---------------------------------------------------------------- the Docker Engine API, over its socket
function docker(method: string, path: string, body?: unknown, raw?: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    const req = request({ socketPath: SOCK, method, path: `/v1.43${path}`, headers: data ? { "content-type": raw ? "application/x-tar" : "application/json", "content-length": data.length } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(data);
  });
}
const json = (b: Buffer) => JSON.parse(b.toString() || "null");
const ok = async (p: Promise<{ status: number; body: Buffer }>, what: string) => {
  const r = await p;
  if (r.status >= 300 && r.status !== 304) throw Object.assign(new Error(`${what}: ${json(r.body)?.message ?? r.status}`), { status: r.status });
  return r;
};

/** Docker's exec output: 8-byte frames [stream, 0,0,0, size32] then the bytes. Keeps their order, and stdout alone. */
export function demux(buf: Buffer) {
  const all: Buffer[] = [];
  const out: Buffer[] = [];
  for (let i = 0; i + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(i + 4);
    const part = buf.subarray(i + 8, i + 8 + size);
    all.push(part);
    if (buf[i] === 1) out.push(part);
    i += 8 + size;
  }
  return { all: Buffer.concat(all), stdout: Buffer.concat(out) };
}

/** A tar holding one file, owned by the sandbox's user (uid 1000). */
export function tarOne(fileName: string, data: Buffer) {
  const h = Buffer.alloc(512);
  const put = (s: string, at: number, len: number) => h.write(s.slice(0, len), at, "utf8");
  put(fileName, 0, 100);
  put("0000644\0", 100, 8);
  put("0001750\0", 108, 8);
  put("0001750\0", 116, 8);
  put(data.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad, Buffer.alloc(1024)]);
}

/** The first file in a tar. */
export function untarOne(tar: Buffer): Buffer {
  const size = parseInt(tar.subarray(124, 136).toString().replace(/\0.*$/, "").trim() || "0", 8);
  return tar.subarray(512, 512 + size);
}

// ---------------------------------------------------------------- what a sandbox can do
async function create(id: string) {
  await docker("POST", "/volumes/create", { Name: name(id), Labels: { "aelvyril.sandbox": id } });
  await ok(
    docker("POST", `/containers/create?name=${name(id)}`, {
      Image: IMAGE,
      Cmd: ["sleep", "infinity"],
      User: "1000:1000",
      WorkingDir: "/workspace",
      Labels: { "aelvyril.sandbox": id },
      HostConfig: {
        Init: true,
        NanoCpus: CPUS * 1e9,
        Memory: MEM,
        MemorySwap: MEM,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Mounts: [{ Type: "volume", Source: name(id), Target: "/workspace" }],
        NetworkMode: NET,
        // the internet yes; this computer's own services no (Docker Desktop would otherwise answer these names)
        ExtraHosts: ["host.docker.internal:127.0.0.1", "gateway.docker.internal:127.0.0.1", "kubernetes.docker.internal:127.0.0.1"],
      },
    }),
    "create",
  );
  await ok(docker("POST", `/containers/${name(id)}/start`), "start");
}

export async function exec(id: string, cmd: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutSec?: number } = {}) {
  const env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const full = opts.timeoutSec ? ["timeout", "-k", "5", String(Math.ceil(opts.timeoutSec)), ...cmd] : cmd;
  const made = json((await ok(docker("POST", `/containers/${name(id)}/exec`, { Cmd: full, AttachStdout: true, AttachStderr: true, WorkingDir: opts.cwd ?? "/workspace", Env: env }), "exec")).body);
  const res = await ok(docker("POST", `/exec/${made.Id}/start`, { Detach: false, Tty: false }), "exec");
  const info = json((await docker("GET", `/exec/${made.Id}/json`)).body);
  const { all, stdout } = demux(res.body);
  return { exitCode: info?.ExitCode ?? -1, out: all, stdout };
}

const disk = new Map<string, { at: number; bytes: number }>();
async function status(id: string) {
  const r = await docker("GET", `/containers/${name(id)}/json`);
  if (r.status === 404) return { state: "missing" };
  const c = json(r.body);
  if (!c.State?.Running) return { state: "stopped", disk: disk.get(id)?.bytes ?? null };
  const s = json((await docker("GET", `/containers/${name(id)}/stats?stream=false`)).body);
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage ?? 0);
  const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * (s.cpu_stats.online_cpus ?? 1) * 100 : 0;
  const memUsed = (s.memory_stats.usage ?? 0) - (s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0);
  const d = disk.get(id);
  if (!d || Date.now() - d.at > 60_000) {
    // measured at most once a minute: du over a big node_modules takes a moment
    const du = await exec(id, ["du", "-sxb", "/workspace"], { timeoutSec: 20 }).catch(() => null);
    const bytes = du ? Number(du.stdout.toString().split(/\s/)[0]) : NaN;
    if (Number.isFinite(bytes)) disk.set(id, { at: Date.now(), bytes });
  }
  return { state: "running", cpu: Math.round(cpu * 10) / 10, memUsed, memLimit: s.memory_stats.limit ?? MEM, cpus: CPUS, disk: disk.get(id)?.bytes ?? null, ip: c.NetworkSettings?.Networks?.[NET]?.IPAddress ?? "" };
}

async function writeFile(id: string, path: string, data: Buffer) {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash) || "/";
  await exec(id, ["mkdir", "-p", dir]);
  await ok(docker("PUT", `/containers/${name(id)}/archive?path=${encodeURIComponent(dir)}`, undefined, tarOne(path.slice(slash + 1), data)), "write");
}

async function readFile(id: string, path: string) {
  return untarOne((await ok(docker("GET", `/containers/${name(id)}/archive?path=${encodeURIComponent(path)}`), "read")).body);
}

/** The project's web app, as the person sees it in the preview: plain HTTP to the container, nothing else. */
async function preview(id: string, port: number, rest: string, req: IncomingMessage, res: ServerResponse) {
  const ip = json((await ok(docker("GET", `/containers/${name(id)}/json`), "preview")).body)?.NetworkSettings?.Networks?.[NET]?.IPAddress;
  if (!ip) throw Object.assign(new Error("the sandbox isn't running"), { status: 409 });
  const headers = { ...req.headers, host: `${ip}:${port}` };
  delete headers.authorization;
  delete headers.cookie;
  const up = request({ host: ip, port, method: req.method, path: rest, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("The app isn't answering on that port yet.");
  });
  req.pipe(up);
}

// ---------------------------------------------------------------- HTTP
const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > 200 * 1024 * 1024) req.destroy(new Error("too big"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const authed = (req: IncomingMessage) => {
  const sent = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return TOKEN.length >= 16 && sent.length === want.length && timingSafeEqual(sent, want);
};

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") return send(res, 200, { ok: true });
  if (!authed(req)) return send(res, 401, { error: "unauthorized" });
  const [, top, id, action, ...rest] = url.pathname.split("/");
  if (top !== "sandboxes" || !ID.test(id ?? "")) return send(res, 404, { error: "not found" });
  try {
    if (req.method === "POST" && !action) return await create(id), send(res, 201, await status(id));
    if (req.method === "GET" && !action) return send(res, 200, await status(id));
    if (req.method === "POST" && action === "start") return await ok(docker("POST", `/containers/${name(id)}/start`), "start"), send(res, 200, await status(id));
    if (req.method === "POST" && action === "stop") return await ok(docker("POST", `/containers/${name(id)}/stop?t=5`), "stop"), send(res, 200, await status(id));
    if (req.method === "DELETE" && !action) {
      await docker("DELETE", `/containers/${name(id)}?force=true`);
      await docker("DELETE", `/volumes/${name(id)}`);
      disk.delete(id);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && action === "exec") {
      const b = json(await readBody(req)) ?? {};
      if (!Array.isArray(b.cmd) || !b.cmd.length || !b.cmd.every((x: unknown) => typeof x === "string")) return send(res, 400, { error: "cmd must be a list of strings" });
      const r = await exec(id, b.cmd, { cwd: typeof b.cwd === "string" ? b.cwd : undefined, env: b.env && typeof b.env === "object" ? b.env : undefined, timeoutSec: Number(b.timeoutSec) || undefined });
      return send(res, 200, { exitCode: r.exitCode, out: r.out.toString("base64"), stdout: r.stdout.toString("base64") });
    }
    if (action === "file") {
      const path = url.searchParams.get("path") ?? "";
      if (!path.startsWith("/") || path.includes("\0")) return send(res, 400, { error: "path must be absolute" });
      if (req.method === "PUT") return await writeFile(id, path, await readBody(req)), send(res, 200, { ok: true });
      if (req.method === "GET") {
        const data = await readFile(id, path);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(data);
      }
    }
    if (action === "preview") {
      const port = Number(rest[0]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return send(res, 400, { error: "port must be 1024–65535" });
      return await preview(id, port, "/" + rest.slice(1).join("/") + url.search, req, res);
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    const err = e as Error & { status?: number };
    return send(res, err.status === 404 ? 404 : err.status === 409 ? 409 : 500, { error: err.message });
  }
}

if (import.meta.main) {
  if (TOKEN.length < 16) throw new Error("SANDBOXD_TOKEN must be set (16+ characters)");
  createServer((req, res) => void handle(req, res)).listen(Number(process.env.PORT ?? 7400), () => console.log("sandboxd listening"));
}
