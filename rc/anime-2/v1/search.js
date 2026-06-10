// Provider: anime-2
// Standalone: Search
// Function: searchAnime2(baseUrl, keyword, page) -> JSON string of movies array.
// URL pattern: {baseUrl}/search/<keyword>/page/<N>  (page 1 = /search/<keyword>)
// v6.1 contract: baseUrl dynamic.

async function searchMovies(baseUrl, keyword, page) {
  const kw = encodeURIComponent((keyword || '').trim());
  if (!kw) return JSON.stringify([]);
  const p = Math.max(1, parseInt(page || 1, 10));
  const url = p <= 1
    ? `${baseUrl}/search/${kw}`
    : `${baseUrl}/search/${kw}/page/${p}`;

  const html = await fetchText(url);
  const movies = parseSearchResults(html, baseUrl, 20);
  return JSON.stringify(movies);
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

function extractMovieFromCard(article, baseUrl, rank) {
  const a = article.querySelector('a.halim-thumb');
  if (!a) return null;
  const href = a.getAttribute('href') || '';
  const title = cleanText(a.getAttribute('title') || '');
  if (!href || !title) return null;
  const img = article.querySelector('figure img');
  let poster = '';
  if (img) {
    poster = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
  }
  const episodeEl = article.querySelector('span.episode');
  const episode = episodeEl ? cleanText(episodeEl.textContent) : '';
  const statusEl = article.querySelector('span.status');
  const status = statusEl ? cleanText(statusEl.textContent) : '';
  const origEl = article.querySelector('span.original_title');
  const titleOriginal = origEl ? cleanText(origEl.textContent) : '';
  let mediaType = 'series';
  if (episode.toLowerCase().includes('full')) mediaType = 'movie';
  return {
    rank: rank || 0,
    title: title,
    title_original: titleOriginal,
    poster_url: poster ? absUrl(poster, baseUrl) : '',
    thumbnail_url: poster ? absUrl(poster, baseUrl) : '',
    url: absUrl(href, baseUrl),
    media_type: mediaType,
    badge_text: episode,
    badge_sub: status,
    year: '',
    rating: '',
    synopsis: '',
    age_rating: '',
    episode_current: episode,
    genres: []
  };
}

function parseSearchResults(html, baseUrl, limit) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const articles = doc.querySelectorAll('article.thumb.grid-item');
  const movies = [];
  for (const art of articles) {
    if (movies.length >= limit) break;
    const m = extractMovieFromCard(art, baseUrl, 0);
    if (m) movies.push(m);
  }
  return movies;
}