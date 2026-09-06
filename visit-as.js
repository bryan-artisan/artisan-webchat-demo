// "Visiting as" picker for this demo page. Not part of the production embed
// snippet, and harmless on a real customer's copy of the page: everything it
// does is gated on the Artisan app answering, and the Artisan app only serves
// the picker where the development test routes are enabled.
//
// It needs nothing running locally. This page's origin can never carry the
// Artisan session cookie (SameSite=Lax, host-only), so a one-time popup on the
// Artisan app origin checks that the signed-in user belongs to the organization
// that owns this page's site key and hands back a short-lived token. From then
// on the picker is a panel on this page: searching and choosing someone call the
// Artisan API directly with that token, and no window ever opens again until it
// expires.
(() => {
  const siteKey = window.ARTISAN_WEBCHAT_SITE_KEY;
  const embedOrigin = (window.ARTISAN_WEBCHAT_EMBED_ORIGIN || '').replace(/\/$/, '');
  if (!siteKey || siteKey === 'REPLACE_WITH_SITE_KEY' || !embedOrigin) {
    return;
  }

  const STORAGE_KEY = 'artisan_visit_as';
  const TOKEN_STORAGE_KEY = 'artisan_visit_as_token';
  const COOKIE_NAME = 'vector_up_id';
  const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
  const POPUP_FEATURES = 'popup,width=420,height=520';
  const MIN_QUERY_LENGTH = 2;
  const SEARCH_DEBOUNCE_MS = 250;
  const TOKEN_EXPIRY_MARGIN_MS = 30 * 1000;
  // The embed loader reads the Vector cookie once, while it is building the
  // iframe URL, so a cookie written after the widget has loaded reaches nothing.
  // Reloading is what puts the new identity in front of the widget.
  const RELOAD_DELAY_MS = 400;

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

  const readStorage = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  };

  const writeStorage = (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // Private browsing: everything still works for this page view.
    }
  };

  const dropStorage = (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      // Nothing to clean up when storage is unavailable.
    }
  };

  const readToken = () => {
    const raw = readStorage(TOKEN_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      const expiresAt = Date.parse(parsed.expiresAt);
      const isUsable =
        typeof parsed.token === 'string' &&
        typeof parsed.apiBaseUrl === 'string' &&
        expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now();
      return isUsable ? parsed : null;
    } catch (error) {
      return null;
    }
  };

  let session = readToken();
  let searchTimer = null;
  let searchGeneration = 0;

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

  const panel = document.createElement('div');
  panel.hidden = true;
  panel.style.cssText = [
    'position:fixed',
    'left:16px',
    'bottom:64px',
    'z-index:2147483000',
    'width:320px',
    'max-height:420px',
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'padding:12px',
    'border-radius:12px',
    'border:1px solid #e6e6ef',
    'background:#ffffff',
    'color:#12121a',
    'font:400 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
    'box-shadow:0 8px 28px rgba(18,18,26,0.18)',
  ].join(';');

  const panelTitle = document.createElement('div');
  panelTitle.style.cssText = 'font-weight:600';
  panelTitle.textContent = 'Visit as';

  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Name, email or company';
  input.style.cssText = [
    'width:100%',
    'box-sizing:border-box',
    'padding:8px 10px',
    'border-radius:8px',
    'border:1px solid #e6e6ef',
    'font:inherit',
    'color:inherit',
  ].join(';');

  const hint = document.createElement('div');
  hint.style.cssText = 'color:#6b6b7b';
  hint.textContent = `Type at least ${MIN_QUERY_LENGTH} characters to search.`;

  const results = document.createElement('div');
  results.style.cssText = 'overflow-y:auto;display:flex;flex-direction:column;gap:2px';

  panel.appendChild(panelTitle);
  panel.appendChild(input);
  panel.appendChild(hint);
  panel.appendChild(results);

  const setHint = (text) => {
    hint.textContent = text;
  };

  const clearResults = () => {
    while (results.firstChild) {
      results.removeChild(results.firstChild);
    }
  };

  const closePanel = () => {
    panel.hidden = true;
  };

  const dropSession = () => {
    session = null;
    dropStorage(TOKEN_STORAGE_KEY);
  };

  const callApi = async (path, options) => {
    if (!session) {
      throw new Error('no session');
    }
    const response = await fetch(`${session.apiBaseUrl}${path}`, {
      method: options.method,
      headers: Object.assign({ Authorization: `Bearer ${session.token}` }, options.headers || {}),
      body: options.body,
    });
    if (response.status === 401 || response.status === 403) {
      dropSession();
      throw new Error('expired');
    }
    if (!response.ok) {
      throw new Error(`request failed: ${response.status}`);
    }
    const payload = await response.json();
    return payload.data;
  };

  const seedPerson = async (person) => {
    setHint(`Setting up ${person.fullName}…`);
    try {
      const seeded = await callApi('/demo/visit-as/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId: person.leadId }),
      });
      document.cookie = `${COOKIE_NAME}=${encodeURIComponent(seeded.vectorUpId)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`;
      writeStorage(STORAGE_KEY, seeded.fullName || '');
      pill.textContent = `Visiting as ${seeded.fullName || 'a lead'}`;
      setHint('Reloading so the widget picks up the new identity.');
      window.setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
    } catch (error) {
      if (error.message === 'expired') {
        closePanel();
        openHandshake();
        return;
      }
      setHint('We could not set that identity. Try another person.');
    }
  };

  const renderPeople = (people) => {
    clearResults();
    if (people.length === 0) {
      setHint('No one matches that search.');
      return;
    }
    setHint(`${people.length} match${people.length === 1 ? '' : 'es'}.`);
    people.forEach((person) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.style.cssText = [
        'display:flex',
        'flex-direction:column',
        'align-items:flex-start',
        'gap:2px',
        'width:100%',
        'padding:6px 8px',
        'border:0',
        'border-radius:8px',
        'background:transparent',
        'color:inherit',
        'font:inherit',
        'text-align:left',
        'cursor:pointer',
      ].join(';');
      row.addEventListener('mouseenter', () => {
        row.style.background = '#f4f4f8';
      });
      row.addEventListener('mouseleave', () => {
        row.style.background = 'transparent';
      });

      const name = document.createElement('span');
      name.style.cssText = 'font-weight:500';
      name.textContent = person.fullName;
      row.appendChild(name);

      const details = [person.jobTitle, person.companyName].filter(Boolean).join(' · ');
      if (details) {
        const detailLine = document.createElement('span');
        detailLine.style.cssText = 'color:#6b6b7b';
        detailLine.textContent = details;
        row.appendChild(detailLine);
      }

      row.addEventListener('click', () => seedPerson(person));
      results.appendChild(row);
    });
  };

  const runSearch = async (query) => {
    searchGeneration += 1;
    const generation = searchGeneration;
    setHint('Searching…');
    try {
      const data = await callApi(`/demo/visit-as/people?q=${encodeURIComponent(query)}`, {
        method: 'GET',
      });
      if (generation !== searchGeneration) {
        return;
      }
      renderPeople(data.people || []);
    } catch (error) {
      if (generation !== searchGeneration) {
        return;
      }
      if (error.message === 'expired') {
        closePanel();
        openHandshake();
        return;
      }
      clearResults();
      setHint('We could not search people for this organization.');
    }
  };

  input.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    const query = input.value.trim();
    if (query.length < MIN_QUERY_LENGTH) {
      searchGeneration += 1;
      clearResults();
      setHint(`Type at least ${MIN_QUERY_LENGTH} characters to search.`);
      return;
    }
    searchTimer = window.setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
  });

  const openPanel = () => {
    panel.hidden = false;
    clearResults();
    input.value = '';
    setHint(
      session && session.orgName
        ? `Pick someone from ${session.orgName}.`
        : `Type at least ${MIN_QUERY_LENGTH} characters to search.`
    );
    input.focus();
  };

  function openHandshake() {
    const url = `${embedOrigin}/visit-as?siteKey=${encodeURIComponent(siteKey)}&origin=${encodeURIComponent(window.location.origin)}`;
    window.open(url, 'artisan-visit-as', POPUP_FEATURES);
  }

  pill.addEventListener('click', () => {
    if (!panel.hidden) {
      closePanel();
      return;
    }
    session = readToken();
    if (session) {
      openPanel();
      return;
    }
    openHandshake();
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
      dropSession();
      dropStorage(STORAGE_KEY);
      panel.remove();
      pill.remove();
      return;
    }

    if (data.type !== 'artisan-visit-as-token' || typeof data.token !== 'string') {
      return;
    }

    session = {
      token: data.token,
      expiresAt: data.expiresAt,
      apiBaseUrl: String(data.apiBaseUrl || '').replace(/\/$/, ''),
      orgName: typeof data.orgName === 'string' ? data.orgName : '',
    };
    writeStorage(TOKEN_STORAGE_KEY, JSON.stringify(session));
    openPanel();
  });

  const rememberedName = readStorage(STORAGE_KEY) || '';
  pill.textContent = rememberedName ? `Visiting as ${rememberedName}` : 'Visit as…';

  document.body.appendChild(panel);
  document.body.appendChild(pill);
})();
