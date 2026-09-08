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

  // Inline side panel. A customer who wants the pinned panel to sit BESIDE the
  // page rather than over it puts one empty div in their template:
  //
  //   <div id="artisan-chat"></div>
  //
  // and the panel mounts inside it, so their own layout reflows around the
  // reserved column instead of losing its right edge under an overlay. With no
  // such div the panel keeps the fixed-overlay presentation, so the existing
  // one-line install is unchanged.
  //
  // Neither the snippet nor the div names a layout. Which one is in force is
  // resolved at runtime, from the loader config and the iframe's layout
  // message, so switching between the floating widget and the side panel in the
  // console never asks the customer to touch their site again.
  const SIDE_PANEL_CONTAINER_ID = 'artisan-chat';
  // Below this the page has no column to give up, so an inline panel presents
  // as the overlay. That switch is made in CSS on the container, never by
  // moving the iframe: re-parenting a mounted iframe reloads it, and the
  // visitor loses the conversation they are in the middle of.
  const SIDE_PANEL_INLINE_MIN_WIDTH_PX = 900;
  // The layout the last answer resolved to. Read only to place a returning
  // visitor's early mount, which happens before the config round trip can say
  // anything. A stale value costs one pageview in the wrong presentation and
  // then heals, so it is never worth breaking the widget over.
  const LAYOUT_CACHE_KEY_PREFIX = 'artisan-web-chat:layout:';

  // Welcome teaser. A visitor who never clicks the launcher never saw the
  // opener at all, so the widget mounts itself once on a new visitor's first
  // visible pageview and shows the message it gets back beside the launcher.
  // The delay is the design's: long enough that the card is not part of the
  // page load, short enough to still read as an answer to arriving.
  const TEASER_DELAY_MS = 1600;
  // Once this visitor has been greeted the loader is back to its lazy mount, so
  // the extra bootstrap is once per visitor rather than once per pageview.
  const TEASER_GREETED_KEY_PREFIX = 'artisan-web-chat:greeted:';
  // Measured off the updated design: the card lands from a slight shrink on the
  // same spring the panel opens with, anchored at the launcher.
  const TEASER_ENTRANCE_SCALE = 0.9392;
  const TEASER_ENTRANCE_MS = 267;
  // The design clears the card first and the badge a beat later, so the count
  // is still readable while the card is on its way out.
  const BADGE_TRAIL_MS = 600;

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
    placement: null,
    lastComparablePage: currentComparablePage(),
    lastHash: window.location.hash,
    hashNavigationTimer: null,
    teaserTimer: null,
    badgeTrailTimer: null,
  };
  const dom = {};

  // ---------------------------------------------------------------- UI build
  // The welcome card that sits beside the launcher. Built empty and hidden; the
  // text only ever arrives from the iframe's unread message, and it is written
  // through textContent, so nothing the panel sends can put markup on the
  // customer's page.
  const buildTeaser = () => {
    const teaser = document.createElement('div');
    teaser.className = 'artisan-web-chat-teaser';
    teaser.setAttribute('data-testid', 'webchat-teaser');
    teaser.setAttribute('data-visible', 'false');

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'artisan-web-chat-teaser-card';
    card.setAttribute('data-testid', 'webchat-teaser-card');

    const avatar = document.createElement('img');
    avatar.className = 'artisan-web-chat-teaser-avatar';
    avatar.setAttribute('alt', '');
    avatar.style.display = 'none';

    const text = document.createElement('span');
    text.className = 'artisan-web-chat-teaser-text';
    const name = document.createElement('span');
    name.className = 'artisan-web-chat-teaser-name';
    const body = document.createElement('span');
    body.className = 'artisan-web-chat-teaser-body';
    text.appendChild(name);
    text.appendChild(body);

    card.appendChild(avatar);
    card.appendChild(text);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'artisan-web-chat-teaser-dismiss';
    dismiss.setAttribute('data-testid', 'webchat-teaser-dismiss');
    dismiss.setAttribute('aria-label', 'Dismiss message');
    dismiss.innerHTML =
      '<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round"/></svg>';

    teaser.appendChild(card);
    teaser.appendChild(dismiss);

    dom.teaser = teaser;
    dom.teaserCard = card;
    dom.teaserAvatar = avatar;
    dom.teaserName = name;
    dom.teaserBody = body;

    card.addEventListener('click', () => setOpen(true));
    dismiss.addEventListener('click', dismissTeaser);
    return teaser;
  };

  const buildUi = () => {
    const style = document.createElement('style');
    style.textContent = `
      /* The launcher and the welcome teaser sit on one row, so the card grows
         to the left of the bubble and the pair keeps the 24px margin the
         launcher always had. */
      .artisan-web-chat-dock {
        position: fixed; right: 24px; bottom: 24px;
        display: flex; align-items: center; gap: 12px;
        z-index: 2147483000;
      }
      .artisan-web-chat-launcher {
        position: relative; flex: 0 0 auto; width: 59px; height: 59px;
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
      /* The count rides the launcher itself, overlapping its top-right edge, so
         it stays put whether or not the teaser card is beside it. */
      .artisan-web-chat-badge {
        position: absolute; top: -2px; right: -2px; min-width: 18px; height: 18px;
        padding: 0 5px; box-sizing: border-box; border-radius: 9px;
        background: rgb(204,48,24); color: #fff;
        font: 700 11px/18px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-variant-numeric: tabular-nums;
        text-align: center; display: none; pointer-events: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      }
      .artisan-web-chat-badge[data-visible="true"] { display: block; }
      /* Welcome teaser (v034). The card carries the opener beside the collapsed
         launcher, so a visitor who never clicks still reads what Ava said. */
      .artisan-web-chat-teaser {
        position: relative; display: none;
      }
      .artisan-web-chat-teaser[data-visible="true"] { display: block; }
      .artisan-web-chat-teaser-card {
        display: flex; align-items: center; gap: 10px; width: 296px;
        box-sizing: border-box; padding: 11px 14px; text-align: left;
        border-radius: 16px; border: 1px solid rgba(20,16,40,0.08);
        background: #fff; color: #1a1523; cursor: pointer;
        box-shadow: 0 12px 32px rgba(20,16,40,0.16), 0 2px 6px rgba(20,16,40,0.08);
        transform: scale(${TEASER_ENTRANCE_SCALE}); transform-origin: right center;
        transition: transform ${TEASER_ENTRANCE_MS}ms ${SPRING_EASING};
      }
      .artisan-web-chat-teaser[data-visible="true"] .artisan-web-chat-teaser-card {
        transform: scale(1);
      }
      .artisan-web-chat-teaser-avatar {
        width: 32px; height: 32px; flex: 0 0 auto; border-radius: 50%;
        object-fit: cover; background: rgba(20,16,40,0.06);
      }
      .artisan-web-chat-teaser-text { min-width: 0; }
      .artisan-web-chat-teaser-name {
        display: block;
        font: 600 12px/16px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .artisan-web-chat-teaser-body {
        display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font: 400 12px/16px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: rgba(26,21,35,0.72);
      }
      /* Dismiss stays out of the way until the visitor reaches for the card,
         which is why the card itself is the big target and this is not. */
      .artisan-web-chat-teaser-dismiss {
        position: absolute; top: -7px; left: -7px; width: 22px; height: 22px;
        padding: 0; border-radius: 50%; border: 1px solid rgba(20,16,40,0.08);
        background: #fff; color: #1a1523; cursor: pointer; line-height: 1;
        opacity: 0; transition: opacity 140ms ease;
        box-shadow: 0 2px 6px rgba(20,16,40,0.16);
      }
      .artisan-web-chat-teaser:hover .artisan-web-chat-teaser-dismiss,
      .artisan-web-chat-teaser:focus-within .artisan-web-chat-teaser-dismiss { opacity: 1; }
      .artisan-web-chat-teaser-dismiss svg { width: 10px; height: 10px; display: block; margin: auto; }
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
      /* Inline side panel: the customer's own placeholder div hosts the panel,
         so it occupies real space in their layout and the page reflows around
         it. The defaults suit a placeholder dropped into a flex or grid row;
         everything lives on this one class, so customer CSS can override the
         width or the docking outright. */
      .artisan-web-chat-container {
        position: sticky; top: 0; flex: 0 0 auto;
        width: 421px; height: 100vh; box-sizing: border-box;
      }
      .artisan-web-chat-frame--inline {
        position: static; width: 100%; height: 100%;
        max-width: none; max-height: none;
        border-radius: 0; box-shadow: none;
      }
      /* No room to split the page, so the inline panel presents as the overlay.
         The container moves, the iframe stays exactly where it is. */
      @media (max-width: ${SIDE_PANEL_INLINE_MIN_WIDTH_PX - 1}px) {
        .artisan-web-chat-container {
          position: fixed; top: 0; right: 0; bottom: 0;
          width: 421px; max-width: 90vw; height: 100vh;
          z-index: 2147483000;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .artisan-web-chat-launcher,
        .artisan-web-chat-teaser-card,
        .artisan-web-chat-frame,
        .artisan-web-chat-frame[data-open="true"] { transition: none; }
        .artisan-web-chat-teaser-card { transform: scale(1); }
      }
      .artisan-web-chat-dock--hidden,
      .artisan-web-chat-launcher--hidden,
      .artisan-web-chat-badge--hidden,
      .artisan-web-chat-container--hidden,
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
    launcher.appendChild(badge);

    const dock = document.createElement('div');
    dock.className = 'artisan-web-chat-dock';
    dock.setAttribute('data-testid', 'webchat-dock');
    dock.appendChild(buildTeaser());
    dock.appendChild(launcher);

    const iframe = document.createElement('iframe');
    iframe.className = 'artisan-web-chat-frame';
    iframe.setAttribute('data-testid', 'webchat-frame');
    iframe.setAttribute('data-open', 'false');
    iframe.setAttribute('title', 'Chat');
    iframe.setAttribute('allow', 'microphone; camera; autoplay');

    document.body.appendChild(dock);
    document.body.appendChild(iframe);

    dom.dock = dock;
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

  // Decides, once per pageview, where the pinned panel lives: inside the
  // customer's placeholder div when they installed one, otherwise docked over
  // the page as it has always been. Called from every signal that can tell us
  // the org is pinned, and a no-op after the first.
  //
  // The `state.mounted` guard is the load-bearing one. An iframe that has been
  // given a src reloads when it moves to another parent, which would throw away
  // a live conversation, so a panel that already mounted stays where it is and
  // takes the overlay. Before the src is assigned the frame is still
  // about:blank and moving it costs nothing.
  const ensureSidePanelPlacement = () => {
    if (state.placement) {
      return;
    }
    const container = document.getElementById(SIDE_PANEL_CONTAINER_ID);
    if (!container || state.mounted || !dom.iframe) {
      state.placement = 'overlay';
      return;
    }
    state.placement = 'inline';
    dom.container = container;
    container.classList.add('artisan-web-chat-container');
    container.appendChild(dom.iframe);
    // The config can say pinned before the iframe reports its own layout, so the
    // panel takes the inline presentation as soon as it has a home. Otherwise it
    // would render at the floating panel's size inside the reserved column until
    // the message lands.
    dom.iframe.classList.add('artisan-web-chat-frame--inline');
    dom.iframe.classList.remove('artisan-web-chat-frame--pinned');
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

  // Remembers the resolved layout so the next pageview can place a returning
  // visitor's early mount before the config answers. Same storage caveats as
  // the session key above, and the same answer to them.
  const layoutCacheKey = `${LAYOUT_CACHE_KEY_PREFIX}${siteKey}`;
  const cacheLayout = (mode) => {
    try {
      window.localStorage.setItem(layoutCacheKey, mode);
    } catch {
      // Ignored: the next pageview just falls back to the overlay.
    }
  };

  const cachedLayoutIsPinned = () => {
    try {
      return window.localStorage.getItem(layoutCacheKey) === LAYOUT.sidePanel;
    } catch {
      return false;
    }
  };

  // This visitor has already been shown the opener, so the loader is back to
  // mounting only when someone asks for the chat. Without it every pageview of
  // the same visit would pay for another bootstrap.
  const greetedKey = `${TEASER_GREETED_KEY_PREFIX}${siteKey}`;
  const hasGreeted = () => {
    try {
      return window.localStorage.getItem(greetedKey) === '1';
    } catch {
      return false;
    }
  };

  const markGreeted = () => {
    try {
      window.localStorage.setItem(greetedKey, '1');
    } catch {
      // Ignored: the worst case is one more early mount on the next page.
    }
  };

  const renderBadge = () => {
    // While the count is trailing a dismissed card it stays up even though the
    // panel is open, which is the beat the design holds it for.
    const trailing = state.badgeTrailTimer !== null;
    const visible = state.unread > 0 && (trailing || !state.open);
    dom.badge.setAttribute('data-visible', String(visible));
    dom.badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    dom.badge.setAttribute('aria-label', `${state.unread} unread`);
  };

  const cancelTeaserTimer = () => {
    if (state.teaserTimer === null) {
      return;
    }
    clearTimeout(state.teaserTimer);
    state.teaserTimer = null;
  };

  const teaserIsVisible = () => dom.teaser?.getAttribute('data-visible') === 'true';

  const hideTeaser = () => {
    dom.teaser?.setAttribute('data-visible', 'false');
  };

  // The card goes first and the count follows a beat later, so the visitor can
  // still read what they are leaving behind while the card animates out.
  const clearBadgeAfterTeaser = () => {
    if (state.badgeTrailTimer !== null) {
      return;
    }
    state.badgeTrailTimer = setTimeout(() => {
      state.badgeTrailTimer = null;
      state.unread = 0;
      renderBadge();
    }, BADGE_TRAIL_MS);
  };

  const dismissTeaser = () => {
    cancelTeaserTimer();
    markGreeted();
    if (!teaserIsVisible()) {
      return;
    }
    hideTeaser();
    clearBadgeAfterTeaser();
  };

  // Paints the card from the turn the iframe sent beside the count. An entry
  // with no text is nothing to show, and a panel that is already open has
  // nothing to tease.
  const renderTeaser = (latest) => {
    const showable = Boolean(dom.teaser) && !state.open && Boolean(latest?.text);
    if (!showable) {
      return;
    }
    const senderName = typeof latest.senderName === 'string' ? latest.senderName : '';
    dom.teaserName.textContent = senderName;
    dom.teaserName.style.display = senderName ? 'block' : 'none';
    dom.teaserBody.textContent = latest.text;
    const avatarUrl = typeof latest.avatarUrl === 'string' ? latest.avatarUrl : '';
    dom.teaserAvatar.style.display = avatarUrl ? 'block' : 'none';
    if (avatarUrl) {
      dom.teaserAvatar.src = avatarUrl;
    }
    dom.teaserCard.setAttribute(
      'aria-label',
      senderName ? `Message from ${senderName}: ${latest.text}` : `Message: ${latest.text}`
    );
    dom.teaser.setAttribute('data-visible', 'true');
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

  // Opening reads everything, so the count goes. When the welcome card was up
  // the count trails it instead of vanishing with it.
  const clearUnreadOnOpen = () => {
    if (!teaserIsVisible()) {
      state.unread = 0;
      return;
    }
    hideTeaser();
    clearBadgeAfterTeaser();
  };

  const setOpen = (open) => {
    // The side panel is always present, so a close never collapses it.
    if (state.pinned && !open) {
      return;
    }
    if (open) {
      mountIframe();
      markSessionOpen();
      markGreeted();
      cancelTeaserTimer();
    }
    state.open = open;
    dom.iframe.setAttribute('data-open', String(open));
    dom.launcher.setAttribute('data-open', String(open));
    dom.launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
    if (open) {
      clearUnreadOnOpen();
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
    cacheLayout(pinned ? LAYOUT.sidePanel : LAYOUT.floatingDialog);
    if (pinned) {
      ensureSidePanelPlacement();
    }
    const inline = pinned && state.placement === 'inline';
    dom.iframe.setAttribute('data-layout', pinned ? LAYOUT.sidePanel : LAYOUT.floatingDialog);
    dom.iframe.classList.toggle('artisan-web-chat-frame--pinned', pinned && !inline);
    dom.iframe.classList.toggle('artisan-web-chat-frame--inline', inline);
    dom.dock.classList.toggle('artisan-web-chat-dock--hidden', pinned);
    dom.launcher.classList.toggle('artisan-web-chat-launcher--hidden', pinned);
    dom.badge.classList.toggle('artisan-web-chat-badge--hidden', pinned);
    if (pinned) {
      cancelTeaserTimer();
      hideTeaser();
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
    // A page the widget does not serve must not sprout a welcome card a second
    // later either, so the pending mount goes with the chrome.
    cancelTeaserTimer();
    hideTeaser();
    dom.dock?.classList.add('artisan-web-chat-dock--hidden');
    dom.launcher?.classList.add('artisan-web-chat-launcher--hidden');
    dom.badge?.classList.add('artisan-web-chat-badge--hidden');
    dom.iframe?.classList.add('artisan-web-chat-frame--hidden');
    // An inline panel also has to give the column back, or a page the widget
    // does not serve keeps a 421px hole where the chat would have been.
    dom.container?.classList.add('artisan-web-chat-container--hidden');
  };

  const show = () => {
    dom.container?.classList.remove('artisan-web-chat-container--hidden');
    dom.iframe?.classList.remove('artisan-web-chat-frame--hidden');
    if (!state.pinned) {
      dom.dock?.classList.remove('artisan-web-chat-dock--hidden');
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
      if (state.unread === 0) {
        hideTeaser();
      } else {
        renderTeaser(data.latest);
      }
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

  // One bootstrap on a new visitor's first visible pageview, which is what pays
  // for the welcome card: the iframe loads, the opener arrives on the unread
  // message, and the card shows it. A greeted visitor, a visitor already in a
  // session, and a background tab all keep today's lazy mount.
  const scheduleTeaserMount = () => {
    const wantsTeaser = !state.mounted && !hasGreeted() && !hasRecentSession();
    if (!wantsTeaser || document.visibilityState !== 'visible') {
      return;
    }
    state.teaserTimer = setTimeout(() => {
      state.teaserTimer = null;
      mountIframe();
    }, TEASER_DELAY_MS);
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
    if (typeof config.chatLayout !== 'string' || !config.chatLayout) {
      scheduleTeaserMount();
      return;
    }
    const pinned = config.chatLayout === PINNED_CHAT_LAYOUT;
    cacheLayout(pinned ? LAYOUT.sidePanel : LAYOUT.floatingDialog);
    if (!pinned) {
      scheduleTeaserMount();
      return;
    }
    // A pinned org has no launcher to click, so its panel is the page, and
    // deferring it would render nothing at all. Placing it before the mount
    // also reserves the inline column now rather than when the iframe finishes
    // booting, so the page settles once instead of shifting under the visitor.
    ensureSidePanelPlacement();
    mountIframe();
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
    // without waiting for the config round trip. That mount has to know where
    // it is going first: mounting into the body and learning the org is pinned
    // a moment later would strand every returning visitor in the overlay.
    if (cachedLayoutIsPinned()) {
      ensureSidePanelPlacement();
    }
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
