import fs from "fs";
import path from "path";
import { ensureDir } from "./paths";

export interface SessionConfig {
  name: string;
  containerName: string;
  image: string;
  dataDir: string;
  downloadsDir: string;
  wechatConfigDir: string;
  wechatDataDir: string;
  dataRoot?: string;
}

export interface AppConfig {
  defaultSession: string;
  apiToken?: string;
}

export function getConfigPath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

export function loadConfig(dataDir: string): AppConfig {
  const configPath = getConfigPath(dataDir);
  if (!fs.existsSync(configPath)) {
    return { defaultSession: "default" };
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw) as AppConfig;
  } catch {
    return { defaultSession: "default" };
  }
}

export function saveConfig(dataDir: string, config: AppConfig): void {
  ensureDir(dataDir);
  fs.writeFileSync(getConfigPath(dataDir), JSON.stringify(config, null, 2));
}

export function getSessionDir(dataDir: string, sessionName: string): string {
  return path.join(dataDir, "sessions", sessionName);
}

export function getSessionPath(dataDir: string, sessionName: string): string {
  return path.join(getSessionDir(dataDir, sessionName), "session.json");
}

export function loadSession(dataDir: string, sessionName: string): SessionConfig | null {
  const sessionPath = getSessionPath(dataDir, sessionName);
  if (!fs.existsSync(sessionPath)) {
    return null;
  }
  const raw = fs.readFileSync(sessionPath, "utf8");
  return JSON.parse(raw) as SessionConfig;
}

export function saveSession(dataDir: string, sessionName: string, session: SessionConfig): void {
  const sessionDir = getSessionDir(dataDir, sessionName);
  ensureDir(sessionDir);
  fs.writeFileSync(getSessionPath(dataDir, sessionName), JSON.stringify(session, null, 2));
}

export function ensureSession(dataDir: string, sessionName: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  const sessionDir = getSessionDir(dataDir, sessionName);
  ensureDir(sessionDir);

  const downloadsDir = path.join(sessionDir, "downloads");
  ensureDir(downloadsDir);
  const wechatConfigDir = path.join(sessionDir, "wechat-config");
  const wechatDataDir = path.join(sessionDir, "wechat-data");
  ensureDir(wechatConfigDir);
  ensureDir(wechatDataDir);

  const existing = loadSession(dataDir, sessionName);
  if (existing) {
    return { ...existing, ...overrides };
  }

  const defaultImage = process.env.WECHAT_DOCKER_IMAGE || "ghcr.io/apexglory/agent-wechat2:latest";
  const session: SessionConfig = {
    name: sessionName,
    containerName: `agent-wechat-${sessionName}`,
    image: defaultImage,
    dataDir: sessionDir,
    downloadsDir,
    wechatConfigDir,
    wechatDataDir
  };

  return { ...session, ...overrides };
}
