import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  label = "cn.mianfan.hezi-workbench",
  domain = `gui/${process.getuid!()}`,
  file = resolve(homedir(), "Library/LaunchAgents", label + ".plist");
const xml = (v: string) =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
if (process.platform !== "darwin")
  throw Error("This service installer currently supports macOS only");
const action = process.argv[2];
if (action === "install") {
  await mkdir(dirname(file), { recursive: true });
  await mkdir(resolve(repo, ".hezi"), { recursive: true, mode: 0o700 });
  const source = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(repo, "dist/server.js"))}</string></array><key>WorkingDirectory</key><string>${xml(repo)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(resolve(repo, ".hezi/service.log"))}</string><key>StandardErrorPath</key><string>${xml(resolve(repo, ".hezi/service-error.log"))}</string></dict></plist>`;
  await writeFile(file, source, { mode: 0o600 });
  try {
    execFileSync("launchctl", ["bootout", domain + "/" + label], {
      stdio: "ignore",
    });
  } catch {}
  // bootout returns before launchd finishes unregistering the service.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      execFileSync("launchctl", ["print", domain + "/" + label], {
        stdio: "ignore",
      });
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  execFileSync("launchctl", ["bootstrap", domain, file]);
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      ready = (
        await fetch("http://127.0.0.1:4317/api/health", {
          signal: AbortSignal.timeout(500),
        })
      ).ok;
      if (ready) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error("服务已注册但未就绪，请检查 .hezi/service-error.log");
  console.log("本机工作台服务已启动：http://127.0.0.1:4317");
} else if (action === "uninstall") {
  try {
    execFileSync("launchctl", ["bootout", domain + "/" + label], {
      stdio: "ignore",
    });
  } catch {}
  await rm(file, { force: true });
  console.log("工作台服务已停止，项目数据保留");
} else throw Error("Use install or uninstall");
