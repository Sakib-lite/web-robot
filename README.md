# web-robot

Autonomous browser agent for Chrome. Tell it a task, it drives real tabs — navigate, click, fill, extract — using any configured LLM.

## Structure

- `extension/` — Chrome extension (MV3): side panel agent loop, content-script page driver
- `frontend/` — reserved (Next.js, if a web UI lands later)
- `backend/` — reserved (NestJS, if a server lands later)

## Development

```
npm install
npm run dev      # load extension/.output/chrome-mv3 as unpacked in Chrome
npm test
npm run build
```

Configure LLM providers in the side panel Settings tab: any OpenAI-compatible endpoint works (base URL, API key, model). GLM endpoints get `thinking` and higher `max_tokens` automatically.
