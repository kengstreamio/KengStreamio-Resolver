// Provider: anime-1
// Standalone: Filter Series
// Function: filterSeries(baseUrl, sortIdx, sortVal, [filterGroup]* , page) -> JSON string
// Filter groups come as triples: [id, idx, val] dynamically from app config.
// For anime-1: 1 sort group + 1 filter group (genre).
// HalimMovies WordPress: uses genre category pages (/huyen-huyen/page/{N}, etc.)
// genreIdx maps to WordPress category slugs defined in GENRE_SLUGS.
// v6.1 contract: dynamic params.

async function filterSeries(...allArgs) {
  // Extract baseUrl, sortIdx, sortVal
  const baseUrl = allArgs[0];
  const sortIdx = allArgs[1];
  const sortVal = allArgs[2];
  const base = (baseUrl || '').replace(/\/+$/, '');

  // Remaining: filter groups triples [id, idx, val, id, idx, val...], last is page
  const rest = allArgs.slice(3);
  const page = Math.max(1, parseInt(rest.pop() || 1, 10));

  // Find genre filter group
  let genreIdx = '-1';
  for (let i = 0; i < rest.length; i += 3) {
    if (rest[i] === 'genre') {
      genreIdx = rest[i + 1];
      break;
    }
  }

  // WordPress category slugs for series genres (from homepage nav)
  const GENRE_SLUGS = [
    'huyen-huyen',    // 0: Huyền Huyễn
    'xuyen-khong',    // 1: Xuyên Không
    'trung-sinh',     // 2: Trùng Sinh
    'tien-hiep',      // 3: Tiên Hiệp
    'co-trang',       // 4: Cổ Trang
    'hai-huoc',       // 5: Hài Hước
    'kiem-hiep',      // 6: Kiếm Hiệp
    'hien-dai',       // 7: Hiện Đại
  ];

  // Determine genre slug from genreIdx
  let slug = '';
  if (genreIdx !== '-1' && genreIdx !== undefined && genreIdx !== null) {
    const idx = parseInt(genreIdx, 10);
    if (idx >= 0 && idx < GENRE_SLUGS.length) {
      slug = GENRE_SLUGS[idx];
    }
  }
  // Fallback: use phim-hoan-thanh (completed, all types) if no genre
  if (!slug) slug = 'phim-hoan-thanh';

  const url = page <= 1
    ? `${base}/${slug}`
    : `${base}/${slug}/page/${page}`;

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
      media_type: 'series',
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
