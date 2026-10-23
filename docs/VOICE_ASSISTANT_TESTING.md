# Testes manuais do Jarvis no Mac

Checklist para validar o assistente de voz do PR #1 num Mac com Apple Silicon, Node 26.5 e chaves reais. Faz as secções pela ordem.

## Como marcar

- Funciona: troca `- [ ]` por `- [x]`.
- Falha: deixa `- [ ]` e acrescenta por baixo uma linha `  - **Falha:** o que aconteceu`, com o erro do terminal se houver.
- Saltado: deixa `- [ ]` e acrescenta `  - **Saltado:** porquê`.

Quando terminares, faz commit e push deste ficheiro para o branch `ccr-ee33ddc5-umzzz4` e diz ao Claude «vê os testes».

Para os avisos não demorarem, arranca com `JARVIS_REMINDER_MINUTES=2` e cria um evento com Meet para daqui a 4 minutos.

## 1. Preparação

Instala as dependências e confirma que o repositório passa os testes no Mac.

- [ ] **Obter o branch do PR**
  ```sh
  git fetch origin
  git checkout ccr-ee33ddc5-umzzz4
  ```
  Esperado: O branch fica ativo e `git status` diz que está atualizado com `origin/ccr-ee33ddc5-umzzz4`.

- [ ] **Instalar e correr os testes**
  ```sh
  npm ci
  npm run check
  ```
  Esperado: Os typechecks e todos os testes passam, incluindo os 45 de voice-assistant.

- [ ] **Instalar o gravador de áudio**
  ```sh
  brew install sox
  ```
  Esperado: O comando sox existe (sox --version).

- [ ] **Exportar as chaves**
  ```sh
  export XAI_API_KEY=...
  export ELEVENLABS_API_KEY=...
  ```
  Esperado: As duas variáveis estão definidas no terminal que vais usar.

## 2. Terminal

O mesmo assistente, sem a app. É a forma mais rápida de confirmar o Grok, o ElevenLabs e o microfone.

- [ ] **Arrancar o assistente**
  ```sh
  npm run voice
  ```
  Esperado: Aparece «Jarvis ready · Grok grok-4 · ElevenLabs eleven_v3» e é criado o ~/.grok-bot/voice-assistant/ASSISTANT.md.

- [ ] **Pergunta escrita em streaming**
  Escreve «Qual é a capital da Austrália?» e carrega em Enter.
  Esperado: O texto aparece aos poucos e a voz começa antes de a resposta acabar de chegar. As etiquetas como [laughs] não aparecem no texto.

- [ ] **Falar com o microfone**
  Carrega em Enter com a linha vazia, fala, e carrega em Enter outra vez.
  Esperado: Aparece «You: …» com o que disseste e o Jarvis responde por voz.

- [ ] **Comandos locais**
  Diz ou escreve «abre o Safari», «põe o volume a 30» e «que horas são?».
  Esperado: Os três executam logo, sem esperar pelo Grok.

- [ ] **Interromper a fala**
  Durante uma resposta longa, carrega em Enter para começar a gravar.
  Esperado: A voz para logo e começa a gravação.

## 3. Memória

Os factos e a conversa recente sobrevivem a reinícios.

- [ ] **Guardar um facto**
  Diz «Lembra-te que o meu nome é …».
  Esperado: Responde «Fica registado.» sem chamar o Grok, e /memory mostra [m1].

- [ ] **Lembrar depois de reiniciar**
  Escreve /quit, volta a correr npm run voice e pergunta «Como me chamo?».
  Esperado: Sabe o teu nome e continua a conversa anterior.

- [ ] **Recusar segredos**
  Diz «Lembra-te que a minha senha é 1234».
  Esperado: Não é guardado. /memory não mostra nada novo e o Jarvis explica porquê.

- [ ] **Ficheiro privado**
  ```sh
  ls -l ~/.grok-bot/voice-assistant/memory.json
  ```
  Esperado: As permissões são -rw------- (0600).

- [ ] **Apagar tudo**
  Escreve /forget all.
  Esperado: /memory fica vazio e a conversa seguinte começa do zero.

## 4. App e atalho Option+Espaço

Empacota a app e testa o atalho global com outra app em primeiro plano.

- [ ] **Empacotar e abrir a partir do terminal**
  ```sh
  npm run package
  open "dist/Grok Bot 0.18 Reconstructed.app"
  ```
  Esperado: A app abre normalmente. O arranque não fica mais lento por causa do Jarvis.

- [ ] **Pedido de permissão do microfone**
  Carrega em Option+Espaço pela primeira vez.
  Esperado: O macOS pergunta se o Grok Bot pode usar o microfone, com o texto do atalho. Depois de aceitares, ouves um «Tink».

- [ ] **Atalho com outra app à frente**
  Põe o Safari em primeiro plano, carrega em Option+Espaço, fala e carrega outra vez.
  Esperado: Funciona sem trazer a janela do Grok Bot para a frente. Ouves «Tink» ao começar e «Pop» ao enviar.

- [ ] **Interromper enquanto pensa ou fala**
  Carrega em Option+Espaço enquanto a HUD está âmbar ou o Jarvis está a falar.
  Esperado: Para logo e volta a ouvir. A resposta anterior não continua por trás.

- [ ] **Gravação limitada a 30 segundos**
  Carrega em Option+Espaço e não voltes a carregar.
  Esperado: Ao fim de cerca de 30 segundos envia sozinho.

- [ ] **Reabrir a janela pela Dock**
  Fecha a janela principal, usa o atalho uma vez e depois clica no ícone da Dock.
  Esperado: A janela principal volta a abrir. A HUD não a impede.

- [ ] **Sem chaves, sem atalho**
  Abre a app pelo Finder, sem as chaves nos segredos da app.
  Esperado: Option+Espaço não faz nada e a app funciona como antes.

## 5. HUD

A janela flutuante com o anel e a onda sonora.

- [ ] **Posição e foco**
  Usa o atalho com uma app de texto aberta.
  Esperado: A HUD aparece no topo, ao centro, sem roubar o foco. Os cliques passam através dela.

- [ ] **Onda sonora segue a tua voz**
  Fala alto e baixo enquanto grava.
  Esperado: As barras sobem e descem com o volume da tua voz.

- [ ] **Estado a pensar**
  Envia uma pergunta.
  Esperado: O anel e a onda ficam âmbar até a voz começar.

- [ ] **Texto palavra a palavra**
  Faz uma pergunta com resposta longa.
  Esperado: As palavras aparecem aos poucos, esbatidas, e acendem exatamente quando são ditas.

- [ ] **Desaparecer no fim**
  Espera depois de o Jarvis acabar.
  Esperado: A HUD desaparece cerca de 2,5 segundos depois.

- [ ] **Ecrã inteiro e outros desktops**
  Usa o atalho com uma app em ecrã inteiro ou noutro desktop (Space).
  Esperado: A HUD aparece por cima dessa app.

## 6. Google Calendar

Precisa do teu OAuth client de Desktop. Os passos estão em source/voice-assistant/README.md.

- [ ] **Configurar o cliente**
  ```sh
  export GOOGLE_CLIENT_ID=....apps.googleusercontent.com
  export GOOGLE_CLIENT_SECRET=...
  ```
  Esperado: Em npm run voice, /google mostra «not connected» e não «not configured».

- [ ] **Ligar por voz**
  Diz «liga o calendário» e aprova no browser.
  Esperado: O browser abre a página da Google. Depois de aprovares aparece «Google Calendar ligado» e o ~/.grok-bot/voice-assistant/google-token.json fica com 0600.

- [ ] **Ler a agenda**
  Pergunta «o que tenho amanhã?».
  Esperado: Lista os eventos certos, à hora certa no teu fuso, sem ler URLs.

- [ ] **Criar um evento com confirmação**
  Diz «marca dentista na terça» e depois indica a hora.
  Esperado: Pergunta a hora antes de criar. O evento aparece no Google Calendar com 1 hora de duração.

- [ ] **Desligar**
  Em npm run voice, escreve /google disconnect.
  Esperado: O token é apagado e a app deixa de aparecer em myaccount.google.com/connections.

## 7. Avisos e Google Meet

Arranca com JARVIS_REMINDER_MINUTES=2 para não esperares 10 minutos.

- [ ] **Aviso antes do evento**
  Cria um evento com Google Meet para daqui a 4 minutos.
  Esperado: Cerca de 2 minutos antes, o Jarvis diz «Daqui a 2 minutos tens … Diz «abre a reunião» para entrares.» e a HUD mostra o texto.

- [ ] **Abrir o Meet**
  Logo a seguir ao aviso, carrega em Option+Espaço e diz «abre a reunião».
  Esperado: O Meet do evento abre no browser e o Jarvis diz «A abrir o Google Meet: …».

- [ ] **Esperar pelo fim da conversa**
  Começa a falar com o Jarvis um pouco antes da hora do aviso.
  Esperado: O aviso só é dito depois de a conversa acabar e não fala por cima de ti.

- [ ] **Evento mudado ou cancelado**
  Muda a hora de um evento já agendado e cancela outro.
  Esperado: O mudado avisa uma vez, na nova hora. O cancelado não avisa.

- [ ] **Link estranho não abre**
  Num evento sem Meet, põe na descrição https://meet.google.com.example.com/x e diz «abre a reunião» durante esse evento.
  Esperado: Não abre nada e responde que não encontrou reunião com link.
