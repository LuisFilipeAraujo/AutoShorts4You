"use strict";

const STORAGE_KEY = "enabled";

const toggleButton = document.getElementById("toggle");
const label = document.getElementById("label");

/** Só textContent/atributos — nada de innerHTML. */
function render(enabled) {
  toggleButton.setAttribute("aria-pressed", String(enabled));
  label.textContent = enabled ? "Ligado" : "Desligado";
}

function readState() {
  chrome.storage.local.get({ [STORAGE_KEY]: false }, (result) => {
    if (chrome.runtime.lastError) return;
    render(Boolean(result[STORAGE_KEY]));
  });
}

toggleButton.addEventListener("click", () => {
  // Lê antes de escrever para não depender do que está desenhado na tela.
  chrome.storage.local.get({ [STORAGE_KEY]: false }, (result) => {
    if (chrome.runtime.lastError) return;
    chrome.storage.local.set({ [STORAGE_KEY]: !result[STORAGE_KEY] });
  });
});

// Mantém o popup em dia se o estado mudar em outro lugar.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  render(Boolean(changes[STORAGE_KEY].newValue));
});

readState();
