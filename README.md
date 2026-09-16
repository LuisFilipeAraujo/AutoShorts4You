# AutoShorts4You

Extensão de navegador (Chrome Manifest V3) de uso pessoal que avança automaticamente
para o próximo YouTube Short quando o vídeo atual termina. Sem build, sem dependências,
sem rede.

## Como carregar no Opera

1. Abra `opera://extensions`.
2. Ligue o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione a pasta do repositório
   (`AutoShorts4You/` — a pasta que contém o `manifest.json`, não o arquivo em si).
4. O ícone aparece na barra de extensões. Se não aparecer, clique no menu de
   extensões (peça de quebra-cabeça) e fixe "Shorts Autoscroll".

Depois de editar qualquer arquivo, clique em **Recarregar** no card da extensão em
`opera://extensions` e recarregue a aba do YouTube (só nesse caso — no uso normal
não é preciso recarregar nada).

## Estrutura

```
AutoShorts4You/
  manifest.json   MV3, permissões mínimas
  content.js      toda a lógica (IIFE, sem globais)
  popup.html      popup com o botão liga/desliga
  popup.css       tema claro/escuro via prefers-color-scheme
  popup.js        lê e grava o estado em chrome.storage.local
  icons/          16, 48 e 128 px
  README.md
```

## Como usar

- Clique no ícone da extensão: o popup mostra um único botão com o estado atual
  (**Ligado** / **Desligado**). O padrão é **Desligado**.
- O estado fica salvo em `chrome.storage.local` e sobrevive ao fechamento do navegador.
- Ligar ou desligar vale **na hora** nas abas já abertas, sem recarregar a página.
- Com a extensão ligada e você em `https://www.youtube.com/shorts/...`, o próximo
  Short é aberto sozinho ao fim de cada vídeo — dentro e fora da tela cheia.
- Se você **pausar** o vídeo manualmente antes do fim, nada acontece.

## Permissões e por que cada uma é necessária

| Item | Para quê |
| --- | --- |
| `permissions: ["storage"]` | Guardar o único dado que a extensão tem: o liga/desliga. É o que faz o estado sobreviver ao reinício e o que o content script observa para reagir na hora. |
| `content_scripts.matches: ["https://www.youtube.com/*"]` | O YouTube é uma SPA: dá para ir da home até os Shorts sem recarregar a página, então o script precisa já estar carregado antes de você chegar em `/shorts/`. A lógica só age quando `location.pathname` começa com `/shorts/`. |

O que a extensão **não** pede, de propósito: `host_permissions`, `tabs`, `scripting`,
`activeTab`, `cookies`, `webRequest`, `<all_urls>`. Também não há service worker /
background, nenhuma requisição de rede, nenhum código remoto e nenhuma biblioteca externa.

Dados lidos da página: apenas o `<video>` ativo (`currentTime` / `duration` / `paused`)
e os elementos de navegação dos Shorts. Nada é coletado, enviado ou armazenado.

## Se parar de funcionar

O motivo quase sempre é o YouTube ter mudado o DOM. **Todos** os seletores estão
num único objeto `SELECTORS` no topo de [`content.js`](content.js), com comentários
explicando o papel de cada um:

- `SHORTS_APP` — raiz do app de Shorts (alvo do `MutationObserver`).
- `REEL` / `ACTIVE_REEL` — o container de cada Short e o marcador do que está em exibição.
- `VIDEO_CANDIDATES` — os `<video>` candidatos (há vários no DOM ao mesmo tempo).
- `NEXT_BUTTON` — o botão "próximo Short".

Para diagnosticar, mude `DEBUG = false` para `true` no topo do `content.js`,
recarregue a extensão e acompanhe o console da aba do YouTube filtrando por
`[shorts-autoscroll]`. Com `DEBUG = false` a extensão falha em silêncio: nenhum
erro é jogado no console da página.

Para achar o seletor novo: abra o DevTools na página dos Shorts, inspecione o
elemento correspondente e ajuste apenas a linha do `SELECTORS`.

## Como funciona (resumo)

- **Fim do vídeo:** o `<video>` dos Shorts fica em loop, então `ended` normalmente
  não dispara. O fim é detectado por `timeupdate`: `currentTime` a ≤ 0,3 s de
  `duration`, ou o tempo "voltando" para perto de 0 depois de ter passado de 90%
  da duração. `duration` inválida (`NaN` / `Infinity` / 0) é ignorada.
- **Vídeo ativo:** o `<video>` do reel marcado como ativo; se esse marcador sumir,
  o candidato visível e tocando com maior área na viewport. Os listeners são
  reanexados quando o vídeo ativo muda e removidos do anterior.
- **Uma trava por vídeo** garante exatamente um avanço por término; ela é liberada
  quando o próximo vídeo começa (ou quando o loop recomeça, caso o avanço tenha falhado).
- **Avanço**, em ordem de fallback: clicar no botão "próximo" → rolar o próximo reel
  para a viewport → `keydown` de `ArrowDown`. Como "rolar" não dá para confirmar na
  hora, o resultado é verificado ~0,7 s depois e o fallback seguinte entra se o
  Short não tiver mudado. Em tela cheia o botão fica escondido e é justamente esse
  encadeamento que cobre o caso.
- **Desligado** significa desligado: listeners removidos, `MutationObserver`
  desconectado, timers cancelados — não é só ignorar os eventos.

## Limitações conhecidas

- Depende do DOM do YouTube (ver seção acima).
- Só `https://www.youtube.com` — não cobre `m.youtube.com` nem `youtube.com` sem `www`.
- Não age em iframes (`all_frames: false`); Shorts embutidos em outros sites não são cobertos.
- O `ArrowDown` sintético depende de o YouTube aceitar eventos não confiáveis
  (`isTrusted: false`), o que hoje funciona, mas não é garantido.
