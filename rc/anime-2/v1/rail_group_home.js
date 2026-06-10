// Provider: anime-2 (hhpanda.st)
// Rail Group: Home
// Function: railGroupHome(baseUrl) -> JSON string of rail objects array
// v6.1 contract: baseUrl dynamic.

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
    try { console.log('[KENG][anime-2][railGroupHome] ' + message); } catch (_e) {}
  }

  function fetchDoc(siteBase, path) {
    return fetch(siteBase + path, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      credentials: 'include'
    }).then(function (res) {
      if (!res.ok) throw new Error('Fetch ' + path + ' failed: ' + res.status);
      return res.text();
    }).then(function (html) {
      return new DOMParser().parseFromString(html, 'text/html');
    });
  }

  // -------- Trending (Đang thịnh hành) — from homepage swiper slides --------
  function parseTrending(doc, siteBase) {
    const slides = doc.querySelectorAll('.top-slide, .swiper-slide');
    logRail('trending slides=' + slides.length);
    var items = [];
    slides.forEach(function (slide) {
      var link = slide.querySelector('a.halim-trending-link');
      if (!link) return;
      var href = cleanText(link.getAttribute('href') || '');
      if (!href) return;
      var img = slide.querySelector('img.film-poster-img, img.img-responsive, img.wp-post-image');
      var posterUrl = img ? cleanText(img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
      var ratingEl = slide.querySelector('.halim-trending-rating-value');
      var rating = ratingEl ? cleanText(ratingEl.textContent) : '';
      var numberEl = slide.querySelector('.halim-trending-number');
      var rank = numberEl ? (parseInt(cleanText(numberEl.textContent), 10) || 0) : 0;
      var titleEl = slide.querySelector('.halim-trending-title-text');
      var title = titleEl ? cleanText(titleEl.textContent) : '';
      if (!title && img) title = cleanText(img.getAttribute('alt') || '');
      var origEl = slide.querySelector('.halim-trending-original-title');
      var titleOriginal = origEl ? cleanText(origEl.textContent) : '';
      if (!title) return;
      if ((title + ' ' + titleOriginal).toLowerCase().indexOf('trailer') >= 0) return;
      items.push({
        rank: rank, title: title, title_original: titleOriginal,
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: '', badge_sub: '', year: '', rating: rating,
        synopsis: '', age_rating: '', episode_current: '', genres: []
      });
    });
    logRail('trending parsed=' + items.length);
    return items;
  }

  // -------- Mới Cập Nhật — from homepage --------
  function parseNewUpdates(doc, siteBase) {
    var sectionTitles = doc.querySelectorAll('.section-bar .section-title');
    var targetBox = null;
    sectionTitles.forEach(function (titleEl) {
      var txt = cleanText(titleEl.textContent).toLowerCase();
      if (txt.indexOf('mới cập nhật') >= 0) {
        targetBox = titleEl.closest('.halim_box') || titleEl.parentElement;
      }
    });
    if (!targetBox) { logRail('new updates section not found'); return []; }
    var articles = targetBox.querySelectorAll('article.halim-item, article.thumb, article.grid-item');
    logRail('new updates raw articles=' + articles.length);
    var items = [];
    articles.forEach(function (article) {
      var inner = article.querySelector('.halim-item') || article;
      var a = inner.querySelector('a.halim-thumb');
      if (!a) return;
      var href = cleanText(a.getAttribute('href') || '');
      if (!href) return;
      var img = inner.querySelector('img.img-responsive');
      var posterUrl = img ? cleanText(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      var statusEl = inner.querySelector('.status');
      var status = statusEl ? cleanText(statusEl.textContent) : '';
      var episodeEl = inner.querySelector('.episode');
      var episode = episodeEl ? cleanText(episodeEl.textContent) : '';
      var entryTitleEl = inner.querySelector('.entry-title');
      var title = entryTitleEl ? cleanText(entryTitleEl.textContent) : cleanText(a.getAttribute('title') || '');
      var origEl = inner.querySelector('.original_title');
      var titleOriginal = origEl ? cleanText(origEl.textContent) : '';
      if (!title) return;
      if ((title + ' ' + titleOriginal).toLowerCase().indexOf('trailer') >= 0) return;
      items.push({
        rank: 0, title: title, title_original: titleOriginal,
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: episode, badge_sub: status, year: '', rating: '',
        synopsis: '', age_rating: '', episode_current: episode, genres: []
      });
    });
    logRail('new updates parsed=' + items.length);
    return items;
  }

  // -------- Main Execution --------
  var siteBase = resolveBaseUrl(baseUrl);
  if (!siteBase) {
    return JSON.stringify({ error: 'invalid baseUrl' });
  }

  logRail('fetching homepage from ' + siteBase);

  return fetchDoc(siteBase, '/').then(function (doc) {
    var trending = parseTrending(doc, siteBase);
    var newUpdates = parseNewUpdates(doc, siteBase);

    // Build rail objects (v6 contract)
    var rails = [];

    // Rail: trending (phim_hot equivalent)
    if (trending.length > 0) {
      rails.push({
        rail_id: 'phim_hot',
        rail_name: 'Phim Hot',
        items: trending
      });
    }

    // Rail: new updates (new_series equivalent)
    if (newUpdates.length > 0) {
      rails.push({
        rail_id: 'new_series',
        rail_name: 'Mới Cập Nhật',
        items: newUpdates
      });
    }

    logRail('rails output: ' + rails.length);
    return JSON.stringify(rails);
  }).catch(function (err) {
    logRail('error: ' + err.message);
    return JSON.stringify({ error: err.message });
  });
}