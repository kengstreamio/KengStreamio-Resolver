// Provider: anime-1
// Rail group: Rankings
//   Rail 1: Top 10 HH3D (bang-xep-hang-hoat-hinh-trung-quoc)
//   Rail 2: Đánh Giá Cao (hh3d-danh-gia-cao)
// CTAs:
//   getAllTop10(baseUrl)         -> 10 movies
//   getAllRating(baseUrl, page)  -> 20 movies per page
// v6.1 contract: baseUrl dynamic, CTA functions embedded in same file.

async function railGroupRankings(baseUrl) {
  const top10Url = `${baseUrl}/bang-xep-hang-hoat-hinh-trung-quoc`;
  const ratingUrl = `${baseUrl}/hh3d-danh-gia-cao`;
  const limit = 20;

  // Fetch both pages in parallel.
  const [top10Html, ratingHtml] = await Promise.all([
    fetchText(top10Url),
    fetchText(ratingUrl),
  ]);

  const top10Movies = parseTop10List(top10Html, baseUrl, 10);
  const ratingMovies = parseRatingList(ratingHtml, baseUrl, limit);

  const rails = [
    {
      id: 'top10_hh3d',
      title: 'Top 10 Hoạt Hình 3D',
      subtitle: 'Bảng xếp hạng HH3D',
      card_height_percent: 0.18,
      card_size_ratio: 0.667,
      is_hero_source: false,
      show_rank: true,
      show_cta: { js_method: 'getAllTop10' },
      movies: top10Movies,
    },
    {
      id: 'rating_hh3d',
      title: 'Đánh Giá Cao',
      subtitle: 'Phim được đánh giá cao nhất',
      card_height_percent: 0.18,
      card_size_ratio: 0.667,
      is_hero_source: false,
      show_rank: false,
      show_cta: { js_method: 'getAllRating' },
      movies: ratingMovies,
    },
  ];

  return JSON.stringify(rails);
}

// ===== CTA functions =====
async function getAllTop10(baseUrl) {
  const url = `${baseUrl}/bang-xep-hang-hoat-hinh-trung-quoc`;
  const html = await fetchText(url);
  return JSON.stringify(parseTop10List(html, baseUrl, 10));
}

async function getAllRating(baseUrl, page) {
  const p = Math.max(1, parseInt(page || 1, 10));
  const url = p <= 1 ? `${baseUrl}/hh3d-danh-gia-cao` : `${baseUrl}/hh3d-danh-gia-cao/page/${p}`;
  const html = await fetchText(url);
  return JSON.stringify(parseRatingList(html, baseUrl, 20));
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

// Parse Top 10 page: <article>...<span class="top-10-video top-N-hh3d">N</span>...
function parseTop10List(html, baseUrl, limit) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const articles = doc.querySelectorAll('article.thumb.grid-item');
  const movies = [];
  for (const art of articles) {
    if (movies.length >= limit) break;
    let rank = 0;
    const rankSpan = art.querySelector('span.top-10-video');
    if (rankSpan) {
      const r = parseInt(cleanText(rankSpan.textContent), 10);
      if (!isNaN(r)) rank = r;
    }
    const m = extractMovieFromCard(art, baseUrl, rank);
    if (m) movies.push(m);
  }
  return movies;
}

// Parse Rating page: <li>...<a class="halim-thumb">...
function parseRatingList(html, baseUrl, limit) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items = doc.querySelectorAll('li.thumb.grid-item');
  const movies = [];
  for (const li of items) {
    if (movies.length >= limit) break;
    const m = extractMovieFromCard(li, baseUrl, 0);
    if (m) movies.push(m);
  }
  return movies;
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
