async function railGroupHome(baseUrl) {
  function resolveBaseUrl(baseUrl) {
    if (typeof baseUrl === 'string' && /^https?:\/\//i.test(baseUrl)) {
      return baseUrl.replace(/\/+$/, '');
    }
    if (typeof location !== 'undefined' && location.origin) {
      return location.origin.replace(/\/+$/, '');
    }
    return '';
  }

  function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function absUrl(baseUrl, url) {
    const text = cleanText(url);
    if (!text) return '';
    try { return new URL(text, baseUrl).href; } catch (_e) { return text; }
  }

  function logRail(message) {
    try { console.log('[KENG][anime-1][railGroupHome] ' + message); } catch (_e) {}
  }

  // -------- Trending (Đang thịnh hành) --------
  function parseTrending(doc, siteBase) {
    const cards = doc.querySelectorAll('.halim-trending-card');
    logRail('trending raw cards=' + cards.length);
    const items = [];
    cards.forEach((card) => {
      const link = card.querySelector('a.halim-trending-link');
      if (!link) return;
      const href = cleanText(link.getAttribute('href') || '');
      if (!href) return;
      const img = card.querySelector('img.halim-trending-poster-image');
      const posterUrl = img ? cleanText(img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
      const ratingEl = card.querySelector('.halim-trending-rating-value');
      const rating = ratingEl ? cleanText(ratingEl.textContent) : '';
      const numberEl = card.querySelector('.halim-trending-number');
      const rank = numberEl ? (parseInt(cleanText(numberEl.textContent), 10) || 0) : 0;
      const titleEl = card.querySelector('.halim-trending-title-text');
      let title = titleEl ? cleanText(titleEl.textContent) : '';
      if (!title && img) title = cleanText(img.getAttribute('alt') || '');
      const origEl = card.querySelector('.halim-trending-original-title');
      const titleOriginal = origEl ? cleanText(origEl.textContent) : '';
      if (!title) return;
      if ((title + ' ' + titleOriginal).toLowerCase().includes('trailer')) return;
      items.push({
        rank: rank,
        title: title,
        title_original: titleOriginal,
        poster_url: absUrl(siteBase, posterUrl),
        thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href),
        media_type: 'series',
        badge_text: '',
        badge_sub: '',
        year: '',
        rating: rating,
        synopsis: '',
        age_rating: '',
        episode_current: '',
        genres: []
      });
    });
    logRail('trending parsed=' + items.length);
    return items;
  }

  // -------- Mới Cập Nhật (Newly Updated) --------
  function parseNewUpdates(doc, siteBase) {
    const sectionTitles = doc.querySelectorAll('.section-bar .section-title');
    let targetBox = null;
    sectionTitles.forEach((titleEl) => {
      const txt = cleanText(titleEl.textContent).toLowerCase();
      if (txt.includes('mới cập nhật')) {
        targetBox = titleEl.closest('.halim_box') || titleEl.parentElement;
      }
    });
    if (!targetBox) {
      logRail('new updates section not found');
      return [];
    }
    const articles = targetBox.querySelectorAll('article.halim-item, article.thumb, article.grid-item');
    logRail('new updates raw articles=' + articles.length);
    const items = [];
    articles.forEach((article) => {
      const inner = article.querySelector('.halim-item') || article;
      const a = inner.querySelector('a.halim-thumb');
      if (!a) return;
      const href = cleanText(a.getAttribute('href') || '');
      if (!href) return;
      const img = inner.querySelector('img.img-responsive');
      const posterUrl = img ? cleanText(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      const statusEl = inner.querySelector('.status');
      const status = statusEl ? cleanText(statusEl.textContent) : '';
      const episodeEl = inner.querySelector('.episode');
      const episode = episodeEl ? cleanText(episodeEl.textContent) : '';
      const entryTitleEl = inner.querySelector('.entry-title');
      let title = entryTitleEl ? cleanText(entryTitleEl.textContent) : cleanText(a.getAttribute('title') || '');
      if (!title) title = cleanText(a.getAttribute('title') || '');
      const origEl = inner.querySelector('.original_title');
      const titleOriginal = origEl ? cleanText(origEl.textContent) : '';
      if (!title) return;
      if ((title + ' ' + titleOriginal).toLowerCase().includes('trailer')) return;
      items.push({
        rank: 0,
        title: title,
        title_original: titleOriginal,
        poster_url: absUrl(siteBase, posterUrl),
        thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href),
        media_type: 'series',
        badge_text: episode,
        badge_sub: status,
        year: '',
        rating: '',
        synopsis: '',
        age_rating: '',
        episode_current: episode,
        genres: []
      });
    });
    logRail('new updates parsed=' + items.length);
    return items;
  }

  function makeTrendingRail(movies) {
    return {
      id: 'phim_thinh_hanh',
      title: 'Phim Thịnh Hành',
      subtitle: null,
      card_height_percent: 0.22,
      card_size_ratio: 0.667,
      is_hero_source: true,
      show_rank: true,
      movies: movies,
      show_cta: null
    };
  }

  function makeNewUpdatesRail(movies) {
    return {
      id: 'phim_moi_cap_nhat',
      title: 'Phim Mới Cập Nhật',
      subtitle: null,
      card_height_percent: 0.18,
      card_size_ratio: 0.667,
      is_hero_source: false,
      show_rank: false,
      movies: movies,
      show_cta: null
    };
  }

  try {
    const siteBase = resolveBaseUrl(baseUrl);
    logRail('start siteBase=' + siteBase);
    if (!siteBase) throw new Error('Invalid baseUrl');
    const res = await fetch(siteBase + '/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      credentials: 'include'
    });
    if (!res.ok) throw new Error('Fetch home failed: ' + res.status);
    const html = await res.text();
    logRail('html len=' + html.length);
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const trending = parseTrending(doc, siteBase);
    const newUpdates = parseNewUpdates(doc, siteBase);
    const rails = [];
    if (trending.length) rails.push(makeTrendingRail(trending));
    if (newUpdates.length) rails.push(makeNewUpdatesRail(newUpdates));
    logRail('success rails=' + rails.length + ' totalMovies=' + (trending.length + newUpdates.length));
    return JSON.stringify(rails);
  } catch (e) {
    logRail('error ' + (e && e.message ? e.message : String(e)));
    return JSON.stringify({ error: e && e.message ? e.message : String(e) });
  }
}
