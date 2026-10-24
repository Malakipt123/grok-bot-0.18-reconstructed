# Jarvis no Windows

No Windows, o Jarvis corre sozinho: um ícone na barra de tarefas, o atalho
**Ctrl+Alt+Espaço** e a HUD com a onda sonora. Faz tudo o que faz no Mac
(conversa em streaming, memória, lembretes por voz, Google Calendar, avisos e
Google Meet). Só a app completa do Grok Bot é exclusiva do macOS.

## 1. Instalar (uma vez, cerca de 10 minutos)

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

## 2. Chaves

```powershell
setx XAI_API_KEY "a-tua-chave-xai"
setx ELEVENLABS_API_KEY "a-tua-chave-elevenlabs"
```

- xAI: https://console.x.ai
- ElevenLabs: https://elevenlabs.io/app/settings/api-keys

O `setx` guarda as chaves para sempre, mas só os terminais **novos** as veem.
Fecha e abre o PowerShell outra vez.

Opcional, para o Google Calendar: `setx GOOGLE_CLIENT_ID "..."` e
`setx GOOGLE_CLIENT_SECRET "..."` (o guia para criar o cliente está em
[source/voice-assistant/README.md](../source/voice-assistant/README.md#google-calendar)).

## 3. Microfone

Em **Definições → Privacidade e segurança → Microfone**, liga **Permitir que
as aplicações de ambiente de trabalho acedam ao microfone**.

O Jarvis usa o primeiro microfone que o ffmpeg encontra. Se for o errado:

```powershell
ffmpeg -list_devices true -f dshow -i dummy
setx JARVIS_MIC "Microfone (USB Audio)"   # o nome exato que apareceu entre aspas
```

## 4. Usar

```powershell
cd grok-bot-0.18-reconstructed
npm run jarvis
```

- Aparece um anel azul-claro na barra de tarefas (talvez escondido na seta
  **^**) e uma notificação «Ready. Press Control+Alt+Space to talk.».
- **Ctrl+Alt+Espaço** começa a ouvir (som *Speech On*). Carrega outra vez
  para enviar (som *Speech Off*). Carregar enquanto ele fala interrompe-o.
- No menu do ícone: **Iniciar com o sistema** (o Jarvis arranca sozinho quando
  entras no Windows), **Abrir pasta do Jarvis** (`ASSISTANT.md`, notas,
  memória, lembretes) e **Sair**.
- Preferes o terminal? `npm run voice` funciona no mesmo PowerShell.

Experimenta: «que horas são?», «abre o Spotify», «volume a 30»,
«lembra-me de ligar à Ana às 17h», «adia 10 minutos», «liga o calendário»,
«o que tenho amanhã?», «abre a reunião».

## Problemas comuns

| Sintoma | Solução |
|---|---|
| «Add XAI_API_KEY and ELEVENLABS_API_KEY…» | Fizeste `setx` mas não abriste um terminal novo. |
| «No microphone recorder found» | O ffmpeg não está no PATH: abre um terminal novo ou reinstala com `winget install Gyan.FFmpeg`. |
| Ouve silêncio ou o microfone errado | Define `JARVIS_MIC` (passo 3) e confirma a permissão do microfone. |
| «… is already used by another application» | Outra app usa Ctrl+Alt+Espaço: `setx JARVIS_SHORTCUT "Control+Shift+J"`. |
| Não há notificações | Ativa as notificações em Definições → Sistema → Notificações. |
| `npm run jarvis` diz que não encontra o Electron | Corre outra vez `node node_modules/electron/install.js`. |

As palavras podem acender na HUD uma fração de segundo antes do som, porque o
PowerShell demora um pouco a começar a tocar.
