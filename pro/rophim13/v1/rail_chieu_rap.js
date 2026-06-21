// Provider: rophim-13 | Site: https://onflix.lol
// Contract: railChieuRap(baseUrl) -> JSON { rails: [...] }
// API: https://k8s.onflixcdn.com/api/movies?type=chieu_rap&sort=newest&page=1&limit=12
// v6.1 rail-group contract — standalone CTA rail

// ===== SHARED CONSTANTS (file scope) =====
const _CR_API = 'https://k8s.onflixcdn.com/api';
const _CR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function _crFetchOpts(referer) {
  return {
    headers: {
      'User-Agent': _CR_UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': referer || 'https://onflix.lol/',
      'Origin': 'https://onflix.lol',
    },
  };
}

function _crTransformMovie(m, siteBase) {
  let badgeSub = '';
  const vs = m.vietsub || 0;
  const tm = m.thuyet_minh || 0;
  if (vs > 0 && tm > 0) {
    badgeSub = `P.Đ ${vs} | T.M ${tm}`;
  } else if (vs > 0) {
    badgeSub = `P.Đ ${vs}`;
  } else if (tm > 0) {
    badgeSub = `T.M ${tm}`;
  }
  const mediaType = m.type === 'phim-bo' ? 'series' : 'movie';
  const genres = m.categories
    ? m.categories.split(', ').map(g => g.trim()).filter(Boolean)
    : [];
  return {
    rank: 0,
    title: m.title || '',
    title_original: m.original_title || '',
    poster_url: m.thumb_url || m.poster_url || '',
    url: m.slug ? `${siteBase}/phim/${m.slug}` : '',
    media_type: mediaType,
    badge_text: m.quality || '',
    badge_sub: badgeSub,
    year: m.year ? String(m.year) : '',
    rating: m.tmdb_vote_average ? String(m.tmdb_vote_average) : '',
    synopsis: '',
    age_rating: m.rated || '',
    episode_current: m.episode_current || '',
    genres: genres,
  };
}

async function railChieuRap(baseUrl) {
  console.log('[KENG][rophim-13] railChieuRap() v1');

  try {
    const apiUrl = `${_CR_API}/movies?type=chieu_rap&sort=newest&page=1&limit=12`;
    const res = await fetch(apiUrl, _crFetchOpts(baseUrl + '/'));
    if (!res.ok) throw new Error('Movies API returned ' + res.status);
    const data = await res.json();
    const rawMovies = data.data || [];

    const seen = new Set();
    const movies = [];
    for (const m of rawMovies) {
      if (m.slug && !seen.has(m.slug)) {
        seen.add(m.slug);
        movies.push(_crTransformMovie(m, baseUrl));
      }
    }

    const validMovies = movies
      .filter(m => m.title && m.url)
      .sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
    console.log(`[KENG][rophim-13] railChieuRap() done — ${validMovies.length} movies`);

    return JSON.stringify({
      rails: [{
        id: 'chieu_rap',
        title: 'Phim Chiếu Rạp',
        subtitle: null,
        card_height_percent: 0.22,
        card_size_ratio: 0.667,
        is_hero_source: false,
        show_rank: false,
        movies: validMovies,
        show_cta: { js_method: 'getAllChieuRap' },
      }],
    });
  } catch (e) {
    console.log(`[KENG][rophim-13] railChieuRap() error: ${e.message}`);
    return JSON.stringify({ rails: [] });
  }
}

// ===== CTA FUNCTION =====
async function getAllChieuRap(page = 1) {
  const url = `${_CR_API}/movies?type=chieu_rap&sort=newest&page=${page}&limit=12`;
  const res = await fetch(url, _crFetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.data || []).map(m => _crTransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}
