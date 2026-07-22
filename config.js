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
window.ARTISAN_WEBCHAT_SITE_KEY = 'sk_demo_northwind_inbound_2026';
// Inbound branch-preview web host (HTTPS, so no mixed-content on GitHub Pages).
// NOTE: opening the chat currently 500s — the inbound web_chat schema has not
// been migrated into the shared dev DB, so the public bootstrap endpoint fails
// and the demo site key is not yet provisioned. The launcher bubble renders,
// the conversation does not, until that schema + a real site key land in dev.
window.ARTISAN_WEBCHAT_EMBED_ORIGIN = 'https://app-inbound.dev.artisan.co';
