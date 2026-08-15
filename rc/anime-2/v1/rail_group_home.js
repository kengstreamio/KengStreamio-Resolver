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

// ── Provider: anime-2 ──────────────────────────────────────

// Provider: anime-2 (hhpanda.st)
// Rail Group: Home
// Function: railGroupHome(baseUrl) -> JSON string of rail objects array
// v6.1 contract: baseUrl dynamic. Returns { rails: [...] } wrapper.
// 4 rails: Trending, New Updates, Top 10, Completed

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

  // -------- Trending (Phim Hot) — from homepage swiper --------
  function parseTrending(doc, siteBase) {
    const slides = doc.querySelectorAll('.top-slide, .swiper-slide');
    logRail('trending slides=' + slides.length);
    var items = [];
    slides.forEach(function (slide) {
      var link = slide.querySelector('a.halim-trending-link, a');
      if (!link) return;
      var href = cleanText(link.getAttribute('href') || '');
      if (!href) return;
      var img = slide.querySelector('img.film-poster-img, img.img-responsive, img.wp-post-image');
      var posterUrl = img ? cleanText(img.getAttribute('src') || img.getAttribute('data-src') || '') : '';
      var ratingEl = slide.querySelector('.halim-trending-rating-value');
      var rating = ratingEl ? cleanText(ratingEl.textContent) : '';
      var titleEl = slide.querySelector('.halim-trending-title-text, h2, h3, .title');
      var title = titleEl ? cleanText(titleEl.textContent) : '';
      if (!title && img) title = cleanText(img.getAttribute('alt') || '');
      if (!title) return;
      if (title.toLowerCase().indexOf('trailer') >= 0) return;
      items.push({
        rank: 0, title: title, title_original: '',
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: '', badge_sub: '', year: '', rating: rating,
        synopsis: '', age_rating: '', episode_current: '', genres: []
      });
    });
    logRail('trending parsed=' + items.length);
    return items;
  }

  // -------- New Updates (Mới Cập Nhật) — from homepage section --------
  function parseNewUpdates(doc, siteBase) {
    var sectionTitles = doc.querySelectorAll('.section-bar .section-title, .section-title, h2');
    var targetBox = null;
    sectionTitles.forEach(function (titleEl) {
      var txt = cleanText(titleEl.textContent).toLowerCase();
      if (txt.indexOf('mới cập nhật') >= 0 || txt.indexOf('latest') >= 0) {
        targetBox = titleEl.closest('.halim_box') || titleEl.closest('.section') || titleEl.parentElement;
      }
    });
    if (!targetBox) { logRail('new updates section not found'); return []; }
    var articles = targetBox.querySelectorAll('article.halim-item, article.thumb, article.grid-item, article');
    logRail('new updates raw articles=' + articles.length);
    var items = [];
    articles.forEach(function (article) {
      var inner = article.querySelector('.halim-item') || article;
      var a = inner.querySelector('a.halim-thumb, a');
      if (!a) return;
      var href = cleanText(a.getAttribute('href') || '');
      if (!href) return;
      var img = inner.querySelector('img.img-responsive, img');
      var posterUrl = img ? cleanText(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      var statusEl = inner.querySelector('.status');
      var status = statusEl ? cleanText(statusEl.textContent) : '';
      var episodeEl = inner.querySelector('.episode');
      var episode = episodeEl ? cleanText(episodeEl.textContent) : '';
      var entryTitleEl = inner.querySelector('.entry-title, h2, h3');
      var title = entryTitleEl ? cleanText(entryTitleEl.textContent) : cleanText(a.getAttribute('title') || '');
      if (!title) return;
      if (title.toLowerCase().indexOf('trailer') >= 0) return;
      items.push({
        rank: 0, title: title, title_original: '',
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: episode, badge_sub: status, year: '', rating: '',
        synopsis: '', age_rating: '', episode_current: episode, genres: []
      });
    });
    logRail('new updates parsed=' + items.length);
    return items;
  }

  // -------- Top 10 — from /top-10 or ranking page --------
  function parseTop10(doc, siteBase) {
    var articles = doc.querySelectorAll('article.halim-item, article.thumb, article.grid-item, article');
    logRail('top10 raw articles=' + articles.length);
    var items = [];
    articles.forEach(function (article) {
      var inner = article.querySelector('.halim-item') || article;
      var a = inner.querySelector('a.halim-thumb, a');
      if (!a) return;
      var href = cleanText(a.getAttribute('href') || '');
      if (!href) return;
      var img = inner.querySelector('img.img-responsive, img');
      var posterUrl = img ? cleanText(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      var rankEl = inner.querySelector('.top-10-video, .rank, .ranking');
      var rank = rankEl ? (parseInt(cleanText(rankEl.textContent), 10) || 0) : 0;
      var entryTitleEl = inner.querySelector('.entry-title, h2, h3');
      var title = entryTitleEl ? cleanText(entryTitleEl.textContent) : cleanText(a.getAttribute('title') || '');
      if (!title) return;
      if (title.toLowerCase().indexOf('trailer') >= 0) return;
      items.push({
        rank: rank, title: title, title_original: '',
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: '', badge_sub: '', year: '', rating: '',
        synopsis: '', age_rating: '', episode_current: '', genres: []
      });
    });
    logRail('top10 parsed=' + items.length);
    return items;
  }

  // -------- High Rating (Đánh Giá Cao) — from rating page --------
  function parseRatingList(doc, siteBase) {
    var articles = doc.querySelectorAll('article.halim-item, article.thumb, article.grid-item, article');
    logRail('ratingList raw articles=' + articles.length);
    var items = [];
    articles.forEach(function (article) {
      var inner = article.querySelector('.halim-item') || article;
      var a = inner.querySelector('a.halim-thumb, a');
      if (!a) return;
      var href = cleanText(a.getAttribute('href') || '');
      if (!href) return;
      var img = inner.querySelector('img.img-responsive, img');
      var posterUrl = img ? cleanText(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      var ratingScoreEl = inner.querySelector('.rating-score, .rating');
      var rating = ratingScoreEl ? cleanText(ratingScoreEl.textContent) : '';
      var titleEl = inner.querySelector('.entry-title, h2, h3');
      var title = titleEl ? cleanText(titleEl.textContent) : cleanText(a.getAttribute('title') || '');
      if (!title) return;
      if (title.toLowerCase().indexOf('trailer') >= 0) return;
      items.push({
        rank: 0, title: title, title_original: '',
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: rating, badge_sub: '', year: '', rating: rating,
        synopsis: '', age_rating: '', episode_current: '', genres: []
      });
    });
    logRail('ratingList parsed=' + items.length);
    return items;
  }

  // -------- Currently Airing (Đang Chiếu) — from /dang-chieu or similar --------
  function parseDangChieu(doc, siteBase) {
    var articles = doc.querySelectorAll('article.halim-item, article.thumb, article.grid-item, article');
    logRail('dang_chieu raw articles=' + articles.length);
    var items = [];
    articles.forEach(function (article) {
      var inner = article.querySelector('.halim-item') || article;
      var a = inner.querySelector('a.halim-thumb, a');
      if (!a) return;
      var href = cleanText(a.getAttribute('href') || '');
      if (!href) return;
      var img = inner.querySelector('img.img-responsive, img');
      var posterUrl = img ? cleanText(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      var statusEl = inner.querySelector('.status');
      var status = statusEl ? cleanText(statusEl.textContent) : '';
      var episodeEl = inner.querySelector('.episode');
      var episode = episodeEl ? cleanText(episodeEl.textContent) : '';
      var titleEl = inner.querySelector('.entry-title, h2, h3');
      var title = titleEl ? cleanText(titleEl.textContent) : cleanText(a.getAttribute('title') || '');
      if (!title) return;
      if (title.toLowerCase().indexOf('trailer') >= 0) return;
      items.push({
        rank: 0, title: title, title_original: '',
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: episode, badge_sub: status, year: '', rating: '',
        synopsis: '', age_rating: '', episode_current: episode, genres: []
      });
    });
    logRail('dang_chieu parsed=' + items.length);
    return items;
  }

  // -------- Completed (Phim Hoàn Thành) — from /hoan-thanh or similar --------
  function parseHoanThanh(doc, siteBase) {
    var articles = doc.querySelectorAll('article.halim-item, article.thumb, article.grid-item, article');
    logRail('hoan_thanh raw articles=' + articles.length);
    var items = [];
    articles.forEach(function (article) {
      var inner = article.querySelector('.halim-item') || article;
      var a = inner.querySelector('a.halim-thumb, a');
      if (!a) return;
      var href = cleanText(a.getAttribute('href') || '');
      if (!href) return;
      var img = inner.querySelector('img.img-responsive, img');
      var posterUrl = img ? cleanText(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      var titleEl = inner.querySelector('.entry-title, h2, h3');
      var title = titleEl ? cleanText(titleEl.textContent) : cleanText(a.getAttribute('title') || '');
      if (!title) return;
      if (title.toLowerCase().indexOf('trailer') >= 0) return;
      items.push({
        rank: 0, title: title, title_original: '',
        poster_url: absUrl(siteBase, posterUrl), thumbnail_url: absUrl(siteBase, posterUrl),
        url: absUrl(siteBase, href), media_type: 'series',
        badge_text: '', badge_sub: '', year: '', rating: '',
        synopsis: '', age_rating: '', episode_current: '', genres: []
      });
    });
    logRail('hoan_thanh parsed=' + items.length);
    return items;
  }

  // -------- Rail builders --------
  function makeTrendingRail(movies) {
    return { id: 'phim_hot', title: 'Phim Hot', subtitle: null,
      card_height_percent: 0.22, card_size_ratio: 0.667, is_hero_source: true,
      show_rank: false, movies: movies, show_cta: null };
  }
  function makeNewUpdatesRail(movies) {
    return { id: 'new_series', title: 'Mới Cập Nhật', subtitle: null,
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

    // Fetch homepage + 2 category pages in parallel
    // Paths confirmed for anime-2 site structure
    var pagePromises = [
      fetchDoc(siteBase, '/'),                  // homepage
      fetchDoc(siteBase, '/most-viewed'),       // top 10
      fetchDoc(siteBase, '/hoan-thanh')         // completed
    ];
    var results = await Promise.all(pagePromises);
    var homeDoc = results[0];
    var top10Doc = results[1];
    var hoanThanhDoc = results[2];
    logRail('all 5 pages fetched');

    // Parse 4 rails
    var trending = parseTrending(homeDoc, siteBase);
    var newUpdates = parseNewUpdates(homeDoc, siteBase);
    var top10 = parseTop10(top10Doc, siteBase);
    var hoanThanh = parseHoanThanh(hoanThanhDoc, siteBase);

    // Build rails in order, skip empty gracefully
    var rails = [];
    if (trending.length) rails.push(makeTrendingRail(trending));
    if (newUpdates.length) rails.push(makeNewUpdatesRail(newUpdates));
    if (top10.length) rails.push(makeTop10Rail(top10));
    if (hoanThanh.length) rails.push(makeHoanThanhRail(hoanThanh));

    logRail('success rails=' + rails.length);
    return JSON.stringify(rails);
  } catch (e) {
    logRail('error ' + (e && e.message ? e.message : String(e)));
    return JSON.stringify({ error: e && e.message ? e.message : String(e) });
  }
}