// 开发用预览：不启动 Claude，在普通浏览器里跑拓展运行时和拓展包，看界面、调后台。
//
//   node dev/preview-server.mjs <拓展包目录>... [--port 8799]
//
// 它用的是和本地服务同一套模块（extensions.mjs 的注入计划、page-api.mjs 的页面接口、ext-backend.mjs 的后台托管），
// 只是页面换成一张假的 Claude 外壳（preview.html），来源换成 http://127.0.0.1:<端口>。
// 注入计划本来由 Rust 渲染（src/extensions/plan.rs）；这里为了能单独跑，按同样的模板在 JS 里拼了一份，
// 只供预览，清单也只读用得上的几个字段、不做校验。真正的规则以 Rust 为准。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_PACKAGE_PREFIX, PAGE_RUNTIME_PATH, PAGE_TOKEN_PLACEHOLDER, createPagePlan } from "../extensions.mjs";
import { createBackendHost, defaultRunnerPath } from "../ext-backend.mjs";
import { PAGE_API_PREFIX, createPageApi } from "../page-api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.dirname(here);
const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const port = portAt === -1 ? 8799 : Number(args[portAt + 1]);
const dirs = args.filter((arg, index) => !arg.startsWith("--") && index !== portAt + 1 || (portAt === -1 && !arg.startsWith("--")));
if (!dirs.length) {
  console.error("用法：node dev/preview-server.mjs <拓展包目录>... [--port 8799]");
  process.exit(2);
}

const read = (name) => fs.readFileSync(path.join(runtimeDir, name), "utf8");
const state = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ext-preview-"));
const planFile = path.join(state, "page-plan.json");

function defaults(schema = {}) {
  const fallback = { number: 0, boolean: false, array: [], object: {} };
  return Object.fromEntries(Object.entries(schema).map(([key, field]) => [key, field.default ?? fallback[field.type] ?? ""]));
}

function buildPlan() {
  const wrap = read("page-wrap.js");
  const [head, rest] = wrap.split("/*CODEXPP_STYLES*/");
  const [middle, tail] = rest.split("/*CODEXPP_SOURCE*/");
  const packages = dirs.map((dir) => {
    const root = path.resolve(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "codexpp.json"), "utf8"));
    const claude = manifest.claudeDesktop ?? {};
    const scripts = [].concat(claude.renderer ?? []);
    const styles = claude.styles ?? [];
    const methods = claude.methods ?? [];
    const config = defaults(manifest.config);
    const pageConfig = Object.fromEntries(Object.entries(config).map(([key, value]) => [key, manifest.config?.[key]?.secret ? null : value]));
    const key = `local:${manifest.id}`;
    const meta = {
      key, name: manifest.name ?? manifest.id, source: "local",
      manifest: {
        id: manifest.id, name: manifest.name ?? manifest.id, version: manifest.version ?? "", description: manifest.description ?? "",
        engines: { codexpp: 1 }, permissions: { routes: manifest.permissions?.routes ?? [] }, config: pageConfig,
        claudeDesktop: { methods, backend: Boolean(manifest.backend?.script) },
      },
    };
    const pieces = [{ text: head.replace("/*CODEXPP_META*/null", JSON.stringify(meta)) }];
    for (const file of styles) pieces.push({ text: `    runtime.addStyle(meta.key, ${JSON.stringify(file)}, ` }, { file, json: true }, { text: ");\n" });
    pieces.push({ text: middle });
    for (const file of scripts) pieces.push({ file }, { text: "\n;\n" });
    pieces.push({ text: tail });
    return {
      key, slug: `l-${manifest.id}`, id: manifest.id, name: meta.name, version: meta.manifest.version, root, pieces, methods,
      routes: meta.manifest.permissions.routes, backend: manifest.backend?.script ? path.join(root, manifest.backend.script) : null,
      config, dataDir: path.join(state, "extension-data", manifest.id), hosted: false,
    };
  });
  const boot = {
    version: 1, apiVersion: 1, host: "claudeDesktop", transport: "http", token: PAGE_TOKEN_PLACEHOLDER, api: PAGE_API_PREFIX,
    packages: packages.map((item) => ({ key: item.key, name: item.name, slug: item.slug })),
  };
  return {
    version: 1, transport: "http", legacy: [], packages,
    runtime: { key: "runtime", pieces: [{ text: `window.__codexPlusClaudeBoot = ${JSON.stringify(boot)};\n${read("page-anchors.js")}\n;\n${read("page-runtime.js")}` }] },
  };
}

// 每次请求页面都重新生成计划：改了运行时、锚点表、清单，刷新浏览器就看到。
const writePlan = () => fs.writeFileSync(planFile, JSON.stringify(buildPlan()), { mode: 0o600 });
writePlan();

const token = crypto.randomBytes(32).toString("hex");
const origin = `http://127.0.0.1:${port}`;
const plan = createPagePlan({ planFile });
const backends = createBackendHost({ runner: defaultRunnerPath(runtimeDir), log: console.log });
const api = createPageApi({ plan, backends, token, origins: new Set([origin]), statusFile: path.join(state, "page-status.json"), log: console.log });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname.startsWith(PAGE_API_PREFIX)) return api.handle(req, res, url.pathname);
  if (url.pathname === PAGE_RUNTIME_PATH || url.pathname.startsWith(PAGE_PACKAGE_PREFIX)) {
    const script = plan.script(url.pathname, token);
    if (script === null) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    return res.end(script);
  }
  if (url.pathname === "/" || url.pathname === "/new" || url.pathname.startsWith("/chat/")) {
    try {
      writePlan();
    } catch (error) {
      console.error(`生成注入计划失败：${error.message}`);
    }
    const tags = plan.scripts().map((src) => `<script src="${src}" defer></script>`).join("");
    const html = fs.readFileSync(path.join(here, "preview.html"), "utf8").replace("<!--EXTENSIONS-->", tags);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, "127.0.0.1", () => {
  console.log(`预览：${origin}/new    （深色：${origin}/new?dark）`);
  console.log(`后台数据和加载状态在 ${state}`);
});
const stop = () => {
  backends.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
