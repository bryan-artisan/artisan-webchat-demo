// Single source of truth for the Artisan web-chat embed on this demo site.
//
// The widget bootstrap in index.html reads window.ARTISAN_WEBCHAT_SITE_KEY and
// window.ARTISAN_WEBCHAT_EMBED_ORIGIN, set below from whichever environment is
// selected. The environment is picked with the top-left FAB in index.html,
// which reflects the choice in the URL as ?env=inbound|dev|prod so a link can
// be shared pinned to one environment. Default: inbound.

window.ARTISAN_WEBCHAT_ENVIRONMENTS = {
  inbound: {
    label: 'Inbound',
    // Real site key auto-minted by the inbound console (app-inbound.dev.artisan.co)
    // for a demo org. Verified: POST /api/public/web-chat/bootstrap returns 200.
    siteKey: 'sk_1BFPomgPol49WRKyDjCgPjybDXs-kBUW',
    // Inbound branch-preview web host (HTTPS, so no mixed-content on GitHub Pages).
    // NOTE: the web_chat schema is migrated in dev and the key above resolves, so
    // the API side works. The one remaining blocker is CORS on the preview API:
    // its WEB_CHAT_EMBED_ORIGINS must include https://app-inbound.dev.artisan.co
    // (currently the default http://localhost:3000), so the browser preflight from
    // the iframe origin gets no Access-Control-Allow-Origin and the bootstrap fetch
    // is blocked. Once devops sets that env on api-inbound, the chat opens.
    embedOrigin: 'https://app-inbound.dev.artisan.co',
  },
  dev: {
    label: 'Dev',
    siteKey: 'sk_1BFPomgPol49WRKyDjCgPjybDXs-kBUW',
    embedOrigin: 'https://app.dev.artisan.co',
  },
  prod: {
    label: 'Prod',
    siteKey: 'sk_1BFPomgPol49WRKyDjCgPjybDXs-kBUW',
    embedOrigin: 'https://app.artisan.co',
  },
};

window.ARTISAN_WEBCHAT_DEFAULT_ENV = 'inbound';

(() => {
  const params = new URLSearchParams(window.location.search);
  const requestedEnv = params.get('env');
  const environments = window.ARTISAN_WEBCHAT_ENVIRONMENTS;
  const env = requestedEnv && environments[requestedEnv] ? requestedEnv : window.ARTISAN_WEBCHAT_DEFAULT_ENV;
  const config = environments[env];

  window.ARTISAN_WEBCHAT_ENV = env;
  window.ARTISAN_WEBCHAT_SITE_KEY = config.siteKey;
  window.ARTISAN_WEBCHAT_EMBED_ORIGIN = config.embedOrigin;
})();

// Optional: the "visiting as" picker (apps/web-chat-e2e/src/tools/visit-as in
// the artisan repo). Point it at wherever you're running that sidecar
// (`pnpm visit-as`, default port 4700); leave unset to skip loading it. It
// lets you pick a real lead from the org and seed a fresh de-anonymized
// `website_visitor` row for them, so the widget's NEXT conversation resolves
// as that person instead of anonymous. It cannot change the identity of a
// conversation already open in the widget: web-chat only resolves identity
// once, on a fresh conversation, and only anonymous -> identified.
window.ARTISAN_WEBCHAT_VISIT_AS_SERVER = 'http://localhost:4700';
