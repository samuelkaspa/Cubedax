# Cubo Preto – Multiplayer (GitHub + Cloudflare)

## Estrutura do repositório
```
wrangler.toml
src/worker.js      <- arquivo worker.js
public/index.html  <- arquivo index.html
```
(No GitHub, ao criar o arquivo, digite `public/index.html` no nome para criar a pasta.)

## Publicar
1. Suba os 3 arquivos para um repositório no GitHub.
2. Cloudflare → Workers & Pages → Create → **Import a repository** → escolha o repo.
3. Comando de deploy: `npx wrangler deploy` (padrão). Plano grátis funciona (Durable Object com SQLite).
4. Abra o endereço `*.workers.dev` em dois aparelhos e teste: Modo multiplayer → Criar sala / Entrar.

O site e o servidor ficam no mesmo endereço, então não precisa configurar nada.
Se preferir site no Cloudflare Pages e o servidor separado, adicione antes do `<script>` do jogo:
`<script>window.CUBO_SERVER='wss://SEU-WORKER.workers.dev/ws'</script>`

## Regras implementadas
- Sala de 2 a 4, pública (aparece em tempo real na lista) ou privada (só por código; entrar por código ignora o "privado").
- Todos (menos o anfitrião) apertam Pronto; o anfitrião inicia.
- 30 mapas para zerar. Tempo de 20s por mapa e contagem de 2s antes de cada mapa (também no solo).
- Morreram todos: "Tentar de novo 0/N"; quando todos votam, recomeça do mapa 1.
- Cartas: votação, a mais votada vence (15s). Um jogador chegando no portal passa o mapa para todos.
- Recorde (maior nível) salvo no aparelho; aparece na tela inicial e na sala.
- Nome em Configurações, mostrado sobre o personagem.
