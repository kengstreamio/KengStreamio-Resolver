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
  const detail = await parseDetail(html, baseUrl, url);
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

async function parseDetail(html, baseUrl, detailUrl) {
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

  // ---- Server tabs: detail page has NONE. Must fetch watch page to get them.
  // Step 1: collect episode URLs from detail page first (need at least one for watch URL)
  const tapBases = new Map(); // tap -> { svId, url }
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

  // Step 2: fetch a watch page to get server tabs from #halim-ajax-list-server
  let serverTabs = [];
  // Pick first available watch URL (lowest tap number)
  const firstTap = tapBases.size > 0
    ? Array.from(tapBases.entries()).sort((a, b) => a[0] - b[0])[0][1].url
    : null;
  if (firstTap) {
    try {
      const watchHtml = await fetchText(firstTap);
      const watchDoc = new DOMParser().parseFromString(watchHtml, 'text/html');
      const container = watchDoc.querySelector('#halim-ajax-list-server');
      if (container) {
        const tabEls = container.querySelectorAll('span.get-eps[data-subsv-id]');
        for (const tab of tabEls) {
          const svId = parseInt(tab.getAttribute('data-subsv-id') || '0', 10);
          const svName = cleanText(tab.textContent);
          if (svId > 0 && svName) {
            serverTabs.push({ id: svId, name: svName });
          }
        }
      }
    } catch (_) { /* ignore fetch error, fallback below */ }
  }
  if (serverTabs.length === 0) {
    serverTabs = [
      { id: 1, name: 'VIP 1' },
      { id: 2, name: 'VIP 2' },
      { id: 3, name: 'HX' },
    ];
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
