#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "1.0.0");
const ARM_ROOT = path.join(ROOT, ".offline-downloads-arm64");
const NODE_TAR = path.join(ARM_ROOT, "node-v16.20.2-linux-arm64.tar.xz");
const PY_TAR = path.join(ARM_ROOT, "cpython-3.11.10+20241016-aarch64-unknown-linux-gnu-install_only.tar.gz");
const WHEELS = path.join(ARM_ROOT, "wheels");
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const RELEASE = `webssh-fullstack-offline-linux-arm64-v${VERSION}-${STAMP}`;
const OUT_DIR = path.join(ROOT, "dist");
const ARCHIVE = path.join(OUT_DIR, `${RELEASE}.tar.gz`);

function need(p, label) { if (!fs.existsSync(p)) throw new Error(`缺少${label || p}: ${p}`); }
function sha256(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function copy(src, dst) {
  const stat = fs.statSync(src);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!stat.isDirectory()) {
    fs.copyFileSync(src, dst);
    return;
  }
  if (process.platform === "win32") {
    try {
      execFileSync("robocopy", [src, dst, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:0", "/W:0", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], { stdio: "inherit" });
    } catch (err) {
      const code = Number.isInteger(err.status) ? err.status : -1;
      if (code < 0 || code > 7) throw err;
    }
  } else {
    fs.cpSync(src, dst, { recursive: true, force: true });
  }
}
function runTar(args, cwd) {
  execFileSync("tar", args, { cwd, stdio: "inherit" });
}
function write(p, text, mode = 0o644) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, "utf8"); fs.chmodSync(p, mode); }
function checkDependencies(app) {
  const modules = path.join(app, "node_modules");
  // ssh2's Pageant helper is used only on Windows, never by the Linux service.
  const pageant = path.join(modules, "ssh2", "util", "pagent.exe");
  if (fs.existsSync(pageant)) fs.unlinkSync(pageant);
  function visit(directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(node|so|dll|exe)$/i.test(entry.name)) {
        const header = fs.readFileSync(file);
        const elf = header.length > 20 && header[0] === 127 && header.toString("ascii",1,4) === "ELF";
        const machine = elf ? (header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18)) : -1;
        if (machine !== 183) throw new Error("ARM依赖含不兼容原生文件: " + path.relative(app,file));
      }
    });
  }
  visit(modules);
  if (!fs.existsSync(path.join(modules,"sax","package.json"))) throw new Error("缺少B接口XML依赖sax");
}

const APP_DIRS = ["lib", "serial", "sms", "ha", "proto-conv", "video", "db", "dcim-settings", "overview", "snmp-bundle", "node_modules"];
const APP_FILES = ["server.js", "index.html", "login.html", "webssh-intro.html", "package.json", "package-lock.json"];
function main() {
  [NODE_TAR, PY_TAR, WHEELS, path.join(ROOT, "server.js"), path.join(ROOT, "index.html"), path.join(ROOT, "package.json"), path.join(ROOT, "package-lock.json"), path.join(ROOT, "protocol_app"), path.join(ROOT, "systemd", "webssh.service.template"), path.join(ROOT, "systemd", "webssh-protocol.service.template"), path.join(ROOT, "scripts", "uninstall-all.sh")].forEach(need);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `${RELEASE}-`));
  const stage = path.join(temp, RELEASE);
  const app = path.join(stage, "app");
  fs.mkdirSync(app, { recursive: true });
  APP_FILES.forEach(n => copy(path.join(ROOT, n), path.join(app, n)));
  APP_DIRS.forEach(n => { if (fs.existsSync(path.join(ROOT, n))) copy(path.join(ROOT, n), path.join(app, n)); });
  checkDependencies(app);
  write(path.join(app, "runtime-features.js"), "window.WEBSSH_FEATURES = { protocol: true, video: true, db: true, ha: true, protoConv: true };\n");
  copy(path.join(ROOT, "protocol_app"), path.join(stage, "protocol", "app"));
  copy(NODE_TAR, path.join(stage, "runtime", path.basename(NODE_TAR)));
  copy(PY_TAR, path.join(stage, "protocol", "runtime", path.basename(PY_TAR)));
  copy(WHEELS, path.join(stage, "protocol", "wheels"));
  fs.readdirSync(WHEELS).filter(n => n.endsWith(".whl")).forEach(n => {
    if (!/-(?:any|[^/]*aarch64)\.whl$/.test(n)) throw new Error("非ARM64离线wheel: " + n);
  });
  copy(path.join(ROOT, "systemd", "webssh.service.template"), path.join(stage, "systemd", "webssh.service.template"));
  copy(path.join(ROOT, "systemd", "webssh-protocol.service.template"), path.join(stage, "systemd", "webssh-protocol.service.template"));
  copy(path.join(ROOT, "scripts", "uninstall-all.sh"), path.join(stage, "uninstall-all.sh"));
  write(path.join(stage, "install-all-arm64.sh"), "#!/usr/bin/env bash\nset -euo pipefail\nexec bash \"$(dirname \"$0\")/scripts/install-all-arm64.sh\" \"$@\"\n", 0o755);
  copy(path.join(ROOT, "scripts", "install-all-arm64.sh"), path.join(stage, "scripts", "install-all-arm64.sh"));
  write(path.join(stage, "release-manifest.json"), JSON.stringify({ name: RELEASE, architecture: "arm64", nodeVersion: "16.20.2", pythonVersion: "3.11.10", features: { protocol: true, video: true, db: true, ha: true, protoConv: true, wecomWebhook: true, wecomApplication: true, serialScanIsolation: true }, serialBaudRatesAdded: [1200, 2400], media: "external-dcim" }, null, 2) + "\n");
  write(path.join(stage, "INSTALL.md"), `# ARM64 全功能 WebSSH 离线包\n\n解包后执行：\n\n    chmod +x install-all-arm64.sh\n    ./install-all-arm64.sh\n\n本包使用 Node16 ARM64、CPython3.11 ARM64 和 aarch64 wheels；视频监控复用目标机现有 dcim/ZLMediaKit/WVP，不安装第二套媒体服务。\n`);
  const manifest = {};
  function sourceFiles(directory, prefix) {
    fs.readdirSync(directory,{withFileTypes:true}).forEach(entry => {
      if (["node_modules","__pycache__","uploads","outputs","downloads","module4_uploads","module4_downloads"].includes(entry.name) || entry.name.endsWith(".pyc")) return;
      const file = path.join(directory,entry.name), key = prefix + "/" + entry.name;
      if (entry.isDirectory()) sourceFiles(file,key); else if (entry.isFile()) manifest[key] = sha256(file);
    });
  }
  sourceFiles(app,"app"); sourceFiles(path.join(stage,"protocol","app"),"protocol/app");
  write(path.join(stage,"source-manifest.json"),JSON.stringify(manifest,null,2) + "\n");
  const excludes = ["uploads", "outputs", "downloads", "module4_uploads", "module4_downloads"]
    .map(name => `--exclude=${RELEASE}/protocol/app/${name}`);
  runTar(["-czf", ARCHIVE, "--exclude=__pycache__", "--exclude=*.pyc", ...excludes, "-C", temp, RELEASE], ROOT);
  const digest = sha256(ARCHIVE);
  write(`${ARCHIVE}.sha256`, `${digest}  ${path.basename(ARCHIVE)}\n`);
  const resolvedTemp = fs.realpathSync(temp), tempParent = fs.realpathSync(os.tmpdir());
  if (path.dirname(resolvedTemp) !== tempParent || !path.basename(resolvedTemp).startsWith(RELEASE + "-")) throw new Error("拒绝清理非本次打包临时目录");
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
  console.log(`ARM64 全功能包: ${ARCHIVE}`);
  console.log(`SHA256: ${digest}`);
}
if (require.main === module) { try { main(); } catch (e) { console.error(e.stack || e.message); process.exit(1); } }
module.exports = { sha256, checkDependencies };
