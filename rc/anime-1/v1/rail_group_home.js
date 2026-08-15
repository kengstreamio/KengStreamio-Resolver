/**
 * Keng Common JS — shared utilities injected before each provider's resolver.
 * Keep this file self-contained; it will be prepended to provider JS at deploy time.
 *
 * Contract: all functions are available in provider resolvers via normal JS scoping.
 */

// ── HLS Ad Detection ────────────────────────────────────────────────────────
// Parse HLS variant playlist for SSAI ad segments.
// Detects ad patterns in HLS segment URLs:
//   - /adjump/ URLs
//   - convertvN/ prefix segments (convertv7/, convertv8/, convertv9/, ...)
//   - /vN/ prefix with segment_XXX.ts (numbered SSAI ad segments, any version)
//
// NOTE: every clause must evaluate to a boolean. Never compare a .test() result
// against -1 — `-1 !== false` is true, which classifies every segment as an ad
// and makes the whole movie look like one giant ad break.
function _isAdSegment(segment) {
  return segment.indexOf('/adjump/') !== -1
      || /convertv\d+\//.test(segment)
      || /^\/v\d+\/.*segment_/.test(segment);
}

function parseAdsFromPlaylist(playlistText) {
  var ads = [];
  var lines = playlistText.split('\n');
  var cumulative = 0.0;
  var adStart = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf('#EXTINF:') !== 0) continue;

    var match = line.match(/#EXTINF:([\d.]+)/);
    if (!match) continue;
    var duration = parseFloat(match[1]);
    if (isNaN(duration)) continue;

    var segment = (lines[i + 1] || '').trim();

    if (_isAdSegment(segment)) {
      if (adStart === null) adStart = cumulative;
    } else {
      if (adStart !== null) {
        ads.push({
          start: Math.round(adStart * 100) / 100,
          end: Math.round(cumulative * 100) / 100,
          duration: Math.round((cumulative - adStart) * 100) / 100,
        });
        adStart = null;
      }
    }
    cumulative += duration;
  }

  if (adStart !== null) {
    ads.push({
      start: Math.round(adStart * 100) / 100,
      end: Math.round(cumulative * 100) / 100,
      duration: Math.round((cumulative - adStart) * 100) / 100,
    });
  }

  return ads;
}

// Total playable duration of a playlist, in seconds.
function _playlistTotalDuration(playlistText) {
  var lines = playlistText.split('\n');
  var total = 0.0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf('#EXTINF:') !== 0) continue;
    var match = line.match(/#EXTINF:([\d.]+)/);
    if (!match) continue;
    var d = parseFloat(match[1]);
    if (!isNaN(d)) total += d;
  }
  return Math.round(total * 100) / 100;
}

// Sanity-checked ad detection.
// Returns an array of ad zones, or null when the result looks bogus — a
// mis-classifying detector would otherwise report the entire movie as one ad
// zone and the player would seek straight to the end.
//
// null means "detection not trustworthy" and is distinct from [] ("no ads"),
// which the Dart side relies on (see StreamResult.ads).
function detectAdsSafe(playlistText) {
  var total = _playlistTotalDuration(playlistText);
  if (total <= 0) return null;

  var ads = parseAdsFromPlaylist(playlistText);
  if (ads.length === 0) return [];

  var adTotal = 0.0;
  for (var i = 0; i < ads.length; i++) adTotal += ads[i].duration;

  // Guard 1 — ads covering (nearly) the whole playlist is a detector failure,
  // not a real stream.
  if (adTotal >= total * 0.8) {
    console.log('[KENG][common] Ads rejected: ' + adTotal + 's of ' + total + 's (>=80%) — treating as detection failure');
    return null;
  }

  // Guard 2 — a single zone spanning start to end, same failure shape.
  if (ads.length === 1 && ads[0].start <= 0.01 && ads[0].end >= total - 0.01) {
    console.log('[KENG][common] Ads rejected: single zone spans whole playlist');
    return null;
  }

  return ads;
}

function _isMasterPlaylist(playlistText) {
  return playlistText.indexOf('#EXT-X-STREAM-INF') !== -1;
}

// Resolve a possibly-relative playlist reference against its base URL.
// Handles absolute, root-relative, protocol-relative and plain relative paths.
function _resolveUrl(ref, baseUrl) {
  try {
    return new URL(ref, baseUrl).href;
  } catch (_e) {
    return ref;
  }
}

// First variant URI declared in a master playlist, or '' if none.
function _firstVariantPath(masterText) {
  var lines = masterText.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim().indexOf('#EXT-X-STREAM-INF') !== 0) continue;
    for (var j = i + 1; j < lines.length; j++) {
      var t = lines[j].trim();
      if (!t) continue;
      if (t.charAt(0) === '#') continue;
      return t;
    }
  }
  return '';
}

// PA-class CDN. These are served as a master playlist whose variant URL must be
// handed to the player directly — established behaviour, keep it.
// Every other CDN keeps its original URL so the player can still do ABR.
function _isPaCdn(url) {
  return url.indexOf('kkphimplayer') !== -1 || url.indexOf('phim1280.tv') !== -1;
}

function _kengFetchText(url, headers, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return fetch(url, { headers: headers, signal: controller.signal })
    .then(function (resp) {
      clearTimeout(timer);
      if (!resp.ok) return null;
      return resp.text();
    })
    .catch(function () {
      clearTimeout(timer);
      return null;
    });
}

// Fetch + resolve m3u8 → ad-annotated stream result.
// Works on any CDN: detection is driven by playlist content, not by domain.
// Returns { type, url, headers, ads } or null on failure.
async function resolveAdsVariant(m3u8Url, referer) {
  var kengUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  var origin;
  try { origin = new URL(m3u8Url).origin; } catch (_e) { origin = ''; }

  var reqHeaders = {
    'User-Agent': kengUA,
    'Accept': '*/*',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': referer || origin + '/',
    'Origin': origin || '',
  };

  try {
    var firstText = await _kengFetchText(m3u8Url, reqHeaders, 2000);
    if (firstText === null) return null;

    var mediaText = firstText;
    var variantUrl = m3u8Url;

    if (_isMasterPlaylist(firstText)) {
      var variantPath = _firstVariantPath(firstText);
      if (!variantPath) return null;
      variantUrl = _resolveUrl(variantPath, m3u8Url);

      var variantText = await _kengFetchText(variantUrl, reqHeaders, 2000);
      if (variantText === null) {
        // Variant unreachable — still playable, just without ad info.
        mediaText = '';
      } else {
        mediaText = variantText;
      }
    }
    // else: m3u8Url is already a media playlist — parse it directly and never
    // mistake its first segment (.ts) for a variant URL.

    var ads = mediaText ? detectAdsSafe(mediaText) : null;
    if (ads && ads.length > 0) {
      console.log('[KENG][common] Ads detected: ' + JSON.stringify(ads));
    }

    // PA needs the resolved variant URL; everyone else keeps the original so
    // the player retains adaptive bitrate across renditions.
    var outUrl = _isPaCdn(m3u8Url) ? variantUrl : m3u8Url;

    console.log('[KENG][common] Stream resolved: ' + outUrl + ' | ads=' + (ads === null ? 'null' : ads.length));
    return {
      type: 'm3u8',
      url: outUrl,
      headers: { 'Referer': referer, 'User-Agent': kengUA },
      ads: ads,
    };
  } catch (e) {
    return null;
  }
}

// Main entry: probe the playlist for SSAI ads → build result.
// Usage: var result = await makeStreamM3U8Result(m3u8Url, referer);
async function makeStreamM3U8Result(m3u8Url, referer) {
  var kengUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  var result = await resolveAdsVariant(m3u8Url, referer);
  if (result) return result;

  console.log('[KENG][common] Ad probe failed, falling back to original URL');
  return {
    type: 'm3u8',
    url: m3u8Url,
    headers: { 'Referer': referer, 'User-Agent': kengUA },
  };
}

// ── Provider: anime-1 ──────────────────────────────────────

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
    if (top10.length) rails.push(makeTop10Rail(top10));
    if (trending.length) rails.push(makeTrendingRail(trending));
    if (newUpdates.length) rails.push(makeNewUpdatesRail(newUpdates));
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
