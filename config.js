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
// This origin also serves the "visit as" picker at /visit-as, which the pill on
// this page opens in a popup. See README.md.
window.ARTISAN_WEBCHAT_EMBED_ORIGIN = 'https://app-inbound.dev.artisan.co';
