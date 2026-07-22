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
window.ARTISAN_WEBCHAT_EMBED_ORIGIN = 'http://localhost:3010';
