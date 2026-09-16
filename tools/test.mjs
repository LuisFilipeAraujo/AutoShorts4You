/**
 * Testes de comportamento do content.js.
 *
 * Sem dependencias: `node tools/test.mjs`. Nao usa jsdom — monta um DOM falso
 * minimo (so o que o content.js toca) e executa o arquivo REAL dentro de um
 * `vm`, para que os testes falhem de verdade quando a logica regredir.
 *
 * Cada teste roda num contexto novo: relogio, storage e DOM zerados.
 * Saida em ASCII de proposito (console do Windows).
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_JS = readFileSync(join(ROOT, "content.js"), "utf8");

const VIEWPORT = { width: 400, height: 800 };

// ---------------------------------------------------------------------------
// Mini engine de seletores: cobre apenas o que existe em SELECTORS
// (tag, #id, [atributo] e o combinador descendente).
// ---------------------------------------------------------------------------

function parseSimple(token) {
  const simple = { tag: null, id: null, attrs: [] };
  const re = /([a-z0-9-]+)|#([a-z0-9_-]+)|\[([a-z0-9_-]+)\]/gi;
  let match;
  while ((match = re.exec(token))) {
    if (match[1]) simple.tag = match[1].toLowerCase();
    else if (match[2]) simple.id = match[2];
    else if (match[3]) simple.attrs.push(match[3]);
  }
  return simple;
}

function parseSelector(selector) {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/).map(parseSimple));
}

function matchesSimple(element, simple) {
  if (simple.tag && element.tagName !== simple.tag) return false;
  if (simple.id && element.getAttribute("id") !== simple.id) return false;
  return simple.attrs.every((attr) => element.getAttribute(attr) !== null);
}

function matchesCompound(element, compound) {
  if (!matchesSimple(element, compound[compound.length - 1])) return false;
  let index = compound.length - 2;
  let node = element.parentNode;
  while (index >= 0 && node) {
    if (matchesSimple(node, compound[index])) index--;
    node = node.parentNode;
  }
  return index < 0;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createHarness({ enabled = false, pathname = "/shorts/aaa", buttonVisible = true, fullscreen = false } = {}) {
  const calls = { clicks: [], scrolls: [], keydowns: [], dispatched: [] };
  let clock = 1_000_000;
  let sequence = 0;
  const timers = new Map();
  const frames = new Map();
  const observers = [];
  const storage = { enabled };
  const storageListeners = [];

  class El {
    constructor(tagName, attributes = {}) {
      this.tagName = tagName.toLowerCase();
      this.attributes = { ...attributes };
      this.children = [];
      this.parentNode = null;
      this.listeners = new Map();
      this.computed = { visibility: "visible", display: "block", opacity: "1" };
      this.rect = { top: 0, left: 0, width: VIEWPORT.width, height: VIEWPORT.height };
      this.disabled = false;
    }

    add(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    }

    get nextElementSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode.children;
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }

    descendants() {
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }

    matches(selector) {
      return parseSelector(selector).some((compound) => matchesCompound(this, compound));
    }

    closest(selector) {
      let node = this;
      while (node) {
        if (node.matches && node.matches(selector)) return node;
        node = node.parentNode;
      }
      return null;
    }

    querySelectorAll(selector) {
      const compounds = parseSelector(selector);
      return this.descendants().filter((node) => compounds.some((compound) => matchesCompound(node, compound)));
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    getBoundingClientRect() {
      const { top, left, width, height } = this.rect;
      return { top, left, width, height, right: left + width, bottom: top + height };
    }

    scrollIntoView() {
      calls.scrolls.push(this);
    }

    click() {
      calls.clicks.push(this);
    }

    addEventListener(type, handler, capture = false) {
      const key = `${type}${capture ? ":capture" : ""}`;
      if (!this.listeners.has(key)) this.listeners.set(key, []);
      this.listeners.get(key).push(handler);
    }

    removeEventListener(type, handler, capture = false) {
      const key = `${type}${capture ? ":capture" : ""}`;
      const list = this.listeners.get(key);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) this.listeners.delete(key);
    }

    countListeners(type) {
      return (this.listeners.get(type)?.length ?? 0) + (this.listeners.get(`${type}:capture`)?.length ?? 0);
    }

    /** Propagacao simplificada: captura da raiz ate o alvo, depois bolha. */
    dispatchEvent(event) {
      calls.dispatched.push({ type: event.type, target: this });
      if (event.type === "keydown") calls.keydowns.push({ event, target: this });

      const path = [];
      for (let node = this; node; node = node.parentNode) path.push(node);
      event.target = this;

      const fire = (node, capture) => {
        const key = `${event.type}${capture ? ":capture" : ""}`;
        for (const handler of [...(node.listeners.get(key) ?? [])]) {
          event.currentTarget = node;
          handler(event);
        }
      };

      for (let i = path.length - 1; i >= 1; i--) fire(path[i], true);
      fire(this, true);
      fire(this, false);
      if (event.bubbles) for (let i = 1; i < path.length; i++) fire(path[i], false);
      return true;
    }
  }

  class Video extends El {
    constructor(src) {
      super("video");
      this.currentSrc = src;
      this.currentTime = 0;
      this.duration = 10;
      this.paused = false;
    }

    /** Mexe o tempo e emite timeupdate, como o player faria. */
    emitTime(time) {
      this.currentTime = time;
      this.dispatchEvent({ type: "timeupdate", bubbles: false });
    }
  }

  // --- cena ----------------------------------------------------------------
  const document = new El("#document");
  const body = document.add(new El("body"));
  const app = body.add(new El("ytd-app"));
  const shorts = app.add(new El("ytd-shorts"));
  const inner = shorts.add(new El("div", { id: "shorts-inner-container" }));
  const reel1 = inner.add(new El("ytd-reel-video-renderer", { "is-active": "" }));
  const reel2 = inner.add(new El("ytd-reel-video-renderer"));
  const video1 = reel1.add(new Video("blob:short-1"));
  const video2 = reel2.add(new Video("blob:short-2"));
  const navDown = shorts.add(new El("div", { id: "navigation-button-down" }));
  const nextButton = navDown.add(new El("button"));

  // O Short atual ocupa a viewport; o proximo esta abaixo da dobra.
  video1.rect = { top: 0, left: 0, width: 400, height: 700 };
  video2.rect = { top: 900, left: 0, width: 400, height: 700 };
  video2.paused = true;
  nextButton.rect = { top: 400, left: 350, width: 40, height: 40 };
  if (!buttonVisible) nextButton.computed.display = "none";

  document.body = body;
  document.fullscreenElement = fullscreen ? shorts : null;

  // --- globais do vm -------------------------------------------------------
  const location = { pathname };

  const window = {
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    addEventListener: (type, handler, capture = false) => document.addEventListener(`window:${type}`, handler, capture),
    removeEventListener: (type, handler, capture = false) => document.removeEventListener(`window:${type}`, handler, capture),
  };

  const chrome = {
    storage: {
      local: {
        get(defaults, callback) {
          const result = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            result[key] = key in storage ? storage[key] : fallback;
          }
          callback(result);
        },
        set(values) {
          for (const [key, value] of Object.entries(values)) {
            const oldValue = storage[key];
            storage[key] = value;
            for (const listener of storageListeners) {
              listener({ [key]: { oldValue, newValue: value } }, "local");
            }
          }
        },
      },
      onChanged: {
        addListener(handler) {
          storageListeners.push(handler);
        },
      },
    },
    runtime: {},
  };

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observing = false;
      observers.push(this);
    }
    observe() {
      this.observing = true;
    }
    disconnect() {
      this.observing = false;
    }
  }

  class KeyboardEvent {
    constructor(type, init = {}) {
      Object.assign(this, init);
      this.type = type;
    }
  }

  const context = createContext({
    console: { debug() {}, log() {}, warn() {}, error() {} },
    document,
    window,
    location,
    chrome,
    MutationObserver,
    KeyboardEvent,
    Date: { now: () => clock },
    getComputedStyle: (element) => element.computed,
    requestAnimationFrame(callback) {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, at: clock + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });

  return {
    calls,
    document,
    window,
    location,
    chrome,
    storage,
    observers,
    elements: { shorts, reel1, reel2, video1, video2, nextButton },

    run() {
      runInContext(CONTENT_JS, context, { filename: "content.js" });
    },

    /** Executa os rAF pendentes (o content.js agrupa os syncs por frame). */
    flushFrames() {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback();
    },

    /** Avanca o relogio e dispara os timers vencidos, em ordem. */
    tick(ms) {
      clock += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= clock)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },

    setEnabled(value) {
      chrome.storage.local.set({ enabled: value });
    },

    /** Total de tentativas de avanco observadas, por qualquer estrategia. */
    advanceAttempts() {
      return calls.clicks.length + calls.scrolls.length + calls.keydowns.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FALHA ${name}`);
    console.log(`        ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (esperado ${expected}, obtido ${actual})`);
}

/** Cena pronta: extensao ligada, num Short, com o video no ar. */
function startedHarness(options = {}) {
  const harness = createHarness({ enabled: true, ...options });
  harness.run();
  return harness;
}

console.log("\n== Estado e ciclo de vida ==");

test("padrao e desligado: nao avanca", () => {
  const harness = createHarness({ enabled: false });
  harness.run();
  harness.elements.video1.emitTime(9.9);
  assertEqual(harness.advanceAttempts(), 0, "nao deveria tentar avancar com a extensao desligada");
});

test("desligado nao instala observers nem listeners", () => {
  const harness = createHarness({ enabled: false });
  harness.run();
  assertEqual(harness.document.countListeners("yt-navigate-finish"), 0, "listener de navegacao instalado");
  assertEqual(harness.observers.filter((o) => o.observing).length, 0, "MutationObserver ativo");
  assertEqual(harness.elements.video1.countListeners("timeupdate"), 0, "listener de timeupdate instalado");
});

test("ligar instala listeners e observer", () => {
  const harness = startedHarness();
  assert(harness.document.countListeners("yt-navigate-finish") > 0, "sem listener de navegacao");
  assert(harness.elements.video1.countListeners("timeupdate") > 0, "sem listener de timeupdate no video ativo");
  assertEqual(harness.observers.filter((o) => o.observing).length, 1, "MutationObserver deveria estar observando");
});

test("desligar pelo storage remove listeners, observer e timers", () => {
  const harness = startedHarness();
  harness.setEnabled(false);
  assertEqual(harness.document.countListeners("yt-navigate-finish"), 0, "listener de navegacao ficou para tras");
  assertEqual(harness.elements.video1.countListeners("timeupdate"), 0, "listener de timeupdate ficou para tras");
  assertEqual(harness.observers.filter((o) => o.observing).length, 0, "MutationObserver continuou ativo");
});

test("desligado no meio do video nao avanca mais", () => {
  const harness = startedHarness();
  harness.setEnabled(false);
  harness.elements.video1.emitTime(9.9);
  harness.tick(2000);
  assertEqual(harness.advanceAttempts(), 0, "avancou mesmo desligado");
});

test("religar volta a funcionar sem recarregar", () => {
  const harness = startedHarness();
  harness.setEnabled(false);
  harness.setEnabled(true);
  harness.elements.video1.emitTime(9.9);
  assertEqual(harness.calls.clicks.length, 1, "deveria avancar de novo apos religar");
});

test("fora de /shorts/ nao faz nada", () => {
  const harness = createHarness({ enabled: true, pathname: "/feed/subscriptions" });
  harness.run();
  harness.elements.video1.emitTime(9.9);
  assertEqual(harness.advanceAttempts(), 0, "agiu fora da pagina de Shorts");
  assertEqual(harness.elements.video1.countListeners("timeupdate"), 0, "anexou listener fora dos Shorts");
});

console.log("\n== Deteccao de fim de video ==");

test("avanca a ~0,3s do fim", () => {
  const harness = startedHarness();
  harness.elements.video1.emitTime(5);
  assertEqual(harness.advanceAttempts(), 0, "avancou cedo demais");
  harness.elements.video1.emitTime(9.8);
  assertEqual(harness.calls.clicks.length, 1, "deveria ter clicado no botao de proximo");
});

test("avanca quando o loop reinicia o video", () => {
  const harness = startedHarness();
  harness.elements.video1.emitTime(9.5); // passou de 90%, mas fora do limiar de 0,3s
  assertEqual(harness.advanceAttempts(), 0, "avancou antes do reinicio");
  harness.elements.video1.emitTime(0.1); // o loop voltou ao inicio: o video acabou
  assertEqual(harness.calls.clicks.length, 1, "nao detectou o fim pelo reinicio do loop");
});

test("voltar ao inicio sem ter passado de 90% nao conta como fim", () => {
  const harness = startedHarness();
  harness.elements.video1.emitTime(4); // usuario arrastou a barra para o meio
  harness.elements.video1.emitTime(0.2); // e depois para o comeco
  assertEqual(harness.advanceAttempts(), 0, "confundiu seek manual com fim de video");
});

test("video pausado antes do fim nao avanca", () => {
  const harness = startedHarness();
  harness.elements.video1.paused = true;
  harness.elements.video1.emitTime(9.9);
  assertEqual(harness.advanceAttempts(), 0, "avancou com o video pausado");
});

test("duration invalida e ignorada", () => {
  for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
    const harness = startedHarness();
    harness.elements.video1.duration = duration;
    harness.elements.video1.emitTime(9.9);
    assertEqual(harness.advanceAttempts(), 0, `avancou com duration = ${duration}`);
  }
});

test("evento ended tambem avanca (video sem loop)", () => {
  const harness = startedHarness();
  harness.elements.video1.dispatchEvent({ type: "ended", bubbles: false });
  assertEqual(harness.calls.clicks.length, 1, "nao reagiu ao evento ended");
});

console.log("\n== Trava contra avanco duplo ==");

test("varios timeupdate no fim geram um unico avanco", () => {
  const harness = startedHarness();
  harness.elements.video1.emitTime(9.8);
  assertEqual(harness.calls.clicks.length, 1, "nao avancou no primeiro fim");

  // O relogio precisa passar da janela minima entre avancos, senao seria ela
  // segurando o segundo avanco e a trava por video ficaria sem teste.
  harness.tick(1000);
  harness.elements.video1.emitTime(9.85);
  harness.elements.video1.emitTime(9.9);
  harness.tick(1000);
  harness.elements.video1.emitTime(9.95);

  assertEqual(harness.calls.clicks.length, 1, "avancou mais de uma vez no mesmo termino");
});

test("fim seguido de ended nao avanca duas vezes", () => {
  const harness = startedHarness();
  harness.elements.video1.emitTime(9.9);
  harness.tick(1000); // fora da janela minima: quem tem de segurar aqui e a trava
  harness.elements.video1.dispatchEvent({ type: "ended", bubbles: false });
  assertEqual(harness.calls.clicks.length, 1, "timeupdate e ended dispararam avancos separados");
});

test("novo Short libera a trava", () => {
  const harness = startedHarness();
  harness.elements.video1.emitTime(9.9);
  assertEqual(harness.calls.clicks.length, 1, "primeiro avanco falhou");

  // O YouTube trocou de Short: novo reel ativo, novo video visivel.
  harness.location.pathname = "/shorts/bbb";
  delete harness.elements.reel1.attributes["is-active"];
  harness.elements.reel2.attributes["is-active"] = "";
  harness.elements.video1.rect = { top: -900, left: 0, width: 400, height: 700 };
  harness.elements.video2.rect = { top: 0, left: 0, width: 400, height: 700 };
  harness.elements.video2.paused = false;
  harness.document.dispatchEvent({ type: "yt-navigate-finish", bubbles: false });
  harness.flushFrames();

  assert(harness.elements.video2.countListeners("timeupdate") > 0, "nao reanexou no novo video ativo");
  assertEqual(harness.elements.video1.countListeners("timeupdate"), 0, "deixou listener no video antigo");

  harness.tick(2000); // passa a janela minima entre avancos
  harness.elements.video2.emitTime(9.9);
  assertEqual(harness.calls.clicks.length, 2, "nao avancou no segundo Short");
});

console.log("\n== Estrategias de avanco e fallbacks ==");

test("fora da tela cheia: clica no botao de proximo", () => {
  const harness = startedHarness();
  harness.elements.video1.emitTime(9.9);
  assertEqual(harness.calls.clicks.length, 1, "nao clicou no botao");
  assertEqual(harness.calls.clicks[0], harness.elements.nextButton, "clicou no elemento errado");
  assertEqual(harness.calls.scrolls.length, 0, "nao deveria precisar do fallback de scroll");
  assertEqual(harness.calls.keydowns.length, 0, "nao deveria precisar do fallback de teclado");
});

test("avanco bem-sucedido nao dispara fallback depois", () => {
  const harness = startedHarness();
  harness.elements.video1.emitTime(9.9);
  harness.location.pathname = "/shorts/bbb"; // o clique funcionou
  harness.tick(2000);
  assertEqual(harness.calls.keydowns.length, 0, "disparou ArrowDown mesmo com o avanco tendo funcionado");
  assertEqual(harness.calls.scrolls.length, 0, "rolou a pagina mesmo com o avanco tendo funcionado");
});

test("botao invisivel: cai para o scroll do proximo reel", () => {
  const harness = startedHarness({ buttonVisible: false });
  harness.elements.video1.emitTime(9.9);
  assertEqual(harness.calls.clicks.length, 0, "clicou num botao invisivel");
  assertEqual(harness.calls.scrolls.length, 1, "nao rolou para o proximo reel");
  assertEqual(harness.calls.scrolls[0], harness.elements.reel2, "rolou para o elemento errado");
});

test("tela cheia: scroll nao resolve e o ArrowDown entra", () => {
  const harness = startedHarness({ buttonVisible: false, fullscreen: true });
  harness.elements.video1.emitTime(9.9);
  assertEqual(harness.calls.scrolls.length, 1, "nao tentou rolar primeiro");
  assertEqual(harness.calls.keydowns.length, 0, "disparou o teclado antes de verificar o scroll");

  harness.tick(1000); // o Short nao mudou: entra o ultimo fallback
  assertEqual(harness.calls.keydowns.length, 1, "nao disparou ArrowDown apos o scroll falhar");
  const { event, target } = harness.calls.keydowns[0];
  assertEqual(event.key, "ArrowDown", "tecla errada");
  assertEqual(target, harness.elements.shorts, "em tela cheia o evento deve ir para o elemento em fullscreen");
});

test("sem botao e sem proximo reel: ainda tenta o teclado", () => {
  const harness = startedHarness({ buttonVisible: false });
  harness.elements.reel2.parentNode.children.pop(); // o YouTube ainda nao renderizou o proximo
  harness.elements.video1.emitTime(9.9);
  assertEqual(harness.calls.scrolls.length, 0, "rolou para um reel inexistente");
  assertEqual(harness.calls.keydowns.length, 1, "nao caiu para o ArrowDown");
});

test("falha silenciosa: DOM do YouTube irreconhecivel nao lanca erro", () => {
  const harness = createHarness({ enabled: true });
  harness.document.children.length = 0; // nada de ytd-shorts, reels ou video
  harness.run();
  harness.document.dispatchEvent({ type: "yt-navigate-finish", bubbles: false });
  harness.flushFrames();
  harness.tick(2000);
  assertEqual(harness.advanceAttempts(), 0, "tentou agir sem encontrar o player");
});

// ---------------------------------------------------------------------------

console.log("");
if (failures > 0) {
  console.log(`FALHOU: ${failures} de ${total} teste(s).`);
  process.exit(1);
}
console.log(`Tudo certo: ${total} teste(s).`);
