// Single source of truth for the Artisan web-chat embed on this demo site.
//
// The widget bootstrap in index.html reads window.ARTISAN_WEBCHAT_SITE_KEY and
// window.ARTISAN_WEBCHAT_EMBED_ORIGIN, set below from whichever environment is
// selected. The environment is picked with the top-left FAB in index.html,
// which reflects the choice in the URL as ?env=inbound|dev|crmtest|prod so a
// link can be shared pinned to one environment. Default: inbound.
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
  crmtest: {
    label: 'CRM test',
    // Org "Bryan inbound CRM test" (01a0a15d-d20a-75ac-84c5-132312a8dde1), whose
    // HubSpot connection points at the TEST portal 246692133. The inbound/dev key
    // above belongs to an org connected to Artisan's PRODUCTION portal 45571519,
    // so CRM write-back scenarios must run on this environment, never on those.
    siteKey: 'sk_I7GvLMWYgsTuZyoXcbFU1JMQiG1xKSPa',
    embedOrigin: 'https://app-inbound.dev.artisan.co',
  },
  prod: {
    label: 'Prod',
    // Real site key from a prod org's install snippet (web-chat console > install snippet).
    siteKey: 'sk_qvttVXLrv2OdN9h0BAmS4hGeniZ7nDnX',
    // Prod's public app serves from dashboard.artisan.co, not app.artisan.co: the latter
    // 404s on /embed/loader.js while dashboard.artisan.co returns 200 (confirmed live).
    embedOrigin: 'https://dashboard.artisan.co',
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
