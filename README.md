# cubedax – Multiplayer (GitHub + Cloudflare)

## Estrutura do repositório
```
wrangler.jsonc
package.json
worker.js
public/index.html
```
Publicar: Cloudflare → Workers & Pages → Import a repository. Deploy: `npx wrangler deploy`.
O nome do Worker no Cloudflare precisa ser igual ao "name" do wrangler.jsonc (cubedax).
