# Jarvis no Windows

No Windows, o Jarvis corre sozinho: um ícone na barra de tarefas, o atalho
**Ctrl+Alt+Espaço** e a HUD com a onda sonora. Faz tudo o que faz no Mac
(conversa em streaming, memória, lembretes por voz, voz à escolha, Google
Calendar, Gmail, avisos e Google Meet). Só a app completa do Grok Bot é
exclusiva do macOS.

## Opção 1: instalador (recomendado)

1. Descarrega
   **[Jarvis-Setup.exe](https://github.com/Malakipt123/grok-bot-0.18-reconstructed/releases/download/jarvis-windows-latest/Jarvis-Setup.exe)**
   (cerca de 130 MB; já traz o ffmpeg).
2. Abre-o. Como o instalador não está assinado, o Windows pode mostrar
   «O Windows protegeu o seu PC»: carrega em **Mais informações → Executar
   mesmo assim**. Não pede permissões de administrador.
3. No fim, deixa **Executar Jarvis** selecionado.
4. Aparece a janela **Configurar o Jarvis**: cola a chave da xAI
   (https://console.x.ai) e a da ElevenLabs
   (https://elevenlabs.io/app/settings/api-keys) e carrega em **Guardar e
   iniciar**. Os campos do Google são opcionais.
5. Confirma o acesso ao microfone (passo 3, mais abaixo) e carrega em
   **Ctrl+Alt+Espaço**.

- As chaves ficam cifradas pelo Windows (DPAPI) em `%APPDATA%\Jarvis`. Para
  as mudar, usa **Chaves…** no menu do ícone ou abre o Jarvis outra vez no
  menu Iniciar.
- Atualizar: descarrega e corre outra vez o `Jarvis-Setup.exe`. As chaves e
  a memória ficam.
- Desinstalar: Definições → Aplicações → Jarvis → Desinstalar. As chaves e a
  pasta `.grok-bot` (memória, notas, lembretes) ficam no computador; apaga-as
  à mão se quiseres.
- Há também um zip portátil, `Jarvis-win-x64.zip`, na
  [mesma página](https://github.com/Malakipt123/grok-bot-0.18-reconstructed/releases/tag/jarvis-windows-latest):
  descompacta-o e abre `Jarvis.exe`.

## Opção 2: a partir do código

### 1. Instalar (uma vez, cerca de 10 minutos)

Abre o **PowerShell** e corre:

```powershell
winget install OpenJS.NodeJS.LTS Gyan.FFmpeg Git.Git
```

Fecha e volta a abrir o PowerShell (para o `node`, o `ffmpeg` e o `git`
ficarem disponíveis), e depois:

```powershell
git clone https://github.com/Malakipt123/grok-bot-0.18-reconstructed.git
cd grok-bot-0.18-reconstructed
npm ci --ignore-scripts
node node_modules/electron/install.js
```

O `--ignore-scripts` evita compilar módulos nativos do Grok Bot de que o
Jarvis não precisa (e que exigiriam o Visual Studio). A segunda linha
descarrega o Electron.

### 2. Chaves

```powershell
setx XAI_API_KEY "a-tua-chave-xai"
setx ELEVENLABS_API_KEY "a-tua-chave-elevenlabs"
```

- xAI: https://console.x.ai
- ElevenLabs: https://elevenlabs.io/app/settings/api-keys

O `setx` guarda as chaves para sempre, mas só os terminais **novos** as veem.
Fecha e abre o PowerShell outra vez. (Se não definires as chaves, o
`npm run jarvis` abre a mesma janela **Configurar o Jarvis** do instalador.)

Opcional, para o Google Calendar: `setx GOOGLE_CLIENT_ID "..."` e
`setx GOOGLE_CLIENT_SECRET "..."` (o guia para criar o cliente está em
[source/voice-assistant/README.md](../source/voice-assistant/README.md#google-calendar)).

## 3. Microfone (as duas opções)

Em **Definições → Privacidade e segurança → Microfone**, liga **Permitir que
as aplicações de ambiente de trabalho acedam ao microfone**.

O Jarvis usa o primeiro microfone que o ffmpeg encontra. Se for o errado:

```powershell
ffmpeg -list_devices true -f dshow -i dummy
setx JARVIS_MIC "Microfone (USB Audio)"   # o nome exato que apareceu entre aspas
```

### 4. Usar

```powershell
cd grok-bot-0.18-reconstructed
npm run jarvis
```

- Aparece um anel azul-claro na barra de tarefas (talvez escondido na seta
  **^**) e uma notificação «Ready. Press Control+Alt+Space to talk.».
- **Ctrl+Alt+Espaço** começa a ouvir (som *Speech On*). Carrega outra vez
  para enviar (som *Speech Off*). Carregar enquanto ele fala interrompe-o.
- No menu do ícone: **Chaves…**, **Iniciar com o sistema** (o Jarvis arranca sozinho quando
  entras no Windows), **Abrir pasta do Jarvis** (`ASSISTANT.md`, notas,
  memória, lembretes) e **Sair**.
- Preferes o terminal? `npm run voice` funciona no mesmo PowerShell.

Experimenta: «que horas são?», «abre o Spotify», «volume a 30»,
«lembra-me de ligar à Ana às 17h», «adia 10 minutos», «liga o calendário»,
«o que tenho amanhã?», «abre a reunião».

## Problemas comuns

| Sintoma | Solução |
|---|---|
| «Add XAI_API_KEY and ELEVENLABS_API_KEY…» | Fizeste `setx` mas não abriste um terminal novo, ou usa **Chaves…** no menu do ícone. |
| «No microphone recorder found» | Opção 2: o ffmpeg não está no PATH; abre um terminal novo ou reinstala com `winget install Gyan.FFmpeg`. (O instalador já o traz.) |
| Ouve silêncio ou o microfone errado | Define `JARVIS_MIC` (passo 3) e confirma a permissão do microfone. |
| «… is already used by another application» | Outra app usa Ctrl+Alt+Espaço: `setx JARVIS_SHORTCUT "Control+Shift+J"`. |
| Não há notificações | Ativa as notificações em Definições → Sistema → Notificações. |
| `npm run jarvis` diz que não encontra o Electron | Corre outra vez `node node_modules/electron/install.js`. |

As palavras podem acender na HUD uma fração de segundo antes do som, porque o
PowerShell demora um pouco a começar a tocar.
