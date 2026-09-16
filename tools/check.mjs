/**
 * Gate estatico de seguranca e qualidade da extensao.
 *
 * Sem dependencias: `node tools/check.mjs`. Sai com codigo 1 se houver ERRO.
 * Avisos nao derrubam o pipeline.
 *
 * O objetivo e transformar a lista de requisitos de seguranca do projeto em
 * algo executavel, para que uma regressao (ex.: alguem adicionar `tabs` nas
 * permissoes ou um `fetch`) quebre o CI em vez de passar despercebida.
 *
 * A saida e ASCII de proposito: console do Windows costuma estragar acentos.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");
const exists = (relative) => existsSync(join(ROOT, relative));

// ---------------------------------------------------------------------------
// Politica: o que a extensao pode e o que nao pode
// ---------------------------------------------------------------------------

/** Arquivos que o navegador realmente carrega. So estes sao auditados. */
const EXTENSION_FILES = [
  "manifest.json",
  "content.js",
  "popup.html",
  "popup.css",
  "popup.js",
];

const REQUIRED_FILES = [
  ...EXTENSION_FILES,
  "README.md",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

/** Unica permissao aceita. Qualquer outra e erro. */
const ALLOWED_PERMISSIONS = ["storage"];

/** Chaves de manifest que ampliariam o alcance da extensao. */
const FORBIDDEN_MANIFEST_KEYS = [
  "host_permissions",
  "optional_permissions",
  "optional_host_permissions",
  "background",
  "web_accessible_resources",
  "externally_connectable",
  "declarative_net_request",
  "devtools_page",
  "chrome_url_overrides",
  "sandbox",
  "content_security_policy",
];

/** Permissoes que o projeto proibe explicitamente (redundante com a allowlist, mas documenta a intencao). */
const EXPLICITLY_FORBIDDEN_PERMISSIONS = [
  "tabs",
  "scripting",
  "activeTab",
  "cookies",
  "webRequest",
  "webRequestBlocking",
  "<all_urls>",
];

const EXPECTED_MATCHES = ["https://www.youtube.com/*"];

/** APIs de extensao liberadas. Qualquer outro `chrome.<api>` e erro. */
const ALLOWED_CHROME_APIS = ["storage", "runtime"];

/** Padroes proibidos em codigo (comentarios sao removidos antes da busca). */
const FORBIDDEN_CODE_PATTERNS = [
  [/\beval\s*\(/, "eval()"],
  [/\bnew\s+Function\s*\(/, "new Function()"],
  [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, "setTimeout/setInterval com string"],
  [/\.innerHTML\b/, "innerHTML"],
  [/\.outerHTML\b/, "outerHTML"],
  [/insertAdjacentHTML/, "insertAdjacentHTML"],
  [/document\s*\.\s*write\b/, "document.write"],
  [/\bfetch\s*\(/, "fetch()"],
  [/XMLHttpRequest/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/sendBeacon/, "navigator.sendBeacon"],
  [/importScripts/, "importScripts"],
  [/\bimport\s*\(/, "import() dinamico"],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b/, "armazenamento da pagina"],
  [/document\s*\.\s*cookie/, "document.cookie"],
  [/\bnavigator\s*\.\s*(?:geolocation|clipboard|mediaDevices|credentials)/, "API sensivel do navigator"],
  [/\bdebugger\b/, "debugger"],
  [/console\s*\.\s*(?:log|warn|error|info)\s*\(/, "console fora de console.debug (a extensao deve falhar em silencio)"],
];

/** Arquivos/pastas esperados na raiz. Extras viram aviso, nao erro. */
const EXPECTED_ROOT_ENTRIES = new Set([
  ...EXTENSION_FILES,
  "README.md",
  "icons",
  "tools",
  "package.json",
  ".github",
  ".git",
  ".gitignore",
  "LICENSE",
]);

// ---------------------------------------------------------------------------
// Infra de checagem
// ---------------------------------------------------------------------------

const errors = [];
const warnings = [];

function section(title) {
  console.log(`\n== ${title} ==`);
}

/** fn() devolve uma lista de problemas; vazia significa aprovado. */
function check(label, fn) {
  let problems;
  try {
    problems = fn() || [];
  } catch (error) {
    problems = [error.message];
  }
  if (problems.length === 0) {
    console.log(`  ok    ${label}`);
    return;
  }
  console.log(`  ERRO  ${label}`);
  for (const problem of problems) {
    console.log(`        - ${problem}`);
    errors.push(`${label}: ${problem}`);
  }
}

function softCheck(label, fn) {
  let problems;
  try {
    problems = fn() || [];
  } catch (error) {
    problems = [error.message];
  }
  if (problems.length === 0) {
    console.log(`  ok    ${label}`);
    return;
  }
  console.log(`  aviso ${label}`);
  for (const problem of problems) {
    console.log(`        - ${problem}`);
    warnings.push(`${label}: ${problem}`);
  }
}

/**
 * Remove comentarios preservando strings, para que um padrao proibido citado
 * num comentario ("nada de innerHTML") nao vire falso positivo, mas um escondido
 * dentro de uma string ainda seja pego.
 */
function stripComments(source) {
  let out = "";
  let state = "code"; // code | line | block | single | double | template
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { state = "line"; i++; continue; }
      if (char === "/" && next === "*") { state = "block"; i++; continue; }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      out += char;
      continue;
    }
    if (state === "line") {
      if (char === "\n") { state = "code"; out += char; }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") { state = "code"; i++; }
      continue;
    }
    // Dentro de string: so o fechamento (nao escapado) devolve ao codigo.
    out += char;
    if (char === "\\") { out += source[i + 1] ?? ""; i++; continue; }
    if ((state === "single" && char === "'") || (state === "double" && char === '"') || (state === "template" && char === "`")) {
      state = "code";
    }
  }
  return out;
}

function linesOf(source, pattern) {
  const hits = [];
  source.split("\n").forEach((line, index) => {
    if (pattern.test(line)) hits.push(`linha ${index + 1}: ${line.trim().slice(0, 90)}`);
  });
  return hits;
}

// ---------------------------------------------------------------------------
// 1. Inventario
// ---------------------------------------------------------------------------

section("Inventario de arquivos");

check("todos os arquivos obrigatorios existem", () =>
  REQUIRED_FILES.filter((file) => !exists(file)).map((file) => `faltando: ${file}`)
);

check("nenhuma dependencia instalada dentro da extensao", () => {
  const problems = [];
  if (exists("node_modules")) problems.push("node_modules existe na raiz (a pasta inteira e carregada pelo navegador)");
  if (exists("package-lock.json")) problems.push("package-lock.json existe, sinal de dependencia instalada");
  if (exists("package.json")) {
    const pkg = JSON.parse(read("package.json"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of Object.keys(deps)) problems.push(`dependencia declarada: ${name}`);
  }
  return problems;
});

check("nenhum passo de build", () => {
  const buildFiles = ["webpack.config.js", "rollup.config.js", "vite.config.js", "tsconfig.json", "Makefile"];
  return buildFiles.filter(exists).map((file) => `arquivo de build encontrado: ${file}`);
});

softCheck("raiz sem arquivos inesperados", () =>
  readdirSync(ROOT)
    .filter((entry) => !EXPECTED_ROOT_ENTRIES.has(entry))
    .map((entry) => `${entry} sera carregado junto com a extensao; se for proposital, adicione a EXPECTED_ROOT_ENTRIES`)
);

// ---------------------------------------------------------------------------
// 2. Manifest
// ---------------------------------------------------------------------------

section("Manifest (permissoes minimas)");

let manifest = null;
check("manifest.json e JSON valido e MV3", () => {
  manifest = JSON.parse(read("manifest.json"));
  return manifest.manifest_version === 3 ? [] : [`manifest_version = ${manifest.manifest_version}, esperado 3`];
});

check(`permissions contem apenas [${ALLOWED_PERMISSIONS.join(", ")}]`, () => {
  const declared = manifest?.permissions ?? [];
  return declared
    .filter((permission) => !ALLOWED_PERMISSIONS.includes(permission))
    .map((permission) => `permissao nao autorizada: ${permission}`);
});

check("nenhuma das permissoes proibidas pelo projeto", () => {
  const declared = new Set(manifest?.permissions ?? []);
  return EXPLICITLY_FORBIDDEN_PERMISSIONS.filter((permission) => declared.has(permission)).map(
    (permission) => `permissao proibida: ${permission}`
  );
});

check("nenhuma chave de manifest que amplie o alcance", () =>
  FORBIDDEN_MANIFEST_KEYS.filter((key) => key in (manifest ?? {})).map((key) => `chave proibida: ${key}`)
);

check("sem service worker / background", () =>
  manifest && "background" in manifest ? ["manifest declara background"] : []
);

check("content script restrito a www.youtube.com", () => {
  const scripts = manifest?.content_scripts ?? [];
  const problems = [];
  if (scripts.length !== 1) problems.push(`esperado 1 content script, encontrado ${scripts.length}`);
  const script = scripts[0];
  if (!script) return problems;
  const matches = script.matches ?? [];
  if (JSON.stringify(matches) !== JSON.stringify(EXPECTED_MATCHES)) {
    problems.push(`matches = ${JSON.stringify(matches)}, esperado ${JSON.stringify(EXPECTED_MATCHES)}`);
  }
  if (script.all_frames === true) problems.push("all_frames: true amplia o alcance sem necessidade");
  if (JSON.stringify(script.js) !== JSON.stringify(["content.js"])) {
    problems.push(`js = ${JSON.stringify(script.js)}, esperado ["content.js"]`);
  }
  return problems;
});

check("todos os caminhos citados no manifest existem", () => {
  const referenced = [];
  const collect = (value) => {
    if (typeof value === "string" && /\.(png|js|html|css)$/.test(value)) referenced.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(manifest ?? {});
  return referenced.filter((path) => !exists(path)).map((path) => `referenciado mas ausente: ${path}`);
});

// ---------------------------------------------------------------------------
// 3. Codigo: padroes proibidos
// ---------------------------------------------------------------------------

section("Codigo (padroes proibidos)");

for (const file of ["content.js", "popup.js"]) {
  const source = stripComments(read(file));
  check(`${file} sem padroes proibidos`, () => {
    const problems = [];
    for (const [pattern, name] of FORBIDDEN_CODE_PATTERNS) {
      if (pattern.test(source)) {
        for (const hit of linesOf(source, pattern)) problems.push(`${name} -> ${hit}`);
      }
    }
    return problems;
  });

  check(`${file} so usa chrome.{${ALLOWED_CHROME_APIS.join(",")}}`, () => {
    const used = new Set();
    for (const match of source.matchAll(/\bchrome\s*\.\s*([A-Za-z_$][\w$]*)/g)) used.add(match[1]);
    return [...used].filter((api) => !ALLOWED_CHROME_APIS.includes(api)).map((api) => `chrome.${api} nao autorizada`);
  });

  check(`${file} sem URLs remotas`, () => linesOf(source, /https?:\/\//).map((hit) => `URL remota -> ${hit}`));
}

check("content.js encapsulado em IIFE com use strict", () => {
  const source = read("content.js");
  const problems = [];
  if (!/^\s*\/\*[\s\S]*?\*\/\s*\(\s*\(\s*\)\s*=>\s*\{/.test(source) && !/\(\s*\(\s*\)\s*=>\s*\{/.test(source)) {
    problems.push("nao parece estar dentro de uma IIFE");
  }
  if (!/["']use strict["']/.test(source)) problems.push('falta "use strict"');
  if (!/\}\)\(\);?\s*$/.test(source.trimEnd())) problems.push("a IIFE nao e fechada e invocada no fim do arquivo");
  return problems;
});

check("content.js so age em /shorts/", () => {
  const source = stripComments(read("content.js"));
  return /location\s*\.\s*pathname\s*\.\s*startsWith\(\s*["']\/shorts\//.test(source)
    ? []
    : ["nao encontrei a guarda location.pathname.startsWith('/shorts/')"];
});

check("DEBUG desligado", () => {
  const source = read("content.js");
  return /const\s+DEBUG\s*=\s*false\s*;/.test(source) ? [] : ["DEBUG deveria estar false no codigo versionado"];
});

check("desligar remove listeners e observers (nao so ignora eventos)", () => {
  const source = stripComments(read("content.js"));
  const problems = [];
  if (!/removeEventListener/.test(source)) problems.push("nenhum removeEventListener encontrado");
  if (!/\.disconnect\(\)/.test(source)) problems.push("MutationObserver nunca e desconectado");
  if (!/clearTimeout/.test(source)) problems.push("timers nunca sao cancelados");
  return problems;
});

check("sintaxe valida (node --check)", () => {
  const problems = [];
  for (const file of ["content.js", "popup.js", "tools/check.mjs", "tools/test.mjs"]) {
    if (!exists(file)) continue;
    try {
      execFileSync(process.execPath, ["--check", join(ROOT, file)], { stdio: "pipe" });
    } catch (error) {
      problems.push(`${file}: ${String(error.stderr ?? error.message).split("\n")[0]}`);
    }
  }
  return problems;
});

// ---------------------------------------------------------------------------
// 4. Popup: CSP do MV3
// ---------------------------------------------------------------------------

section("Popup (CSP padrao do MV3)");

check("popup.html sem script inline", () => {
  const html = read("popup.html");
  const problems = [];
  for (const tag of html.match(/<script[^>]*>/gi) ?? []) {
    if (!/\ssrc\s*=/.test(tag)) problems.push(`script sem src: ${tag}`);
  }
  if (/<script[^>]*>\s*[^<\s]/.test(html)) problems.push("ha conteudo dentro de uma tag <script>");
  return problems;
});

check("popup.html sem estilo inline nem handlers inline", () => {
  const html = read("popup.html");
  const problems = [];
  if (/<style\b/i.test(html)) problems.push("tag <style> encontrada");
  if (/\sstyle\s*=/i.test(html)) problems.push("atributo style= encontrado");
  for (const match of html.matchAll(/\son([a-z]+)\s*=/gi)) problems.push(`handler inline: on${match[1]}=`);
  if (/javascript:/i.test(html)) problems.push("URL javascript: encontrada");
  return problems;
});

check("popup.html so referencia arquivos locais existentes", () => {
  const html = read("popup.html");
  const problems = [];
  for (const match of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/gi)) {
    const value = match[1];
    if (/^(https?:)?\/\//.test(value)) problems.push(`recurso remoto: ${value}`);
    else if (!exists(value)) problems.push(`arquivo ausente: ${value}`);
  }
  if (!/<meta\s+charset/i.test(html)) problems.push("falta <meta charset>");
  return problems;
});

check("popup.css sem recursos remotos", () => {
  const css = read("popup.css");
  const problems = [];
  if (/@import/i.test(css)) problems.push("@import encontrado");
  for (const match of css.matchAll(/url\(\s*['"]?(https?:)?\/\//gi)) problems.push(`url() remota: ${match[0]}`);
  return problems;
});

softCheck("popup.css tem bloco de tema escuro", () =>
  /prefers-color-scheme\s*:\s*dark/.test(read("popup.css")) ? [] : ["sem @media (prefers-color-scheme: dark)"]
);

// ---------------------------------------------------------------------------
// 5. Icones
// ---------------------------------------------------------------------------

section("Icones");

check("PNGs validos e com as dimensoes declaradas", () => {
  const problems = [];
  for (const size of [16, 48, 128]) {
    const path = `icons/icon${size}.png`;
    if (!exists(path)) { problems.push(`ausente: ${path}`); continue; }
    const buffer = readFileSync(join(ROOT, path));
    if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) {
      problems.push(`${path} nao e um PNG valido`);
      continue;
    }
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width !== size || height !== size) problems.push(`${path} tem ${width}x${height}, esperado ${size}x${size}`);
  }
  return problems;
});

// ---------------------------------------------------------------------------
// 6. Tamanho (proxy grosseiro de "nada estranho entrou no pacote")
// ---------------------------------------------------------------------------

softCheck("arquivos da extensao pequenos e legiveis", () =>
  EXTENSION_FILES.filter((file) => statSync(join(ROOT, file)).size > 64 * 1024).map(
    (file) => `${file} passou de 64 KB; confira se nao entrou codigo de terceiros`
  )
);

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

console.log("");
if (warnings.length > 0) console.log(`${warnings.length} aviso(s).`);
if (errors.length > 0) {
  console.log(`FALHOU: ${errors.length} erro(s).`);
  process.exit(1);
}
console.log("Tudo certo: nenhum erro.");
