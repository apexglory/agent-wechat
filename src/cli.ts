#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import cliProgress from "cli-progress";
import qrcode from "qrcode-terminal";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import http from "http";
import { execDocker, ensureDocker, DockerResult } from "./lib/docker";
import { getDefaultDataDir, ensureDir } from "./lib/paths";
import {
  loadConfig,
  saveConfig,
  ensureSession,
  saveSession,
  SessionConfig,
  AppConfig
} from "./lib/session";
import { downloadWeChatDeb, resolveWeChatArch } from "./lib/download";

interface ParsedArgs {
  args: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      if (value !== undefined) {
        flags[key] = value;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[i + 1];
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(arg);
    }
  }

  return { args, flags };
}

function printUsage(): void {
  console.log(`agent-wechat <command> [options]

Commands:
  session create <name>
  session list
  session use <name>
  config get-token
  config set-token <token>
  start [--session <name>]
  stop [--session <name>]
  status [--session <name>]
  login [--session <name>] [--watch] [--interval <sec>]
  login-qr [--session <name>] [--interval <sec>]
  a11y [--session <name>] [--scope chats|messages|buttons|full]
  screenshot [--session <name>] [--out <path>]
  poll chats [--session <name>]
  poll messages [--session <name>]
  download [--arch x64|arm64]
  doctor
  serve [--host <host>] [--port <port>]

Options:
  --data-dir <path>  Override data directory
  --image <name>     Docker image (default: ghcr.io/apexglory/agent-wechat2:latest)
  --arch <arch>      Download arch override (x64 or arm64)
  --token <token>    API token override for serve
`);
}

function getDataDir(flags: Record<string, string | boolean>): string {
  const override = flags["data-dir"];
  if (typeof override === "string") {
    return override;
  }
  return process.env.WECHAT_DATA_DIR || getDefaultDataDir();
}

function getDockerSocketPath(): string {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost && dockerHost.startsWith("unix://")) {
    return dockerHost.replace("unix://", "");
  }

  const colimaSocket = path.join(os.homedir(), ".colima", "default", "docker.sock");
  if (fs.existsSync(colimaSocket)) {
    return colimaSocket;
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), ".docker", "run", "docker.sock");
  }

  return "/var/run/docker.sock";
}

function runDoctor(): void {
  const socketPath = getDockerSocketPath();
  const socketExists = fs.existsSync(socketPath);
  const info = execDocker(["info"]);

  const report = {
    dockerBinary: true,
    dockerSocket: {
      path: socketPath,
      exists: socketExists
    },
    dockerInfo: {
      ok: info.exitCode === 0,
      stderr: info.exitCode === 0 ? undefined : info.stderr.trim()
    }
  };

  console.log(JSON.stringify(report, null, 2));
}

function getSessionName(flags: Record<string, string | boolean>, config: { defaultSession: string }): string {
  const flagValue = flags.session;
  if (typeof flagValue === "string") {
    return flagValue;
  }
  return config.defaultSession || "default";
}

function formatBytes(value: number): string {
  const mb = value / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}

async function downloadWithProgress(targetPath: string, archInput?: string): Promise<void> {
  const resolved = resolveWeChatArch(archInput);
  const bar = new cliProgress.SingleBar(
    {
      format: "downloading [{bar}] {percentage}% | {valueMB}/{totalMB}",
      hideCursor: true,
      clearOnComplete: true
    },
    cliProgress.Presets.shades_classic
  );

  let barStarted = false;
  let lastLog = 0;

  await downloadWeChatDeb(targetPath, resolved, (received, total) => {
    if (total && total > 0) {
      if (!barStarted) {
        bar.start(total, received, {
          valueMB: formatBytes(received),
          totalMB: formatBytes(total)
        });
        barStarted = true;
      } else {
        bar.update(received, {
          valueMB: formatBytes(received),
          totalMB: formatBytes(total)
        });
      }
    } else {
      const now = Date.now();
      if (now - lastLog > 1000) {
        console.log(`downloading: ${formatBytes(received)}`);
        lastLog = now;
      }
    }
  });

  if (barStarted) {
    bar.stop();
  }
}

async function dockerBuild(image: string, flags: Record<string, string | boolean>): Promise<void> {
  const debPath = path.join(process.cwd(), "docker", "wechat.deb");
  if (!fs.existsSync(debPath)) {
    const archInput = typeof flags.arch === "string" ? flags.arch : undefined;
    console.log(`wechat.deb missing; downloading for ${resolveWeChatArch(archInput)}...`);
    await downloadWithProgress(debPath, archInput);
    console.log(`downloaded to ${debPath}`);
  }
  const result = execDocker([
    "build",
    "-t",
    image,
    "-f",
    path.join("docker", "Dockerfile"),
    "docker"
  ], { stdio: "inherit" });

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

function resolveLocalArchTag(): string {
  const arch = resolveWeChatArch();
  const suffix = arch === "x64" ? "amd64" : "arm64";
  return `agent-wechat:${suffix}`;
}

function dockerImageExists(image: string): boolean {
  const result = execDocker(["image", "inspect", image]);
  return result.exitCode === 0;
}

function resolveStartImage(session: SessionConfig, flags: Record<string, string | boolean>): string {
  const override = flags.image;
  if (typeof override === "string") {
    return override;
  }

  const localArchTag = resolveLocalArchTag();
  const localExists = dockerImageExists(localArchTag);
  if (localExists) {
    return localArchTag;
  }

  return session.image;
}

function tryPullImage(image: string): void {
  const result = execDocker(["pull", image], { stdio: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`failed to pull image ${image}`);
  }
}

function containerExists(containerName: string): boolean {
  const result = execDocker([
    "ps",
    "-a",
    "-q",
    "--filter",
    `name=^/${containerName}$`
  ]);

  return result.stdout.trim().length > 0;
}

function containerRunning(containerName: string): boolean {
  const result = execDocker([
    "ps",
    "-q",
    "--filter",
    `name=^/${containerName}$`
  ]);

  return result.stdout.trim().length > 0;
}

async function startContainer(session: SessionConfig, image: string, build: boolean, flags: Record<string, string | boolean>): Promise<void> {
  ensureDocker();

  if (build) {
    await dockerBuild(image, flags);
  }

  if (!containerExists(session.containerName) && !dockerImageExists(image)) {
    try {
      tryPullImage(image);
    } catch (error) {
      console.error(String(error));
      console.error("image not found locally. build it with `pnpm run build:image:local` or pass --image.");
      process.exit(1);
    }
  }

  if (containerExists(session.containerName)) {
    const result = execDocker(["start", session.containerName], { stdio: "inherit" });
    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
    return;
  }

  const args = [
    "run",
    "-d",
    "--name",
    session.containerName,
    "--shm-size=1g",
    "-e",
    "DISPLAY=:99",
    "-e",
    "QT_ACCESSIBILITY=1",
    "-e",
    "QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1",
    "-e",
    "GTK_MODULES=gail:atk-bridge",
    "-v",
    `${session.downloadsDir}:/home/wechat/Downloads`,
    "-v",
    `${session.wechatConfigDir}:/home/wechat/.config/wechat`,
    "-v",
    `${session.wechatDataDir}:/home/wechat/.local/share/wechat`,
    image
  ];

  const result = execDocker(args, { stdio: "inherit" });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

function stopContainer(session: SessionConfig): void {
  if (!containerExists(session.containerName)) {
    console.log("container not found");
    return;
  }

  const result = execDocker(["stop", session.containerName], { stdio: "inherit" });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

function dockerExec(session: SessionConfig, command: string[]): DockerResult {
  return execDocker([
    "exec",
    "-e",
    "DISPLAY=:99",
    session.containerName,
    ...command
  ]);
}

function dockerCopyFrom(session: SessionConfig, containerPath: string, hostPath: string): DockerResult {
  ensureDir(path.dirname(hostPath));
  return execDocker([
    "cp",
    `${session.containerName}:${containerPath}`,
    hostPath
  ]);
}

function runA11ySnapshot(session: SessionConfig, scope: string): string {
  const result = dockerExec(session, [
    "python3",
    "/opt/agent-wechat/bin/a11y_dump.py",
    "--scope",
    scope,
    "--format",
    "json"
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }

  return result.stdout.trim();
}

function getLoginStatus(session: SessionConfig): { loggedIn: boolean; error?: string } {
  const result = dockerExec(session, [
    "python3",
    "/opt/agent-wechat/bin/a11y_dump.py",
    "--probe",
    "--format",
    "json"
  ]);

  if (result.exitCode !== 0) {
    return { loggedIn: false, error: result.stderr || result.stdout };
  }

  try {
    return JSON.parse(result.stdout.trim()) as { loggedIn: boolean };
  } catch {
    return { loggedIn: false, error: "invalid probe output" };
  }
}

function captureScreenshot(session: SessionConfig, hostPath: string): string {
  const containerPath = "/tmp/agent-wechat.png";
  ensureDir(path.dirname(hostPath));

  const shot = dockerExec(session, ["scrot", "-o", containerPath]);
  if (shot.exitCode !== 0) {
    throw new Error(shot.stderr || shot.stdout);
  }

  const copy = dockerCopyFrom(session, containerPath, hostPath);
  if (copy.exitCode !== 0) {
    throw new Error(copy.stderr || copy.stdout);
  }

  return hostPath;
}

function captureQrData(session: SessionConfig): string | null {
  const containerPath = "/tmp/agent-wechat-qr.png";
  const hostPath = path.join(os.tmpdir(), `agent-wechat-qr-${session.name}.png`);
  const shot = dockerExec(session, ["scrot", "-o", containerPath]);
  if (shot.exitCode !== 0) {
    throw new Error(shot.stderr || shot.stdout);
  }

  const copy = dockerCopyFrom(session, containerPath, hostPath);
  if (copy.exitCode !== 0) {
    throw new Error(copy.stderr || copy.stdout);
  }

  return decodeQrFromPng(hostPath);
}

function printQrToTerminal(qrData: string): void {
  console.log("Scan this QR with WeChat:");
  qrcode.generate(qrData, { small: true });
}

function decodeQrFromPng(filePath: string): string | null {
  const buffer = fs.readFileSync(filePath);
  const png = PNG.sync.read(buffer);
  const data = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  const result = jsQR(data, png.width, png.height);
  return result?.data ?? null;
}

function resolveScreenshotPath(flags: Record<string, string | boolean>): string {
  const fileName = `screenshot-${Date.now()}.png`;
  const outFlag = flags.out;

  if (typeof outFlag === "string") {
    const resolved = path.resolve(outFlag);
    const hasTrailingSep = /[\\/]+$/.test(outFlag);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return path.join(resolved, fileName);
      }
    }
    if (hasTrailingSep) {
      return path.join(resolved, fileName);
    }
    return resolved;
  }

  return path.join(os.tmpdir(), fileName);
}

function fileHash(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function ensureSessionPersisted(dataDir: string, sessionName: string, flags: Record<string, string | boolean>): SessionConfig {
  const session = ensureSession(dataDir, sessionName, {
    image: typeof flags.image === "string" ? flags.image : undefined
  });
  session.dataRoot = dataDir;
  saveSession(dataDir, sessionName, session);
  return session;
}

function resolveApiToken(config: AppConfig, flags: Record<string, string | boolean>, dataDir: string): string {
  const tokenFlag = flags.token;
  if (typeof tokenFlag === "string" && tokenFlag.trim()) {
    return tokenFlag.trim();
  }

  if (process.env.AGENT_WECHAT_TOKEN) {
    return process.env.AGENT_WECHAT_TOKEN;
  }

  if (config.apiToken) {
    return config.apiToken;
  }

  const token = crypto.randomBytes(24).toString("hex");
  config.apiToken = token;
  saveConfig(dataDir, config);
  return token;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

async function startServer(dataDir: string, config: AppConfig, flags: Record<string, string | boolean>): Promise<void> {
  const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";
  const port = Number(flags.port || 6174);
  const token = resolveApiToken(config, flags, dataDir);

  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const url = new URL(req.url || "/", `http://${host}:${port}`);
    const sessionName = url.searchParams.get("session") || config.defaultSession || "default";
    const session = ensureSessionPersisted(dataDir, sessionName, {});

    if (req.method === "GET" && url.pathname === "/v1/health") {
      sendJson(res, 200, { ok: true, version: "v1" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/status") {
      const running = containerRunning(session.containerName);
      const status: { session: string; container: string; loggedIn: boolean; error?: string } = {
        session: session.name,
        container: running ? "running" : "stopped",
        loggedIn: false
      };

      if (running) {
        const login = getLoginStatus(session);
        status.loggedIn = Boolean(login.loggedIn);
        if (login.error) {
          status.error = login.error;
        }
      }

      sendJson(res, 200, status);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/a11y") {
      const body = await readJsonBody(req);
      const scope = typeof body.scope === "string" ? body.scope : "chats";
      const output = runA11ySnapshot(session, scope);
      sendJson(res, 200, { scope, data: JSON.parse(output) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/screenshot") {
      const body = await readJsonBody(req);
      const out = typeof body.out === "string" ? body.out : undefined;
      const hostPath = out ? path.resolve(out) : resolveScreenshotPath({});
      const shot = captureScreenshot(session, hostPath);
      sendJson(res, 200, { path: shot });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/qr") {
      const qr = captureQrData(session);
      sendJson(res, 200, { qr });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/qr/stream") {
      const intervalSeconds = Number(url.searchParams.get("interval") || 5);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write("\n");

      let lastQr: string | null = null;
      const interval = setInterval(() => {
        try {
          const current = captureQrData(session);
          if (!current) {
            res.write(`event: done\ndata: {}\n\n`);
            clearInterval(interval);
            res.end();
            return;
          }
          if (current !== lastQr) {
            lastQr = current;
            res.write(`event: qr\ndata: ${JSON.stringify({ qr: current })}\n\n`);
          }
        } catch (error) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`);
          clearInterval(interval);
          res.end();
        }
      }, intervalSeconds * 1000);

      req.on("close", () => {
        clearInterval(interval);
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  server.listen(port, host, () => {
    console.log(`agent-wechat server listening on http://${host}:${port}`);
    console.log(`auth token: ${token}`);
  });
}

async function main(): Promise<void> {
  const { args, flags } = parseArgs(process.argv.slice(2));

  if (args.length === 0) {
    printUsage();
    return;
  }

  const command = args[0];
  const subcommand = args[1];

  if (command === "doctor") {
    runDoctor();
    return;
  }

  const dataDir = getDataDir(flags);
  ensureDir(dataDir);
  const config = loadConfig(dataDir);
  const sessionName = getSessionName(flags, config);

  if (command === "session") {
    if (subcommand === "create") {
      const name = args[2];
      if (!name) {
        console.error("session name required");
        process.exit(1);
      }
      const session = ensureSessionPersisted(dataDir, name, flags);
      console.log(`session created: ${session.name}`);
      return;
    }

    if (subcommand === "list") {
      const sessionsDir = path.join(dataDir, "sessions");
      if (!fs.existsSync(sessionsDir)) {
        console.log("no sessions");
        return;
      }
      const names = fs.readdirSync(sessionsDir).filter((entry) => fs.statSync(path.join(sessionsDir, entry)).isDirectory());
      if (names.length === 0) {
        console.log("no sessions");
        return;
      }
      names.forEach((name) => console.log(name));
      return;
    }

    if (subcommand === "use") {
      const name = args[2];
      if (!name) {
        console.error("session name required");
        process.exit(1);
      }
      config.defaultSession = name;
      saveConfig(dataDir, config);
      console.log(`default session set to ${name}`);
      return;
    }

    printUsage();
    return;
  }

  if (command === "config") {
    if (subcommand === "get-token") {
      const token = resolveApiToken(config, flags, dataDir);
      console.log(token);
      return;
    }

    if (subcommand === "set-token") {
      const token = args[2];
      if (!token) {
        console.error("token required");
        process.exit(1);
      }
      config.apiToken = token;
      saveConfig(dataDir, config);
      console.log("token saved");
      return;
    }

    printUsage();
    return;
  }

  if (command === "serve") {
    await startServer(dataDir, config, flags);
    return;
  }

  const session = ensureSessionPersisted(dataDir, sessionName, flags);

  if (command === "start") {
    const image = resolveStartImage(session, flags);
    await startContainer(session, image, flags.build === true || flags.build === "true", flags);
    console.log(`started container ${session.containerName}`);
    return;
  }

  if (command === "stop") {
    stopContainer(session);
    return;
  }

  if (command === "status") {
    const running = containerRunning(session.containerName);
    const status: { session: string; container: string; loggedIn: boolean; error?: string } = {
      session: session.name,
      container: running ? "running" : "stopped",
      loggedIn: false
    };

    if (running) {
      const login = getLoginStatus(session);
      status.loggedIn = Boolean(login.loggedIn);
      if (login.error) {
        status.error = login.error;
      }
    }

    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (command === "login") {
    if (!containerRunning(session.containerName)) {
      console.error("container not running");
      process.exit(1);
    }

    const intervalSeconds = Number(flags.interval || 5);

    const tick = (): { qrPath: string; hash: string } | true => {
      const login = getLoginStatus(session);
      if (login.loggedIn) {
        console.log("logged in");
        return true;
      }

      const qrPath = path.join(session.dataDir, "qr.png");
      const shot = dockerExec(session, ["scrot", "-o", "/tmp/agent-wechat-qr.png"]);
      if (shot.exitCode !== 0) {
        console.error(shot.stderr || shot.stdout);
        return true;
      }

      const copy = dockerCopyFrom(session, "/tmp/agent-wechat-qr.png", qrPath);
      if (copy.exitCode !== 0) {
        console.error(copy.stderr || copy.stdout);
        return true;
      }

      const hash = fileHash(qrPath);
      return { qrPath, hash };
    };

    let lastHash: string | null = null;
    const result = tick();
    if (result === true) {
      return;
    }

    if (result && result.qrPath) {
      lastHash = result.hash;
      console.log(`qr: ${result.qrPath}`);
    }

    if (!flags.watch) {
      return;
    }

    const loop = (): void => {
      const res = tick();
      if (res === true) {
        return;
      }
      if (res && res.hash && res.hash !== lastHash) {
        lastHash = res.hash;
        console.log(`qr updated: ${res.qrPath}`);
      }
      setTimeout(loop, intervalSeconds * 1000);
    };

    setTimeout(loop, intervalSeconds * 1000);
    return;
  }

  if (command === "login-qr") {
    if (!containerRunning(session.containerName)) {
      console.error("container not running");
      process.exit(1);
    }

    const intervalSeconds = Number(flags.interval || 5);
    const firstQr = captureQrData(session);

    if (!firstQr) {
      console.error("qr code not found");
      process.exit(1);
    }

    printQrToTerminal(firstQr);
    let lastQr = firstQr;

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
      const currentQr = captureQrData(session);

      if (!currentQr) {
        return;
      }

      if (currentQr !== lastQr) {
        lastQr = currentQr;
        printQrToTerminal(currentQr);
      }
    }
  }

  if (command === "a11y") {
    const scope = typeof flags.scope === "string" ? flags.scope : "chats";
    const output = runA11ySnapshot(session, scope);
    console.log(output);
    return;
  }

  if (command === "screenshot") {
    const hostPath = resolveScreenshotPath(flags);
    const shot = captureScreenshot(session, hostPath);
    console.log(shot);
    return;
  }

  if (command === "poll") {
    if (subcommand === "chats") {
      const output = runA11ySnapshot(session, "chats");
      console.log(output);
      return;
    }

    if (subcommand === "messages") {
      const output = runA11ySnapshot(session, "messages");
      console.log(output);
      return;
    }

    printUsage();
    return;
  }

  if (command === "download") {
    const debPath = path.join(process.cwd(), "docker", "wechat.deb");
    const archInput = typeof flags.arch === "string" ? flags.arch : undefined;
    await downloadWithProgress(debPath, archInput);
    console.log(`downloaded to ${debPath}`);
    return;
  }

  printUsage();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
