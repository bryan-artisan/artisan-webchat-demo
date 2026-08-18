# Northwind Robotics — Artisan web-chat embedding demo

A self-contained, static marketing landing page for a fictional company
(Northwind Robotics) that embeds the Artisan web-chat widget. It exists to
demonstrate cross-origin embedding: the page is served from one origin and the
chat iframe is served from the Artisan app origin.

Everything here is local and static. There is no build step and no backend.

## Files

```
.
├── index.html      # The landing page + the widget bootstrap
├── config.js       # Site key + embed origin (the only thing you edit)
├── embed/
│   └── loader.js   # Exact copy of the Artisan loader (apps/web/public/embed/loader.js)
└── README.md
```

## How to run it locally

The page is static, but it must be served over http (opening the file with a
`file://` URL breaks relative script loading and the widget). From this folder:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

You also need the Artisan app running at the embed origin (default
`http://localhost:3000`) so the iframe and the loader's target exist.

## Configuring the widget

Edit `config.js`:

- `window.ARTISAN_WEBCHAT_SITE_KEY` — the tenant's public site key (starts with
  `sk_`). Copy it from the Artisan web-chat publish screen. Until this is set to
  a real value (it ships as `REPLACE_WITH_SITE_KEY`), the bootstrap logs a
  warning and does not load the widget.
- `window.ARTISAN_WEBCHAT_EMBED_ORIGIN` — the Artisan app origin that serves the
  chat iframe. `http://localhost:3000` for local dev, or a deployed Artisan URL.

`config.js` is the single source of truth. `index.html` reads those two globals
and injects the loader with `data-site-key` and `data-embed-origin`.

## How the embedding actually works

The widget bootstrap in `index.html` injects the loader dynamically instead of
using a static `<script>` tag, so the site key can come from `config.js` at
runtime. Two details from the loader's source (`embed/loader.js`) drive the
design:

1. The loader finds its own `<script>` element with:

   ```js
   const resolveScript = () => {
     if (document.currentScript instanceof HTMLScriptElement) {
       return document.currentScript;
     }
     // Fallback for async injection where document.currentScript is null: find by src.
     const scripts = document.querySelectorAll('script[src*="/embed/loader.js"]');
     return scripts.length > 0 ? scripts[scripts.length - 1] : null;
   };
   ```

   A dynamically injected script always has `document.currentScript === null`
   when it runs, so the loader falls back to the selector
   `script[src*="/embed/loader.js"]`. That is why the copy lives at
   `embed/loader.js` and the bootstrap injects `src="./embed/loader.js"`: the
   substring `/embed/loader.js` is present, the selector matches, and the loader
   resolves itself. A root-level `./loader.js` would not match the selector and
   the widget would silently never render. This also mirrors the production path
   (`https://app.artisan.co/embed/loader.js`).

2. The loader reads these `data-*` attributes off that script element:

   - `data-site-key` (required) — the tenant public key. Missing key = quiet
     no-op with a `console.warn`.
   - `data-embed-origin` (optional) — overrides the Artisan origin the iframe is
     served from. When absent, the loader derives it from its own `script.src`
     origin. We set it explicitly from `config.js`, which is required here
     because the loader is served from this demo's origin, not from Artisan.
   - `data-vector-cookie` (optional) — overrides the first-party Vector cookie
     name (default `vector_up_id`) the loader reads to forward a `visitorHint`.
     Not used by this demo.

   The loader then injects the launcher bubble and, on first open, a cross-origin
   `<iframe>` at `<embed-origin>/embed/web-chat?siteKey=...`.

The loader itself makes no API calls. All bootstrap, streaming, and sending
happen inside the iframe, which is same-origin to the Artisan API.

## Publishing to GitHub Pages (documentation only — not run here)

These commands publish the demo to GitHub Pages under the `bryan-artisan`
account. Run them yourself; they are documented here, not executed by this
build.

```bash
# From this directory, with a local git repo already committed:
gh repo create bryan-artisan/artisan-webchat-demo --public --source=. --remote=origin --push

# Enable GitHub Pages from the default branch root:
gh api -X POST repos/bryan-artisan/artisan-webchat-demo/pages \
  -f "source[branch]=main" -f "source[path]=/"
```

The published page will be at:

```
https://bryan-artisan.github.io/artisan-webchat-demo/
```

Its origin (scheme + host, no path) is:

```
https://bryan-artisan.github.io
```

For a deployed demo, set `ARTISAN_WEBCHAT_EMBED_ORIGIN` in `config.js` to a
reachable Artisan app origin before publishing.

## Origin allowlist notes (`WEB_CHAT_EMBED_ORIGINS`)

Be precise about what needs allowlisting, because the widget's API calls come
from the iframe, not from this page:

- The API's public web-chat CORS allowlist and origin check both key off the
  **iframe (embed) origin** — the value in `ARTISAN_WEBCHAT_EMBED_ORIGIN`. That
  origin must be present in the API's `WEB_CHAT_EMBED_ORIGINS`. For local dev the
  default already includes `http://localhost:3000`
  (`WEB_CHAT_DEFAULT_EMBED_ORIGINS`), so nothing extra is needed locally.
- This demo page's own origin (`https://bryan-artisan.github.io`) is **not** the
  origin that hits the API, so strictly it does not need to be in
  `WEB_CHAT_EMBED_ORIGINS` for the widget to function. The mechanism that would
  cover a customer's page origin, if origin enforcement is ever tightened, is the
  org's tracked-domain allowlist, not this env var.
- If you deploy the iframe at a non-default Artisan origin, add THAT origin to
  `WEB_CHAT_EMBED_ORIGINS` (comma-separated) for the target environment.

## Visiting as a real lead ("visit-as" picker)

`config.js` also sets `window.ARTISAN_WEBCHAT_VISIT_AS_SERVER`, which loads a
floating picker (bottom-left pill) letting you search real leads in the org
and de-anonymize the visitor as one of them, without the vendor round-trip a
real Vector/Demandbase identification would take.

It needs its own sidecar server, from `apps/web-chat-e2e` in the artisan repo:

```bash
DATABASE_URL=<postgres-url-for-the-env-you're-testing> pnpm visit-as
```

Point `DATABASE_URL` at whatever the widget's own API is reading from for the
environment you're testing against (dev RDS for the preview deployment, a
branch-workspace tunnel, or your local Postgres). The sidecar resolves the org
from the page's own site key, so the same server works unmodified against any
environment.

Picking a person seeds a fresh `website_visitor` row with a new Vector
`up_id` and sets that as this page's `vector_up_id` cookie. It does **not**
reach into an already-open conversation: web-chat only resolves identity once,
on a fresh conversation, and only ever moves anonymous → identified, never
back and never to a different person. To see the seeded identity, start a
genuinely new conversation — a private/incognito window, or clearing this
site's storage in the current one.

Leave `ARTISAN_WEBCHAT_VISIT_AS_SERVER` unset to skip loading the picker
entirely; a real customer's copy of this page never sets it.

## Mixed-content caveat

GitHub Pages serves over HTTPS. If `ARTISAN_WEBCHAT_EMBED_ORIGIN` points at
`http://localhost:3000`, the HTTPS page is loading an `http://` iframe, which is
mixed content. Current Chrome usually permits `http://localhost` / loopback as a
special case, but other browsers (and stricter Chrome policies) may block it. If
the iframe is blocked, point `ARTISAN_WEBCHAT_EMBED_ORIGIN` at an HTTPS URL
instead — either a deployed Artisan environment or an HTTPS tunnel (e.g. an
ngrok/Cloudflare tunnel) in front of your local app.
