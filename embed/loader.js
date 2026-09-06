// Artisan Ava web-chat loader (AR2-3577, S7).
//
// This is the one-line snippet a customer pastes into their site:
//
//   <script src="https://app.artisan.co/embed/loader.js"
//           data-site-key="sk_your_public_site_key" async></script>
//
// It runs on the CUSTOMER'S page (any origin) and does three things:
//   1. injects a launcher bubble into the host page,
//   2. on first open, injects an <iframe> pointing at the Artisan-hosted chat
//      surface at `<artisan-origin>/embed/web-chat?siteKey=...`, and
//   3. reads the customer's first-party Vector tracking cookie (the `up_id`) and
//      forwards it into the iframe as `visitorHint` so the API can link the chat
//      to the matching de-anon `website_visitor` (AR2-3633). Only the loader can
//      read this cookie — it is first-party to the customer domain, and the
//      iframe is cross-origin to it.
//
// The loader makes exactly ONE request of its own: a cacheable GET to
// `<artisan-origin>/embed/loader-config`, which tells it whether to render a
// launcher here at all, what color it is, and whether this org uses the pinned
// layout (L3, B10). It carries no credentials and nothing about the visitor,
// and it is never a security decision — the API re-checks the kill switch, the
// rollout flag, the origin and the page scope when the chat actually opens.
// Everything else — bootstrap / streaming / sending — still happens INSIDE the
// iframe (same-origin to the Artisan API's CORS allowlist). The loader owns the
// host-page launcher + a postMessage bridge to the iframe (open/close the
// panel, and an unread-count badge while it is closed).
//
// Delivery mirrors the website-visitor tracking snippet: a static, cacheable JS
// asset served from the app origin that a customer references by <script src>.
(() => {
  // Message protocol between this loader (host page) and the iframe. MUST match
  // WEB_CHAT_EMBED_MESSAGE in apps/web/lib/constants/web-chat/embed.ts.
  const MESSAGE = {
    ready: 'artisan-web-chat:ready',
    unread: 'artisan-web-chat:unread',
    close: 'artisan-web-chat:close',
    visibility: 'artisan-web-chat:visibility',
    layout: 'artisan-web-chat:layout',
    scope: 'artisan-web-chat:scope',
    navigation: 'artisan-web-chat:navigation',
    handshake: 'artisan-web-chat:handshake',
    handshakeAck: 'artisan-web-chat:handshake-ack',
  };
  // Widget layout modes, kept in sync with WEB_CHAT_WIDGET_MODE in
  // apps/web/lib/constants/web-chat/embed.ts.
  const LAYOUT = { sidePanel: 'side-panel', floatingDialog: 'floating-dialog' };
  const IFRAME_PATH = '/embed/web-chat';
  const GLOBAL_FLAG = '__artisanWebChatLoaded';
  // A hash-only navigation (e.g. an in-page anchor like `#contact`) is reported,
  // but debounced by this long: a scrollspy-style nav that rewrites the hash on
  // every scroll tick should coalesce into one report once the URL settles,
  // rather than firing (and re-evaluating widget scope) on every intermediate
  // hash (AR2-5222 follow-up).
  const HASH_NAVIGATION_DEBOUNCE_MS = 1500;
  // First-party cookie the customer's Vector tracking pixel sets on the host page
  // to carry the identified person id (the Vector `up_id`). We forward it as the
  // bootstrap `visitorHint` so the API can link this chat to the matching
  // `website_visitor` de-anon row (AR2-3633). Overridable per-tenant via a
  // `data-vector-cookie` attribute on the loader <script> for when a customer's
  // Vector install names the cookie differently.
  //
  // NOTE: the exact default cookie name is an assumption pending confirmation
  // from the Vector integration owner — Vector's pixel is a third-party asset, so
  // the name is not discoverable in this repo. An absent/unknown cookie simply
  // yields an anonymous session (unchanged behavior), so a wrong default only
  // means de-anon does not fire, never a broken widget.
  const VECTOR_COOKIE_DEFAULT = 'vector_up_id';

  // Panel open/close motion. Opening overshoots slightly and settles, which is
  // the spring the v033 design asks for; closing pulls straight back in on a
  // shorter, plain ease so a dismissal never feels bouncy. Both are declared
  // here rather than inline so the closing duration and the delay on the
  // visibility switch cannot drift apart.
  const SPRING_EASING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  const OPEN_DURATION_MS = 340;
  const CLOSE_DURATION_MS = 200;

  // Lazy mount (L3, B10). The iframe bootstraps a conversation the moment it
  // loads, so mounting it on every pageview made a site's bootstrap rate its
  // pageview rate, which is one database transaction per pageview for the
  // overwhelming majority of visitors who never open the chat. It now waits for
  // someone to actually want the chat. What runs on every pageview instead is
  // one small, cacheable GET for the launcher's own configuration.
  const LOADER_CONFIG_PATH = '/embed/loader-config';
  const DEFAULT_BRAND_COLOR = '#682fc5';
  const PINNED_CHAT_LAYOUT = 'pinned';
  // A visitor who navigates mid-conversation must not lose the open panel and
  // the unread count until they think to click the launcher again, so the
  // loader remembers that this visitor has the chat open and mounts straight
  // away on the next page. It expires, or every visitor who ever opened the
  // chat would be back to mounting on every pageview forever.
  const RETURNING_SESSION_KEY_PREFIX = 'artisan-web-chat:last-open:';
  const RETURNING_SESSION_TTL_MS = 30 * 60 * 1000;

  // ---------------------------------------------------------------- config
  const resolveScript = () => {
    if (document.currentScript instanceof HTMLScriptElement) {
      return document.currentScript;
    }
    // Fallback for async injection where document.currentScript is null: find by src.
    const scripts = document.querySelectorAll('script[src*="/embed/loader.js"]');
    return scripts.length > 0 ? scripts[scripts.length - 1] : null;
  };

  const script = resolveScript();
  if (!script) {
    return;
  }
  if (window[GLOBAL_FLAG]) {
    return;
  }
  window[GLOBAL_FLAG] = true;

  const siteKey = script.getAttribute('data-site-key');
  if (!siteKey) {
    // Nothing to render without a tenant key; fail quiet on the customer page.
    console.warn('[artisan-web-chat] loader is missing the required data-site-key attribute.');
    return;
  }

  // The Artisan origin the iframe is served from. Derived from this script's own
  // src so the snippet stays a single line; overridable via data-embed-origin.
  const resolveArtisanOrigin = () => {
    const override = script.getAttribute('data-embed-origin');
    if (override) {
      return override.replace(/\/$/, '');
    }
    try {
      return new URL(script.src).origin;
    } catch {
      return window.location.origin;
    }
  };
  const artisanOrigin = resolveArtisanOrigin();
  // The loader runs on the CUSTOMER's page, so it is the only place that knows
  // the real host URL (the iframe only sees its own Artisan-hosted URL). Pass it
  // through so the bootstrap can capture it into the conversation's current page
  // (AR2-3592). Best-effort: an unreadable location just omits it.
  const resolveHostPage = () => {
    try {
      return window.location.href;
    } catch {
      return '';
    }
  };
  const hostPage = resolveHostPage();
  const pageParam = hostPage ? `&page=${encodeURIComponent(hostPage)}` : '';

  // Pathname + search only (hash excluded), used to detect a real SPA navigation
  // as opposed to an anchor/hash change (AR2-5222). Best-effort, matching
  // resolveHostPage above.
  const currentComparablePage = () => {
    try {
      return window.location.pathname + window.location.search;
    } catch {
      return '';
    }
  };

  // `document.referrer` and the host page's own `utm_*` query params (AR2-5041,
  // S15). Same cross-origin reasoning as `page` above: only this loader, running
  // on the customer's page, can read them. Best-effort — an unreadable
  // referrer/URL just omits the params, same as `page`.
  const resolveReferrer = () => {
    try {
      return document.referrer || '';
    } catch {
      return '';
    }
  };
  const resolveUtmParams = () => {
    try {
      return new URLSearchParams(window.location.search);
    } catch {
      return new URLSearchParams();
    }
  };
  const referrer = resolveReferrer();
  const referrerParam = referrer ? `&referrer=${encodeURIComponent(referrer)}` : '';
  const utmParams = resolveUtmParams();
  const utmSource = utmParams.get('utm_source') || '';
  const utmMedium = utmParams.get('utm_medium') || '';
  const utmCampaign = utmParams.get('utm_campaign') || '';
  const utmSourceParam = utmSource ? `&utmSource=${encodeURIComponent(utmSource)}` : '';
  const utmMediumParam = utmMedium ? `&utmMedium=${encodeURIComponent(utmMedium)}` : '';
  const utmCampaignParam = utmCampaign ? `&utmCampaign=${encodeURIComponent(utmCampaign)}` : '';

  // Read a single cookie's raw value out of a `document.cookie` string. Pure
  // (takes the cookie string, not `document`) so it is unit-testable. Returns ''
  // when the cookie is absent.
  const readCookie = (cookieString, name) => {
    if (!cookieString || !name) {
      return '';
    }
    const prefix = `${name}=`;
    for (const rawPart of cookieString.split(';')) {
      const part = rawPart.trim();
      if (part.startsWith(prefix)) {
        return part.slice(prefix.length);
      }
    }
    return '';
  };

  // The Vector cookie is first-party to the CUSTOMER's domain, so only this
  // loader (running in the host page) can read it — the iframe is cross-origin to
  // the Artisan app and cannot. Decode best-effort in case the pixel stored the
  // value percent-encoded; the API matches the raw Vector `up_id`.
  const decodeCookieValue = (raw) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  const vectorCookieName = script.getAttribute('data-vector-cookie') || VECTOR_COOKIE_DEFAULT;
  const visitorHint = decodeCookieValue(readCookie(document.cookie, vectorCookieName));
  const visitorHintParam = visitorHint ? `&visitorHint=${encodeURIComponent(visitorHint)}` : '';

  // Test live (console "try it live") sets this so the bootstrap authenticates
  // as the operator and marks the conversation `is_test=true` instead of a real
  // visitor session. Absent on every customer-facing install.
  const isTestSession = script.getAttribute('data-test-session') === 'true';
  const testSessionParam = isTestSession ? '&testSession=true' : '';

  const iframeSrc = `${artisanOrigin}${IFRAME_PATH}?siteKey=${encodeURIComponent(siteKey)}${pageParam}${visitorHintParam}${testSessionParam}${referrerParam}${utmSourceParam}${utmMediumParam}${utmCampaignParam}`;

  // `lastComparablePage` tracks pathname + search (hash excluded) as of the last
  // navigation this loader reported. Seeded from the same read that produced
  // `hostPage`, so the first SPA navigation after load compares against the page
  // the iframe actually bootstrapped with. `lastHash` tracks the fragment
  // separately (AR2-5222 follow-up) so a hash-only change, e.g. `#contact`, is
  // still detected and reported, just debounced (see `handleLocationChange`).
  const state = {
    open: false,
    mounted: false,
    ready: false,
    unread: 0,
    pinned: false,
    lastComparablePage: currentComparablePage(),
    lastHash: window.location.hash,
    hashNavigationTimer: null,
  };
  const dom = {};

  // ---------------------------------------------------------------- UI build
  const buildUi = () => {
    const style = document.createElement('style');
    style.textContent = `
      .artisan-web-chat-launcher {
        position: fixed; right: 24px; bottom: 24px; width: 59px; height: 59px;
        box-sizing: border-box; padding: 0;
        border-radius: 50%; border: none; cursor: pointer; color: #fff;
        background: #682fc5; box-shadow: 0 8px 24px rgba(20,16,40,0.28);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483000; transition: transform 0.15s ease;
      }
      .artisan-web-chat-launcher:hover { transform: scale(1.05); }
      .artisan-web-chat-launcher svg { width: 28px; height: 28px; }
      /* The glyph tracks the panel: a chat bubble to open it, a chevron down to
         put it away, so the control says what pressing it will do. */
      .artisan-web-chat-launcher .artisan-web-chat-launcher-close,
      .artisan-web-chat-launcher[data-open="true"] .artisan-web-chat-launcher-open { display: none; }
      .artisan-web-chat-launcher[data-open="true"] .artisan-web-chat-launcher-close { display: block; }
      .artisan-web-chat-badge {
        position: fixed; right: 16px; bottom: 60px; min-width: 20px; height: 20px;
        padding: 0 6px; border-radius: 10px; background: #dc2626; color: #fff;
        font: 700 12px/20px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        text-align: center; z-index: 2147483001; display: none; pointer-events: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      }
      .artisan-web-chat-badge[data-visible="true"] { display: block; }
      /* The panel stays in the layout so opening and closing it can animate.
         Closed it is visibility:hidden, which keeps it out of the tab order and
         the accessibility tree exactly as display:none did, and the visibility
         switch is delayed on the way out so the collapse is still visible while
         it plays. */
      .artisan-web-chat-frame {
        position: fixed; right: 24px; bottom: 92px; width: 386px; height: 630px;
        max-width: calc(100vw - 40px); max-height: calc(100vh - 112px);
        border: none; border-radius: 18px; overflow: hidden; display: block;
        box-shadow: 0 24px 64px rgba(20,16,40,0.28); z-index: 2147483000;
        background: transparent; color-scheme: light;
        opacity: 0; visibility: hidden; pointer-events: none;
        transform: translateY(16px) scale(0.96); transform-origin: 100% 100%;
        transition:
          transform ${CLOSE_DURATION_MS}ms cubic-bezier(0.4, 0, 1, 1),
          opacity ${CLOSE_DURATION_MS}ms ease-in,
          visibility 0s linear ${CLOSE_DURATION_MS}ms;
      }
      .artisan-web-chat-frame[data-open="true"] {
        opacity: 1; visibility: visible; pointer-events: auto;
        transform: translateY(0) scale(1);
        transition:
          transform ${OPEN_DURATION_MS}ms ${SPRING_EASING},
          opacity 160ms ease-out,
          visibility 0s;
      }
      /* Side-panel (pinned) layout: a full-height panel docked to the right edge,
         always present. No launcher, no floating box, no rounded corners. */
      .artisan-web-chat-frame--pinned {
        top: 0; right: 0; bottom: 0; width: 421px; height: 100vh;
        max-width: 90vw; max-height: 100vh; border-radius: 0;
        box-shadow: -8px 0 32px rgba(20,16,40,0.16);
      }
      @media (prefers-reduced-motion: reduce) {
        .artisan-web-chat-launcher,
        .artisan-web-chat-frame,
        .artisan-web-chat-frame[data-open="true"] { transition: none; }
      }
      .artisan-web-chat-launcher--hidden,
      .artisan-web-chat-badge--hidden,
      .artisan-web-chat-frame--hidden { display: none !important; }
    `;
    document.head.appendChild(style);

    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'artisan-web-chat-launcher';
    launcher.setAttribute('data-testid', 'webchat-launcher');
    launcher.setAttribute('aria-label', 'Open chat');
    launcher.setAttribute('data-open', 'false');
    launcher.innerHTML =
      '<svg class="artisan-web-chat-launcher-open" viewBox="0 0 24 24" fill="none" ' +
      'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H9l-4 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-8Z" ' +
      'fill="currentColor"/></svg>' +
      '<svg class="artisan-web-chat-launcher-close" viewBox="0 0 24 24" fill="none" ' +
      'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M6 9.5 12 15.5 18 9.5" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const badge = document.createElement('span');
    badge.className = 'artisan-web-chat-badge';
    badge.setAttribute('data-testid', 'webchat-unread-badge');
    badge.setAttribute('data-visible', 'false');
    badge.setAttribute('aria-hidden', 'true');

    const iframe = document.createElement('iframe');
    iframe.className = 'artisan-web-chat-frame';
    iframe.setAttribute('data-testid', 'webchat-frame');
    iframe.setAttribute('data-open', 'false');
    iframe.setAttribute('title', 'Chat');
    iframe.setAttribute('allow', 'microphone; camera; autoplay');

    document.body.appendChild(launcher);
    document.body.appendChild(badge);
    document.body.appendChild(iframe);

    dom.launcher = launcher;
    dom.badge = badge;
    dom.iframe = iframe;

    launcher.addEventListener('click', () => setOpen(!state.open));
  };

  // Loads the chat surface. Everything the widget does beyond showing a
  // launcher goes through here, and it runs at most once per pageview: a second
  // assignment would reload the iframe and throw away the conversation the
  // visitor is in the middle of.
  const mountIframe = () => {
    if (state.mounted || !dom.iframe) {
      return;
    }
    state.mounted = true;
    dom.iframe.src = iframeSrc;
  };

  // Records that this visitor has the chat open, so the next page in the same
  // visit loads it without waiting for another click. Storage can be
  // unavailable (a blocked third-party context, a private window, a full quota)
  // and none of that is worth breaking the widget over.
  const returningSessionKey = `${RETURNING_SESSION_KEY_PREFIX}${siteKey}`;
  const markSessionOpen = () => {
    try {
      window.localStorage.setItem(returningSessionKey, String(Date.now()));
    } catch {
      // Ignored: the visitor just clicks again on the next page.
    }
  };

  const hasRecentSession = () => {
    try {
      const openedAt = Number(window.localStorage.getItem(returningSessionKey));
      return openedAt > 0 && Date.now() - openedAt < RETURNING_SESSION_TTL_MS;
    } catch {
      return false;
    }
  };

  const renderBadge = () => {
    const visible = !state.open && state.unread > 0;
    dom.badge.setAttribute('data-visible', String(visible));
    dom.badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
  };

  const postToIframe = (message) => {
    // An unmounted frame is still about:blank, so a message posted at it is
    // silently lost with nothing to say it never arrived.
    if (!state.mounted) {
      return;
    }
    if (dom.iframe?.contentWindow) {
      dom.iframe.contentWindow.postMessage(message, artisanOrigin);
    }
  };

  const setOpen = (open) => {
    // The side panel is always present, so a close never collapses it.
    if (state.pinned && !open) {
      return;
    }
    if (open) {
      mountIframe();
      markSessionOpen();
    }
    state.open = open;
    dom.iframe.setAttribute('data-open', String(open));
    dom.launcher.setAttribute('data-open', String(open));
    dom.launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    if (open) {
      state.unread = 0;
    }
    renderBadge();
    postToIframe({ type: MESSAGE.visibility, open });
  };

  // Present the host-page shell for the resolved layout. `side-panel` docks the
  // iframe full-height at the right edge and hides the launcher (the panel is
  // always open); `floating-dialog` keeps the launcher + floating box.
  const applyLayout = (mode) => {
    const pinned = mode === LAYOUT.sidePanel;
    state.pinned = pinned;
    dom.iframe.setAttribute('data-layout', pinned ? LAYOUT.sidePanel : LAYOUT.floatingDialog);
    dom.iframe.classList.toggle('artisan-web-chat-frame--pinned', pinned);
    dom.launcher.classList.toggle('artisan-web-chat-launcher--hidden', pinned);
    dom.badge.classList.toggle('artisan-web-chat-badge--hidden', pinned);
    if (pinned) {
      setOpen(true);
    }
  };

  // The operator scoped the widget to other pages (D-1, AR2-4135). On a SPA the
  // iframe re-evaluates scope on every navigation (AR2-5222), so this has to be
  // reversible: `hide()` visually removes the chrome from the host page while
  // keeping the iframe and the message listener alive, and `show()` restores it
  // once a later navigation brings the page back into scope. Respects the
  // side-panel layout, which already hides the launcher/badge on its own.
  const hide = () => {
    dom.launcher?.classList.add('artisan-web-chat-launcher--hidden');
    dom.badge?.classList.add('artisan-web-chat-badge--hidden');
    dom.iframe?.classList.add('artisan-web-chat-frame--hidden');
  };

  const show = () => {
    dom.iframe?.classList.remove('artisan-web-chat-frame--hidden');
    if (!state.pinned) {
      dom.launcher?.classList.remove('artisan-web-chat-launcher--hidden');
      dom.badge?.classList.remove('artisan-web-chat-badge--hidden');
    }
    renderBadge();
  };

  const reportNavigation = () => {
    postToIframe({ type: MESSAGE.navigation, page: window.location.href });
  };

  // Clears any pending debounced hash-only report — a real path/search
  // navigation supersedes it, since `reportNavigation` below already covers
  // whatever hash the URL now has.
  const cancelPendingHashNavigation = () => {
    if (state.hashNavigationTimer === null) {
      return;
    }
    clearTimeout(state.hashNavigationTimer);
    state.hashNavigationTimer = null;
  };

  // Reports an SPA navigation to the iframe so it can re-evaluate scope and the
  // host can keep the visitor's page trail current (AR2-5222). A path/search
  // change is reported immediately; a hash-only change (e.g. `#contact`) is
  // still a real navigation for a single-page site, but is debounced so a
  // scrollspy-style nav rewriting the hash on every scroll tick doesn't spam
  // the iframe (AR2-5222 follow-up).
  const handleLocationChange = () => {
    const nextComparablePage = currentComparablePage();
    const nextHash = window.location.hash;
    const pageChanged = nextComparablePage !== state.lastComparablePage;
    const hashChanged = nextHash !== state.lastHash;
    if (!pageChanged && !hashChanged) {
      return;
    }

    state.lastComparablePage = nextComparablePage;
    state.lastHash = nextHash;

    if (pageChanged) {
      cancelPendingHashNavigation();
      reportNavigation();
      return;
    }

    cancelPendingHashNavigation();
    state.hashNavigationTimer = setTimeout(() => {
      state.hashNavigationTimer = null;
      reportNavigation();
    }, HASH_NAVIGATION_DEBOUNCE_MS);
  };

  // Wraps a History API method so a SPA router's pushState/replaceState calls
  // are visible to the loader, mirroring the engagement-script precedent
  // (apps/api/src/website-visitor/constants.ts).
  const wrapHistoryMethod = (name) => {
    const original = history[name];
    if (typeof original !== 'function') {
      return;
    }
    history[name] = (...args) => {
      const result = original.apply(history, args);
      handleLocationChange();
      return result;
    };
  };

  // ---------------------------------------------------------------- bridge
  const onMessage = (event) => {
    // Only trust messages from the Artisan iframe we injected.
    if (event.origin !== artisanOrigin || event.source !== dom.iframe?.contentWindow) {
      return;
    }
    const data = event.data;
    if (!data || typeof data.type !== 'string') {
      return;
    }
    // The origin handshake (S1). We echo the nonce straight back, targeted at
    // the Artisan origin so nothing else can read it. The value that matters is
    // not in this payload at all: the browser stamps this ack's origin, and
    // that stamp is what the iframe reports to the server as the site it is
    // embedded on. This runs before the ready branch because the iframe probes
    // as soon as it mounts.
    if (data.type === MESSAGE.handshake) {
      postToIframe({ type: MESSAGE.handshakeAck, nonce: data.nonce });
      return;
    }
    if (data.type === MESSAGE.ready) {
      state.ready = true;
      // Tell the iframe its current visibility so it can reset unread on open.
      postToIframe({ type: MESSAGE.visibility, open: state.open });
      // Heals a navigation that raced the iframe's mount (or happened before a
      // reload finished): if the page has moved on from what the iframe was
      // given at bootstrap, tell it now rather than leaving it stale until the
      // next navigation.
      if (window.location.href !== hostPage) {
        postToIframe({ type: MESSAGE.navigation, page: window.location.href });
      }
      return;
    }
    if (data.type === MESSAGE.unread) {
      state.unread = typeof data.count === 'number' ? data.count : 0;
      renderBadge();
      return;
    }
    if (data.type === MESSAGE.layout) {
      applyLayout(data.mode);
      return;
    }
    if (data.type === MESSAGE.scope) {
      if (data.inScope === false) {
        hide();
      } else {
        show();
      }
      return;
    }
    if (data.type === MESSAGE.close) {
      setOpen(false);
    }
  };

  // ------------------------------------------------------- loader config (B10)
  // The path only, never the query string: a campaign's `utm_*` parameters would
  // shatter the CDN cache key page by page and put visitor-carried values into a
  // public cache, and the page scope this answers is defined over paths anyway.
  const loaderConfigUrl = () => {
    const url = `${artisanOrigin}${LOADER_CONFIG_PATH}?siteKey=${encodeURIComponent(siteKey)}`;
    try {
      return `${url}&path=${encodeURIComponent(window.location.pathname)}`;
    } catch {
      return url;
    }
  };

  const applyLoaderConfig = (config) => {
    if (!config || typeof config !== 'object') {
      return;
    }
    if (config.enabled === false) {
      hide();
      return;
    }
    if (typeof config.brandColor === 'string' && config.brandColor) {
      dom.launcher.style.background = config.brandColor;
    }
    // A pinned org has no launcher to click, so its panel is the page, and
    // deferring it would render nothing at all.
    if (config.chatLayout === PINNED_CHAT_LAYOUT) {
      mountIframe();
    }
  };

  // Never blocks the launcher. The whole answer is an optimization plus some
  // branding, so a config that never arrives leaves a working widget in the
  // default color that still defers the iframe until the visitor asks for it.
  const loadConfig = () => {
    if (typeof fetch !== 'function') {
      return;
    }
    fetch(loaderConfigUrl(), { credentials: 'omit' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => applyLoaderConfig(body?.data))
      .catch(() => {
        // Ignored: see above. The launcher is already on the page.
      });
  };

  // ---------------------------------------------------------------- init
  const init = () => {
    buildUi();
    dom.launcher.style.background = DEFAULT_BRAND_COLOR;
    // A visitor who is mid-conversation gets the chat back on the next page
    // without waiting for the config round trip.
    if (hasRecentSession()) {
      mountIframe();
    }
    loadConfig();
    window.addEventListener('message', onMessage);
    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);
    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
