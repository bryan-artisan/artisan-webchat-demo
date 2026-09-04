// "Visiting as" picker for this demo page. Not part of the production embed
// snippet, and harmless on a real customer's copy of the page: everything it
// does is gated on the Artisan app answering, and the Artisan app only serves
// the picker where the development test routes are enabled.
//
// It needs nothing running locally. The pill opens the picker on the Artisan
// app origin, because this page's origin can never carry the Artisan session
// cookie (SameSite=Lax, host-only). The picker checks that the signed-in user
// belongs to the organization that owns this page's site key, seeds a fresh
// de-anonymized website visitor for the person you choose, and posts the new
// Vector up_id back here.
(() => {
  const siteKey = window.ARTISAN_WEBCHAT_SITE_KEY;
  const embedOrigin = (window.ARTISAN_WEBCHAT_EMBED_ORIGIN || '').replace(/\/$/, '');
  if (!siteKey || siteKey === 'REPLACE_WITH_SITE_KEY' || !embedOrigin) {
    return;
  }

  const STORAGE_KEY = 'artisan_visit_as';
  const COOKIE_NAME = 'vector_up_id';
  const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
  const POPUP_FEATURES = 'popup,width=420,height=640';

  const wantsPicker = () => {
    if (window.location.hash.indexOf('visit-as') !== -1) {
      return true;
    }
    try {
      return window.localStorage.getItem(STORAGE_KEY) !== null;
    } catch (error) {
      return false;
    }
  };

  if (!wantsPicker()) {
    return;
  }

  const remember = (fullName) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, fullName);
    } catch (error) {
      // Private browsing: the pill still works for this page view.
    }
  };

  const forget = () => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Nothing to clean up when storage is unavailable.
    }
  };

  const readRememberedName = () => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) || '';
    } catch (error) {
      return '';
    }
  };

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.style.cssText = [
    'position:fixed',
    'left:16px',
    'bottom:16px',
    'z-index:2147483000',
    'padding:10px 16px',
    'border-radius:999px',
    'border:1px solid #e6e6ef',
    'background:#ffffff',
    'color:#12121a',
    'font:500 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
    'box-shadow:0 2px 10px rgba(18,18,26,0.12)',
    'cursor:pointer',
  ].join(';');

  const rememberedName = readRememberedName();
  pill.textContent = rememberedName ? `Visiting as ${rememberedName}` : 'Visit as…';

  pill.addEventListener('click', () => {
    const url = `${embedOrigin}/visit-as?siteKey=${encodeURIComponent(siteKey)}&origin=${encodeURIComponent(window.location.origin)}`;
    window.open(url, 'artisan-visit-as', POPUP_FEATURES);
  });

  window.addEventListener('message', (event) => {
    if (event.origin !== embedOrigin) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object') {
      return;
    }

    if (data.type === 'artisan-visit-as-denied') {
      forget();
      pill.remove();
      return;
    }

    if (data.type !== 'artisan-visit-as' || typeof data.vectorUpId !== 'string') {
      return;
    }

    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(data.vectorUpId)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`;
    const fullName = typeof data.fullName === 'string' ? data.fullName : '';
    remember(fullName);
    pill.textContent = fullName ? `Visiting as ${fullName}` : 'Visiting as a lead';
  });

  document.body.appendChild(pill);
})();
