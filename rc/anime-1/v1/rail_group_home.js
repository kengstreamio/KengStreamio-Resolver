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

  // -------- Trending (Đang thịnh hành) — from homepage --------
  function parseTrending(doc, siteBase) {
    const cards = doc.querySelectorAll('.halim-trending-card');
    logRail('trending raw cards=' + cards.length);
    var items = [];
    cards.forEach(function (card) {
      var link = card.querySelector('a.halim-trending-link');
      if (!link) return;
      var href = cleanText(link.getAttribute('href') || '');
      if (!href) return;
      var img = card.querySelector('img.halim-trending-poster-image');
      var posterUrl = img ? cleanText(img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
      var ratingEl = card.querySelector('.halim-trending-rating-value');
      var rating = ratingEl ? cleanText(ratingEl.textContent) : '';
      var numberEl = card.querySelector('.halim-trending-number');
      var rank = numberEl ? (parseInt(cleanText(numberEl.textContent), 10) || 0) : 0;
      var titleEl = card.querySelector('.halim-trending-title-text');
      var title = titleEl ? cleanText(titleEl.textContent) : '';
      if (!title && img) title = cleanText(img.getAttribute('alt') || '');
      var origEl = card.querySelector('.halim-trending-original-title');
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
      if (!title) title = cleanText(a.getAttribute('title') || '');
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

  // -------- Shared: parse category pages with article elements --------
  function parseCategoryArticles(doc, siteBase, label) {
    var box = doc.querySelector('.halim_box');
    if (!box) { logRail(label + ' no .halim_box'); return []; }
    var articles = box.querySelectorAll('article.halim-item, article.thumb, article.grid-item, article');
    logRail(label + ' raw articles=' + articles.length);
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
      var entryTitleEl = inner.querySelector('.entry-title, h2');
      var title = entryTitleEl ? cleanText(entryTitleEl.textContent) : cleanText(a.getAttribute('title') || '');
      if (!title) title = cleanText(a.getAttribute('title') || '');
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
    logRail(label + ' parsed=' + items.length);
    return items;
  }

  // -------- Top 10 (bang-xep-hang) --------
  function parseTop10(doc, siteBase) {
    var box = doc.querySelector('.halim_box');
    if (!box) { logRail('top10 no .halim_box'); return []; }
    var articles = box.querySelectorAll('article.halim-item, article.thumb, article.grid-item, article');
    logRail('top10 raw articles=' + articles.length);
    var items = [];
    articles.forEach(function (article) {
      var inner = article.querySelector('.halim-item') || article;
      var a = inner.querySelector('a.halim-thumb');
      if (!a) return;
      var href = cleanText(a.getAttribute('href') || '');
      if (!href) return;
      var img = inner.querySelector('img.img-responsive');
      var posterUrl = img ? cleanText(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      var rankEl = inner.querySelector('.top-10-video');
      var rank = rankEl ? (parseInt(cleanText(rankEl.textContent), 10) || 0) : 0;
      var entryTitleEl = inner.querySelector('.entry-title, h2');
      var title = entryTitleEl ? cleanText(entryTitleEl.textContent) : cleanText(a.getAttribute('title') || '');
      if (!title) title = cleanText(a.getAttribute('title') || '');
      var origEl = inner.querySelector('.original_title');
      var titleOriginal = origEl ? cleanText(origEl.textContent) : '';
      if (!title) return;
      items.push({
        rank: rank, title: title, title_original: titleOriginal,
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: '', badge_sub: '', year: '', rating: '',
        synopsis: '', age_rating: '', episode_current: '', genres: []
      });
    });
    logRail('top10 parsed=' + items.length);
    return items;
  }

  // -------- Đánh Giá Cao (li-based, has rating) --------
  function parseRatingList(doc, siteBase) {
    var box = doc.querySelector('.halim_box');
    if (!box) { logRail('ratingList no .halim_box'); return []; }
    var lis = box.querySelectorAll('li');
    logRail('ratingList raw lis=' + lis.length);
    var items = [];
    lis.forEach(function (li) {
      var a = li.querySelector('a.halim-thumb');
      if (!a) return;
      var href = cleanText(a.getAttribute('href') || '');
      if (!href) return;
      var img = li.querySelector('img.img-responsive');
      var posterUrl = img ? cleanText(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      var ratingScoreEl = li.querySelector('.rating-score');
      var rating = ratingScoreEl ? cleanText(ratingScoreEl.textContent) : '';
      var ratingCountEl = li.querySelector('.rating-count');
      var ratingCount = ratingCountEl ? cleanText(ratingCountEl.textContent) : '';
      var titleEl = li.querySelector('.halim-post-title h2 a, .halim-post-title h2');
      var title = titleEl ? cleanText(titleEl.textContent) : cleanText(a.getAttribute('title') || '');
      if (!title) return;
      items.push({
        rank: 0, title: title, title_original: '',
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: rating, badge_sub: ratingCount, year: '', rating: rating,
        synopsis: '', age_rating: '', episode_current: '', genres: []
      });
    });
    logRail('ratingList parsed=' + items.length);
    return items;
  }

  // -------- Rail builders --------
  function makeTrendingRail(movies) {
    return { id: 'phim_thinh_hanh', title: 'Phim Thịnh Hành', subtitle: null,
      card_height_percent: 0.22, card_size_ratio: 0.667, is_hero_source: true,
      show_rank: true, movies: movies, show_cta: null };
  }
  function makeNewUpdatesRail(movies) {
    return { id: 'phim_moi_cap_nhat', title: 'Phim Mới Cập Nhật', subtitle: null,
      card_height_percent: 0.18, card_size_ratio: 0.667, is_hero_source: false,
      show_rank: false, movies: movies, show_cta: null };
  }
  function makeTop10Rail(movies) {
    return { id: 'top10', title: 'Top 10', subtitle: 'Xếp hạng tuần',
      card_height_percent: 0.22, card_size_ratio: 0.667, is_hero_source: false,
      show_rank: true, movies: movies, show_cta: null };
  }
  function makeRatingRail(movies) {
    return { id: 'danh_gia_cao', title: 'Đánh Giá Cao', subtitle: 'Theo đánh giá',
      card_height_percent: 0.18, card_size_ratio: 0.667, is_hero_source: false,
      show_rank: false, movies: movies, show_cta: null };
  }
  function makeDangChieuRail(movies) {
    return { id: 'dang_chieu', title: 'Đang Chiếu', subtitle: null,
      card_height_percent: 0.18, card_size_ratio: 0.667, is_hero_source: false,
      show_rank: false, movies: movies, show_cta: null };
  }
  function makeHoanThanhRail(movies) {
    return { id: 'hoan_thanh', title: 'Phim Hoàn Thành', subtitle: null,
      card_height_percent: 0.18, card_size_ratio: 0.667, is_hero_source: false,
      show_rank: false, movies: movies, show_cta: null };
  }

  try {
    var siteBase = resolveBaseUrl(baseUrl);
    logRail('start siteBase=' + siteBase);
    if (!siteBase) throw new Error('Invalid baseUrl');

    // Fetch homepage + 4 category pages in parallel
    var pagePromises = [
      fetchDoc(siteBase, '/'),
      fetchDoc(siteBase, '/bang-xep-hang-hoat-hinh-trung-quoc'),
      fetchDoc(siteBase, '/hh3d-danh-gia-cao'),
      fetchDoc(siteBase, '/phim-dang-chieu'),
      fetchDoc(siteBase, '/phim-hoan-thanh')
    ];
    var results = await Promise.all(pagePromises);
    var homeDoc = results[0];
    var top10Doc = results[1];
    var danhGiaDoc = results[2];
    var dangChieuDoc = results[3];
    var hoanThanhDoc = results[4];
    logRail('all 5 pages fetched');

    // Parse all rails
    var trending = parseTrending(homeDoc, siteBase);
    var newUpdates = parseNewUpdates(homeDoc, siteBase);
    var top10 = parseTop10(top10Doc, siteBase);
    var danhGia = parseRatingList(danhGiaDoc, siteBase);
    var dangChieu = parseCategoryArticles(dangChieuDoc, siteBase, 'dang_chieu');
    var hoanThanh = parseCategoryArticles(hoanThanhDoc, siteBase, 'hoan_thanh');

    // Build rails (skip empty gracefully)
    var rails = [];
    if (trending.length) rails.push(makeTrendingRail(trending));
    if (newUpdates.length) rails.push(makeNewUpdatesRail(newUpdates));
    if (top10.length) rails.push(makeTop10Rail(top10));
    if (danhGia.length) rails.push(makeRatingRail(danhGia));
    if (dangChieu.length) rails.push(makeDangChieuRail(dangChieu));
    if (hoanThanh.length) rails.push(makeHoanThanhRail(hoanThanh));

    logRail('success rails=' + rails.length);
    return JSON.stringify(rails);
  } catch (e) {
    logRail('error ' + (e && e.message ? e.message : String(e)));
    return JSON.stringify({ error: e && e.message ? e.message : String(e) });
  }
}
