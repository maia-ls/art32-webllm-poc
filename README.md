# PoC WebLLM para parser de reivindicações

## Publicação sem instalar nada

1. Crie um repositório no GitHub pelo navegador.
2. Envie `index.html` e `app.js` para a raiz.
3. Em **Settings > Pages**, publique a branch principal.
4. Abra a URL HTTPS gerada no Edge ou Chrome.

Também funciona em Azure Static Web Apps ou Cloudflare Pages.

## Teste

1. Clique em **Solicitar persistência**.
2. Selecione o modelo. Comece pelo 1B para compatibilidade; depois teste o 3B.
3. Clique em **Baixar/carregar modelo**.
4. Use **Carregar exemplo**.
5. Clique em **Extrair estrutura** e depois **Auditar extração**.
6. Exporte o JSON.

## Privacidade

O texto só é processado após o modelo estar carregado no navegador. O aplicativo não contém endpoint de inferência remoto, telemetria ou analytics. O primeiro uso baixa runtime e pesos estáticos.

## Observações

- Requer HTTPS e WebGPU.
- O cache do modelo pertence à origem do site.
- Modo privado não é recomendado.
- A persistência pode ser negada por política corporativa.
