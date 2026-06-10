// Provider: anime-2
// Categories: Filter Series
// Function: filterSeries(sortIdx, sortVal, genreId, genreIdx, genreVal, page, baseUrl) -> JSON string of movie array
// v6.1 contract: baseUrl dynamic.

async function filterSeries(sortIdx, sortVal, genreId, genreIdx, genreVal, page, baseUrl) {
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

  async function fetchText(url) {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`Fetch failed: ${url} -> HTTP ${resp.status}`);
    return await resp.text();
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

  function toSlug(text) {
    if (!text) return '';
    return text.toLowerCase()
      .replace(/à|á|ả|ã|ạ|ă|ằ|ắ|ẳ|ẵ|ặ|â|ầ|ấ|ẩ|ẫ|ậ/gi, 'a')
      .replace(/è|é|ẻ|ẽ|ẹ|ê|ề|ế|ể|ễ|ệ/gi, 'e')
      .replace(/ì|í|ỉ|ĩ|ị/gi, 'i')
      .replace(/ò|ó|ỏ|õ|ọ|ô|ồ|ố|ổ|ỗ|ộ|ơ|ờ|ớ|ở|ỡ|ợ/gi, 'o')
      .replace(/ù|ú|ủ|ũ|ụ|ư|ừ|ứ|ử|ữ|ự/gi, 'u')
      .replace(/ỳ|ý|ỷ|ỹ|ỵ/gi, 'y')
      .replace(/đ/gi, 'd')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
  }

  try {
    // Build URL based on genre (category) filter
    let url;
    if (genreVal && genreVal !== 'all') {
      const genreSlug = toSlug(genreVal);
      url = `${baseUrl}/the-loai/${genreSlug}`;
    } else {
      // Fallback to general series page
      url = `${baseUrl}/category/phim-bo`;
    }

    // Handle pagination
    const p = Math.max(1, parseInt(page || 1, 10));
    if (p > 1) {
      url = `${url}/page/${p}`;
    }

    // Fetch and parse
    const html = await fetchText(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const articles = doc.querySelectorAll('article.thumb.grid-item');
    const movies = [];

    for (const art of articles) {
      const m = extractMovieFromCard(art, baseUrl, 0);
      if (m) movies.push(m);
    }

    return JSON.stringify(movies);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}