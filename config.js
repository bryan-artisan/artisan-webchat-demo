// Single source of truth for the Artisan web-chat embed on this demo site.
//
// Set these two values, reload the page, and the widget bootstrap in index.html
// will inject the loader with them.
//
//   ARTISAN_WEBCHAT_SITE_KEY   — the tenant's public site key (starts with "sk_").
//                                Get it from the Artisan web-chat publish screen.
//   ARTISAN_WEBCHAT_EMBED_ORIGIN — the Artisan app origin that serves the chat
//                                iframe and the loader. Local dev is
//                                http://localhost:3000; a deployed env would be
//                                e.g. https://app.artisan.co.
// Real site key auto-minted by the inbound console (app-inbound.dev.artisan.co)
// for a demo org. Verified: POST /api/public/web-chat/bootstrap returns 200.
window.ARTISAN_WEBCHAT_SITE_KEY = 'sk_1BFPomgPol49WRKyDjCgPjybDXs-kBUW';
// Inbound branch-preview web host (HTTPS, so no mixed-content on GitHub Pages).
// NOTE: the web_chat schema is migrated in dev and the key above resolves, so
// the API side works. The one remaining blocker is CORS on the preview API:
// its WEB_CHAT_EMBED_ORIGINS must include https://app-inbound.dev.artisan.co
// (currently the default http://localhost:3000), so the browser preflight from
// the iframe origin gets no Access-Control-Allow-Origin and the bootstrap fetch
// is blocked. Once devops sets that env on api-inbound, the chat opens.
window.ARTISAN_WEBCHAT_EMBED_ORIGIN = 'https://app-inbound.dev.artisan.co';
