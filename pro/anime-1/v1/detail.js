// Provider: anime-1
// Standalone: Detail page
// Function: getMovieDetail(url) -> JSON string of detail object.
// Detail URL:  {baseUrl}/<slug>
// Watch URL:   {baseUrl}/xem-phim-<slug>/tap-N-sv1.html
// All taps use sv1 (1080p free). sv2 is VIP-only (paid).
// v6.1 contract: baseUrl dynamic.

async function getMovieDetail(url) {
  if (!url) {
    return JSON.stringify({ error: 'missing url' });
  }
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
    const article = ndH2.parentElement && ndH2.parentElement.querySelector('article');
    if (article) {
      const ps = article.querySelectorAll('p');
      const text = Array.from(ps).map(p => cleanText(p.textContent)).filter(Boolean).join('\n\n');
      if (text) description = text;
    }
  }

  // ---- poster (og:image) ----
  const poster = ogImage ? absUrl(ogImage, baseUrl) : '';

  // ---- Episodes: one per tap, always sv1 (1080p free) ----
  const seen = new Set();
  const episodes = [];
  const epLis = doc.querySelectorAll('li.halim-episode');
  for (const li of epLis) {
    const a = li.querySelector('a[href]');
    if (!a) continue;
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/tap-(\d+)-sv\d+\.html/);
    if (!m) continue;
    const tap = parseInt(m[1], 10);
    if (seen.has(tap)) continue;
    seen.add(tap);
    // Force sv1 URL (1080p free)
    const url = absUrl(href.replace(/-sv\d+\.html/, '-sv1.html'), baseUrl);
    episodes.push({
      episode_index: episodes.length,
      name: 'Tập ' + tap,
      servers: [{ server: 'Default', url: url }],
    });
  }
  episodes.sort((a, b) => {
    const na = parseInt(a.name.replace(/\D/g, ''), 10);
    const nb = parseInt(b.name.replace(/\D/g, ''), 10);
    return na - nb;
  });
  // Re-index after sort
  episodes.forEach((ep, i) => { ep.episode_index = i; });

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
