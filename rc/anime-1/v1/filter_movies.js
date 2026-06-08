// Provider: anime-1
// Standalone: Filter Movies
// Function: filterMovies(baseUrl, sortIdx, sortVal, countryId, countryIdx, countryVal, yearId, yearIdx, yearVal, genreId, genreIdx, genreVal, page) -> JSON string
// HalimMovies WordPress: uses /phim-hoat-hinh-3d-le/page/{N} (phim lẻ page)
// Sort/country/year params accepted for API compatibility but not supported on this site.
// v6.1 contract: baseUrl dynamic.

async function filterMovies(baseUrl, 
    sortIdx,   sortVal,
    countryId, countryIdx, countryVal,
    yearId,    yearIdx,    yearVal,
    genreId,   genreIdx,   genreVal,
    page
) {
  page = Math.max(1, parseInt(page || 1, 10));
  const base = baseUrl.replace(/\/+$/, '');

  // WordPress category for phim lẻ: /phim-hoat-hinh-3d-le
  const MOVIE_SLUG = 'phim-hoat-hinh-3d-le';
  const url = page <= 1
    ? `${base}/${MOVIE_SLUG}`
    : `${base}/${MOVIE_SLUG}/page/${page}`;

  try {
    const html = await fetchText(url);
    const movies = parseGenericList(html, base, 32);
    const result = movies.map((m, i) => ({
      rank: (page - 1) * 32 + i + 1,
      title: m.title || '',
      title_original: m.title_original || '',
      poster_url: m.poster_url || '',
      thumbnail_url: m.thumbnail_url || '',
      url: m.url || '',
      media_type: 'movie',
      badge_text: m.badge_text || '',
      badge_sub: m.badge_sub || '',
      year: m.year || '',
      rating: m.rating || '',
      synopsis: m.synopsis || '',
      age_rating: m.age_rating || '',
      episode_current: m.episode_current || '',
      genres: m.genres || []
    }));
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify([]);
  }
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
  let mediaType = 'movie';
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

function parseGenericList(html, baseUrl, limit) {
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
