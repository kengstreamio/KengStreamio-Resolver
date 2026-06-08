// Provider: anime-1
// Rail group: Phim Bộ - 8 categories (genres)
//   Huyền Huyễn  -> /huyen-huyen
//   Xuyên Không  -> /xuyen-khong
//   Trùng Sinh   -> /trung-sinh
//   Tiên Hiệp    -> /tien-hiep
//   Cổ Trang     -> /co-trang
//   Hài Hước     -> /hai-huoc
//   Kiếm Hiệp    -> /kiem-hiep
//   Hiện Đại     -> /hien-dai
// Sort: mới nhất (newest first, default sort)
// Each rail returns 20 movies + CTA to paginate.
// v6.1 contract: baseUrl dynamic, CTA functions embedded in same file.

const PHIM_BO_CATEGORIES = [
  { id: 'huyen_huyen', title: 'Huyền Huyễn',  slug: 'huyen-huyen' },
  { id: 'xuyen_khong', title: 'Xuyên Không',  slug: 'xuyen-khong' },
  { id: 'trung_sinh',  title: 'Trùng Sinh',   slug: 'trung-sinh' },
  { id: 'tien_hiep',   title: 'Tiên Hiệp',    slug: 'tien-hiep' },
  { id: 'co_trang',    title: 'Cổ Trang',     slug: 'co-trang' },
  { id: 'hai_huoc',    title: 'Hài Hước',     slug: 'hai-huoc' },
  { id: 'kiem_hiep',   title: 'Kiếm Hiệp',    slug: 'kiem-hiep' },
  { id: 'hien_dai',    title: 'Hiện Đại',     slug: 'hien-dai' },
];

async function railGroupPhimBo(baseUrl) {
  // Fetch all 8 category pages in parallel.
  const fetches = PHIM_BO_CATEGORIES.map(c => fetchText(`${baseUrl}/${c.slug}`));
  const htmls = await Promise.all(fetches);

  const rails = PHIM_BO_CATEGORIES.map((cat, i) => ({
    id: `phim_bo_${cat.id}`,
    title: cat.title,
    subtitle: 'Phim bộ mới nhất',
    card_height_percent: 0.18,
    card_size_ratio: 0.667,
    is_hero_source: false,
    show_rank: false,
    show_cta: { js_method: `getAll${capitalize(cat.id)}` },
    movies: parseGenericList(htmls[i], baseUrl, 20),
  }));

  return JSON.stringify(rails);
}

// ===== CTA functions - one per category =====
async function getAllHuyenHuyen(baseUrl, page)   { return getCategoryPage(baseUrl, 'huyen-huyen',  page); }
async function getAllXuyenKhong(baseUrl, page)   { return getCategoryPage(baseUrl, 'xuyen-khong',  page); }
async function getAllTrungSinh(baseUrl, page)    { return getCategoryPage(baseUrl, 'trung-sinh',   page); }
async function getAllTienHiep(baseUrl, page)     { return getCategoryPage(baseUrl, 'tien-hiep',    page); }
async function getAllCoTrang(baseUrl, page)      { return getCategoryPage(baseUrl, 'co-trang',     page); }
async function getAllHaiHuoc(baseUrl, page)      { return getCategoryPage(baseUrl, 'hai-huoc',     page); }
async function getAllKiemHiep(baseUrl, page)     { return getCategoryPage(baseUrl, 'kiem-hiep',    page); }
async function getAllHienDai(baseUrl, page)      { return getCategoryPage(baseUrl, 'hien-dai',     page); }

async function getCategoryPage(baseUrl, slug, page) {
  const p = Math.max(1, parseInt(page || 1, 10));
  const url = p <= 1 ? `${baseUrl}/${slug}` : `${baseUrl}/${slug}/page/${p}`;
  const html = await fetchText(url);
  return JSON.stringify(parseGenericList(html, baseUrl, 20));
}

// ===== Helpers =====
async function fetchText(url) {
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`Fetch failed: ${url} -> HTTP ${resp.status}`);
  return await resp.text();
}

function capitalize(s) {
  return s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
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
