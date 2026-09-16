/**
 * shorts-autoscroll — content script.
 *
 * Roda em todo www.youtube.com (o YouTube e uma SPA: da pra chegar em /shorts/
 * sem recarregar a pagina), mas so age quando location.pathname comeca com /shorts/.
 *
 * Nao faz rede, nao le nada da pagina alem de: qual <video> esta ativo, seu
 * currentTime/duration, e os elementos de navegacao dos Shorts.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Configuracao
  // ---------------------------------------------------------------------------

  /** Liga os console.debug. Deixe false: falhas devem ser silenciosas. */
  const DEBUG = false;
  const LOG_PREFIX = "[shorts-autoscroll]";

  const STORAGE_KEY = "enabled";

  /**
   * TODOS os seletores do DOM do YouTube ficam aqui.
   * Se a extensao parar de funcionar, o conserto provavelmente e nesta tabela.
   */
  const SELECTORS = {
    // Raiz do app de Shorts. Usada como alvo do MutationObserver — bem mais
    // barato do que observar <body> inteiro numa pagina tao movimentada.
    SHORTS_APP: "ytd-shorts",

    // Cada Short e um "reel renderer". O que esta em exibicao ganha [is-active].
    REEL: "ytd-reel-video-renderer",
    ACTIVE_REEL: "ytd-reel-video-renderer[is-active]",

    // Candidatos a <video>. Existem varios no DOM ao mesmo tempo (o YouTube
    // pre-carrega os Shorts vizinhos), por isso os candidatos sao pontuados.
    VIDEO_CANDIDATES: "ytd-reel-video-renderer video, #shorts-player video, video",

    // Botao "proximo Short" (seta pra baixo). Some em tela cheia.
    NEXT_BUTTON:
      "#navigation-button-down button, ytd-shorts #navigation-button-down button",
  };

  /** Margem, em segundos, para considerar que o video chegou ao fim. */
  const END_THRESHOLD_S = 0.3;
  /** Fracao da duracao que precisa ter sido atingida para um "voltou ao inicio" contar como fim. */
  const LOOP_MIN_PROGRESS = 0.9;
  /** Ate onde o tempo pode ter voltado para contar como reinicio do loop. */
  const LOOP_RESET_MAX_S = 1;
  /** Trava global extra contra avanco duplo. */
  const MIN_ADVANCE_INTERVAL_MS = 800;
  /** Quanto esperar antes de checar se a estrategia de avanco funcionou. */
  const VERIFY_DELAY_MS = 700;

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------

  const state = {
    enabled: false,
    /** { video, lastTime, advanced } do <video> ativo, ou null. */
    tracker: null,
    observer: null,
    syncHandle: 0,
    timers: new Set(),
    lastAdvanceAt: 0,
  };

  function debug(...args) {
    if (DEBUG) console.debug(LOG_PREFIX, ...args);
  }

  // ---------------------------------------------------------------------------
  // Utilitarios
  // ---------------------------------------------------------------------------

  function isShortsPage() {
    return location.pathname.startsWith("/shorts/");
  }

  function isUsableDuration(duration) {
    return typeof duration === "number" && Number.isFinite(duration) && duration > 0;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
    if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return Number(style.opacity) > 0.05;
  }

  /** Quanto do elemento esta dentro da viewport, de 0 a 1. */
  function viewportCoverage(element) {
    const rect = element.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area <= 0) return 0;
    const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    return (width * height) / area;
  }

  function setTrackedTimeout(fn, delay) {
    const id = setTimeout(() => {
      state.timers.delete(id);
      fn();
    }, delay);
    state.timers.add(id);
    return id;
  }

  function clearTrackedTimers() {
    for (const id of state.timers) clearTimeout(id);
    state.timers.clear();
  }

  // ---------------------------------------------------------------------------
  // Descoberta do video ativo
  // ---------------------------------------------------------------------------

  /**
   * Ha varios <video> no DOM. O ativo e o do reel marcado como [is-active];
   * se o atributo mudar de nome, caimos na pontuacao por visibilidade.
   */
  function findActiveVideo() {
    const activeReel = document.querySelector(SELECTORS.ACTIVE_REEL);
    const scoped = activeReel ? activeReel.querySelector("video") : null;
    if (scoped && isVisible(scoped)) return scoped;

    let best = null;
    let bestScore = 0;
    for (const video of document.querySelectorAll(SELECTORS.VIDEO_CANDIDATES)) {
      if (!isVisible(video)) continue;
      // Tocando vale mais que apenas visivel: os Shorts vizinhos ficam pausados.
      const score = viewportCoverage(video) * (video.paused ? 1 : 2);
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return bestScore > 0 ? best : null;
  }

  // ---------------------------------------------------------------------------
  // Deteccao de fim de video
  // ---------------------------------------------------------------------------

  function resetTracker() {
    if (!state.tracker) return;
    state.tracker.lastTime = 0;
    state.tracker.advanced = false;
  }

  function handleTimeUpdate(event) {
    const video = event.currentTarget;
    const tracker = state.tracker;
    if (!tracker || tracker.video !== video) return;

    const duration = video.duration;
    const time = video.currentTime;
    const previous = tracker.lastTime;
    tracker.lastTime = time;

    if (!isUsableDuration(duration)) return;

    // O <video> dos Shorts fica em loop, entao 'ended' quase nunca dispara.
    // Se o tempo "voltou" pro comeco depois de passar de ~90%, o video acabou.
    const looped =
      previous >= duration * LOOP_MIN_PROGRESS &&
      time < previous &&
      time <= LOOP_RESET_MAX_S;

    if (tracker.advanced) {
      // Nova volta do loop: se o avanco anterior falhou, permite outra tentativa.
      if (looped) tracker.advanced = false;
      return;
    }

    // Pausado na mao antes do fim: nao e nosso caso, nao avanca.
    if (video.paused) return;

    const nearEnd = duration - time <= END_THRESHOLD_S;
    if (!nearEnd && !looped) return;

    tracker.advanced = true;
    requestAdvance();
  }

  function handleEnded(event) {
    const tracker = state.tracker;
    if (!tracker || tracker.video !== event.currentTarget) return;
    if (tracker.advanced) return;
    tracker.advanced = true;
    requestAdvance();
  }

  /** O YouTube reaproveita o mesmo <video> para o proximo Short: recomeca a contagem. */
  function handleSourceChange() {
    resetTracker();
  }

  const VIDEO_EVENTS = [
    ["timeupdate", handleTimeUpdate],
    ["ended", handleEnded],
    ["loadstart", handleSourceChange],
    ["emptied", handleSourceChange],
    ["durationchange", handleSourceChange],
  ];

  function attachVideo(video) {
    state.tracker = { video, lastTime: video.currentTime || 0, advanced: false };
    for (const [type, handler] of VIDEO_EVENTS) video.addEventListener(type, handler);
    debug("video ativo anexado", video.currentSrc || "(sem src)");
  }

  function detachVideo() {
    const tracker = state.tracker;
    if (!tracker) return;
    for (const [type, handler] of VIDEO_EVENTS) {
      tracker.video.removeEventListener(type, handler);
    }
    state.tracker = null;
    debug("video ativo desanexado");
  }

  function syncActiveVideo() {
    if (!state.enabled) return;
    if (!isShortsPage()) {
      detachVideo();
      return;
    }
    const video = findActiveVideo();
    if (!video) {
      detachVideo();
      return;
    }
    if (state.tracker && state.tracker.video === video) return;
    detachVideo();
    attachVideo(video);
  }

  /** Junta varias mutacoes/eventos num unico sync por frame. */
  function scheduleSync() {
    if (!state.enabled || state.syncHandle) return;
    state.syncHandle = requestAnimationFrame(() => {
      state.syncHandle = 0;
      syncActiveVideo();
    });
  }

  // ---------------------------------------------------------------------------
  // Avanco para o proximo Short
  // ---------------------------------------------------------------------------

  /** Chave do Short atual: muda quando o avanco deu certo. */
  function advanceKey() {
    const video = state.tracker ? state.tracker.video : null;
    return location.pathname + "|" + (video && video.currentSrc ? video.currentSrc : "");
  }

  function tryNextButton() {
    const button = document.querySelector(SELECTORS.NEXT_BUTTON);
    // Em tela cheia esse botao normalmente esta escondido — daí caimos nos fallbacks.
    if (!button || button.disabled || !isVisible(button)) return false;
    button.click();
    debug("avanco: botao proximo");
    return true;
  }

  function tryScrollNext() {
    let reel = document.querySelector(SELECTORS.ACTIVE_REEL);
    if (!reel && state.tracker) reel = state.tracker.video.closest(SELECTORS.REEL);
    if (!reel) return false;

    let next = reel.nextElementSibling;
    while (next && !next.matches(SELECTORS.REEL)) next = next.nextElementSibling;
    if (!next) return false;

    next.scrollIntoView({ behavior: "smooth", block: "start" });
    debug("avanco: scrollIntoView no proximo reel");
    return true;
  }

  function tryArrowDown() {
    // Em tela cheia o alvo precisa ser o elemento em fullscreen; fora dela, o app.
    const target =
      document.fullscreenElement ||
      document.querySelector(SELECTORS.SHORTS_APP) ||
      document.body;
    if (!target) return false;
    const init = {
      key: "ArrowDown",
      code: "ArrowDown",
      keyCode: 40,
      which: 40,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    debug("avanco: ArrowDown sintetico");
    return true;
  }

  /**
   * Estrategias em ordem. Como "rolar" nao da pra confirmar na hora (e em tela
   * cheia costuma nao funcionar), verificamos depois se o Short mudou de fato
   * e so entao passamos para o proximo fallback.
   */
  function requestAdvance() {
    const now = Date.now();
    if (now - state.lastAdvanceAt < MIN_ADVANCE_INTERVAL_MS) return;
    state.lastAdvanceAt = now;

    const key = advanceKey();
    if (tryNextButton()) {
      verifyAdvance(key, 1);
      return;
    }
    if (tryScrollNext()) {
      verifyAdvance(key, 2);
      return;
    }
    tryArrowDown();
  }

  function verifyAdvance(key, stage) {
    setTrackedTimeout(() => {
      if (!state.enabled || !isShortsPage()) return;
      if (advanceKey() !== key) return; // mudou de Short: deu certo.
      if (stage === 1 && tryScrollNext()) {
        verifyAdvance(key, 2);
        return;
      }
      tryArrowDown();
    }, VERIFY_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // Observadores (so existem enquanto a extensao esta ligada)
  // ---------------------------------------------------------------------------

  const onMutation = () => scheduleSync();
  const onNavigate = () => {
    rebindObserver();
    scheduleSync();
  };
  const onMediaEvent = () => scheduleSync();

  function rebindObserver() {
    if (state.observer) state.observer.disconnect();
    if (!state.enabled || !isShortsPage()) return;
    const target = document.querySelector(SELECTORS.SHORTS_APP) || document.body;
    if (!target) return;
    state.observer = state.observer || new MutationObserver(onMutation);
    state.observer.observe(target, { childList: true, subtree: true });
  }

  function addGlobalListeners() {
    // yt-navigate-finish: navegacao da SPA (home -> Shorts sem recarregar).
    document.addEventListener("yt-navigate-finish", onNavigate);
    window.addEventListener("popstate", onNavigate);
    document.addEventListener("fullscreenchange", onNavigate);
    // Eventos de midia nao borbulham, mas chegam na fase de captura: assim
    // detectamos o novo <video> ativo sem depender so do MutationObserver.
    document.addEventListener("play", onMediaEvent, true);
    document.addEventListener("loadedmetadata", onMediaEvent, true);
  }

  function removeGlobalListeners() {
    document.removeEventListener("yt-navigate-finish", onNavigate);
    window.removeEventListener("popstate", onNavigate);
    document.removeEventListener("fullscreenchange", onNavigate);
    document.removeEventListener("play", onMediaEvent, true);
    document.removeEventListener("loadedmetadata", onMediaEvent, true);
  }

  // ---------------------------------------------------------------------------
  // Liga / desliga
  // ---------------------------------------------------------------------------

  function enable() {
    if (state.enabled) return;
    state.enabled = true;
    addGlobalListeners();
    rebindObserver();
    syncActiveVideo();
    debug("ligado");
  }

  function disable() {
    if (!state.enabled) return;
    state.enabled = false;
    removeGlobalListeners();
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.syncHandle) {
      cancelAnimationFrame(state.syncHandle);
      state.syncHandle = 0;
    }
    clearTrackedTimers();
    detachVideo();
    debug("desligado");
  }

  function applyEnabled(value) {
    if (value) enable();
    else disable();
  }

  function start() {
    try {
      chrome.storage.local.get({ [STORAGE_KEY]: false }, (result) => {
        if (chrome.runtime.lastError) return; // falha silenciosa
        applyEnabled(Boolean(result[STORAGE_KEY]));
      });
      // Mudanca no popup vale na hora, sem recarregar a aba.
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[STORAGE_KEY]) return;
        applyEnabled(Boolean(changes[STORAGE_KEY].newValue));
      });
    } catch (error) {
      debug("storage indisponivel", error);
    }
  }

  start();
})();
