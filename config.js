// Single source of truth for the Artisan web-chat embed on this demo site.
//
// The widget bootstrap in index.html reads window.ARTISAN_WEBCHAT_SITE_KEY and
// window.ARTISAN_WEBCHAT_EMBED_ORIGIN, set below from whichever environment is
// selected. The environment is picked with the top-left FAB in index.html,
// which reflects the choice in the URL as ?env=inbound|dev|prod so a link can
// be shared pinned to one environment. Default: inbound.
//
// This same embed origin also serves the "visit as" picker (visit-as.js) at
// /visit-as, opened in a popup by the pill on this page. See README.md.

window.ARTISAN_WEBCHAT_ENVIRONMENTS = {
  inbound: {
    label: 'Inbound',
    // Real site key auto-minted by the inbound console (app-inbound.dev.artisan.co)
    // for a demo org. Verified: POST /api/public/web-chat/bootstrap returns 200.
    siteKey: 'sk_1BFPomgPol49WRKyDjCgPjybDXs-kBUW',
    // Inbound branch-preview web host (HTTPS, so no mixed-content on GitHub Pages).
    embedOrigin: 'https://app-inbound.dev.artisan.co',
  },
  dev: {
    label: 'Dev',
    siteKey: 'sk_1BFPomgPol49WRKyDjCgPjybDXs-kBUW',
    // No "app." prefix on dev, unlike prod: the dev console itself serves from
    // https://dev.artisan.co (confirmed from a real install snippet copied off
    // that console), not https://app.dev.artisan.co.
    embedOrigin: 'https://dev.artisan.co',
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
