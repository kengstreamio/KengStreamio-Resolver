// Provider: anime-1
// Rail group: Status
//   Rail 1: Phim Đang Chiếu  (phim-dang-chieu)
//   Rail 2: Phim Hoàn Thành  (phim-hoan-thanh)
// CTAs:
//   getAllOngoing(baseUrl, page)   -> 20 per page
//   getAllCompleted(baseUrl, page) -> 20 per page
// v6.1 contract: baseUrl dynamic, CTA functions embedded in same file.

async function railGroupStatus(baseUrl) {
  const limit = 20;
  const [ongoingHtml, completedHtml] = await Promise.all([
    fetchText(`${baseUrl}/phim-dang-chieu`),
    fetchText(`${baseUrl}/phim-hoan-thanh`),
  ]);

  const ongoingMovies = parseGenericList(ongoingHtml, baseUrl, limit);
  const completedMovies = parseGenericList(completedHtml, baseUrl, limit);

  const rails = [
    {
      id: 'phim_dang_chieu',
      title: 'Phim Đang Chiếu',
      subtitle: 'Hoạt hình đang phát sóng',
      card_height_percent: 0.18,
      card_size_ratio: 0.667,
      is_hero_source: false,
      show_rank: false,
      show_cta: { js_method: 'getAllOngoing' },
      movies: ongoingMovies,
    },
    {
      id: 'phim_hoan_thanh',
      title: 'Phim Hoàn Thành',
      subtitle: 'Hoạt hình đã hoàn tất',
      card_height_percent: 0.18,
      card_size_ratio: 0.667,
      is_hero_source: false,
      show_rank: false,
      show_cta: { js_method: 'getAllCompleted' },
      movies: completedMovies,
    },
  ];

  return JSON.stringify(rails);
}

// ===== CTA functions =====
async function getAllOngoing(baseUrl, page) {
  const url = pageUrl(baseUrl, '/phim-dang-chieu', page);
  const html = await fetchText(url);
  return JSON.stringify(parseGenericList(html, baseUrl, 20));
}

async function getAllCompleted(baseUrl, page) {
  const url = pageUrl(baseUrl, '/phim-hoan-thanh', page);
  const html = await fetchText(url);
  return JSON.stringify(parseGenericList(html, baseUrl, 20));
}

// ===== Helpers =====
async function fetchText(url) {
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`Fetch failed: ${url} -> HTTP ${resp.status}`);
  return await resp.text();
}

function pageUrl(baseUrl, path, page) {
  const p = Math.max(1, parseInt(page || 1, 10));
  if (p <= 1) return baseUrl + path;
  return `${baseUrl}${path}/page/${p}`;
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

// Generic parser for standard halim-thumb articles (huyen-huyen, ongoing, completed, phim-le, etc).
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
