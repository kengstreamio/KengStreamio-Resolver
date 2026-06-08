// Provider: anime-1
// Standalone: Detail page
// Function: getMovieDetail(url) -> JSON string of detail object.
// Detail URL:  {baseUrl}/<slug>
// Watch URL:   {baseUrl}/xem-phim-<slug>/tap-N-svS.html
// Server per tap is encoded in the URL (-sv1, -sv2, ...).
// v6.1 contract: baseUrl dynamic.

async function getMovieDetail(url) {
  if (!url) {
    return JSON.stringify({ error: 'missing url' });
  }
  // Derive baseUrl from the full film URL.
  const u = new URL(url);
  const baseUrl = u.origin;
  const html = await fetchText(url);
  const detail = parseDetail(html, baseUrl, url);
  return JSON.stringify(detail);
}

// ===== Helpers =====
async function fetchText(url) {
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`Fetch failed: ${url} -> HTTP ${resp.status}`);
  return await resp.text();
}

function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function absUrl(url, baseUrl) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return baseUrl + url;
  return baseUrl + '/' + url;
}

function parseDetail(html, baseUrl, detailUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // ---- meta tags (og:*) ----
  const ogTitle = metaContent(doc, 'og:title');
  const ogImage = metaContent(doc, 'og:image');
  const ogDesc  = metaContent(doc, 'og:description');

  // ---- <h1> title ----
  const h1El = doc.querySelector('h1');
  const title = cleanText(h1El ? h1El.textContent : (ogTitle || ''));

  // ---- description: "Nội dung" section (h2) followed by <p> blocks ----
  let description = ogDesc || '';
  const ndH2 = findH2ByText(doc, 'Nội dung');
  if (ndH2) {
    // sibling block with article> p tags
    const article = ndH2.parentElement && ndH2.parentElement.querySelector('article');
    if (article) {
      const ps = article.querySelectorAll('p');
      const text = Array.from(ps).map(p => cleanText(p.textContent)).filter(Boolean).join('\n\n');
      if (text) description = text;
    }
  }

  // ---- poster (og:image) ----
  const poster = ogImage ? absUrl(ogImage, baseUrl) : '';

  // ---- Server tabs: anime-1 detail page has NO server tabs (only watch page
  // has span.get-eps). Servers are fixed: VIP 1 (sv1), VIP 2 (sv2), HX (sv3).
  // First try parsing from watch page DOM; fallback to hardcoded list.
  let serverTabs = [];
  const tabEls = doc.querySelectorAll('span.get-eps[data-subsv-id]');
  for (const tab of tabEls) {
    const svId = parseInt(tab.getAttribute('data-subsv-id') || '0', 10);
    const svName = cleanText(tab.textContent);
    if (svId > 0 && svName) {
      serverTabs.push({ id: svId, name: svName });
    }
  }
  if (serverTabs.length === 0) {
    // Known anime-1 servers: VIP 1, VIP 2, HX (sv1, sv2, sv3)
    serverTabs = [
      { id: 1, name: 'VIP 1' },
      { id: 2, name: 'VIP 2' },
      { id: 3, name: 'HX' },
    ];
  }

  // ---- Episodes: parse <a href> from li.halim-episode for REAL base URLs ----
  // CRITICAL: must use actual <a href> URLs (not construct from detailUrl)
  // because detail URL path ≠ watch URL path.
  // HTML only has sv1 links; we generate other servers by replacing sv ID.
  const tapBases = new Map(); // tap -> first absolute URL from <a href>
  const epLis = doc.querySelectorAll('li.halim-episode');
  for (const li of epLis) {
    const a = li.querySelector('a[href]');
    if (!a) continue;
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/tap-(\d+)-sv(\d+)\.html/);
    if (!m) continue;
    const tap = parseInt(m[1], 10);
    const svId = parseInt(m[2], 10);
    if (!tapBases.has(tap)) {
      tapBases.set(tap, { svId, url: absUrl(href, baseUrl) });
    }
  }

  // Fallback: if no <a href> found, try span[data-episode-slug] + derive URLs
  if (tapBases.size === 0) {
    const seenTaps = new Set();
    const epSpans = doc.querySelectorAll('span[data-episode-slug]');
    for (const span of epSpans) {
      const slug = span.getAttribute('data-episode-slug') || '';
      const m2 = slug.match(/tap-(\d+)/);
      if (m2) {
        const tap = parseInt(m2[1], 10);
        if (!seenTaps.has(tap)) seenTaps.add(tap);
      }
    }
    const watchPath = detailUrl.replace(/\/tap-\d+-sv\d+\.html$/, '/');
    for (const tap of seenTaps) {
      tapBases.set(tap, { svId: 1, url: watchPath + `tap-${tap}-sv1.html` });
    }
  }

  // Build episodes: cross-product tap × servers, replacing sv ID in URL
  const episodes = Array.from(tapBases.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([tap, base], idx) => ({
      episode_index: idx,
      name: `Tập ${tap}`,
      servers: serverTabs.map(sv => ({
        server: sv.name,
        // Replace the sv ID in the base URL: /tap-N-svX.html → /tap-N-svY.html
        url: base.url.replace(/-sv\d+\.html/, `-sv${sv.id}.html`),
      })),
    }));

  return {
    title: title,
    poster_url: poster,
    description: description,
    url: detailUrl,
    episodes: episodes,
  };
}

function metaContent(doc, prop) {
  const el = doc.querySelector(`meta[property="${prop}"]`);
  return el ? (el.getAttribute('content') || '') : '';
}

function findH2ByText(doc, text) {
  const h2s = doc.querySelectorAll('h2');
  for (const h of h2s) {
    if (cleanText(h.textContent).toLowerCase() === text.toLowerCase()) return h;
  }
  return null;
}
