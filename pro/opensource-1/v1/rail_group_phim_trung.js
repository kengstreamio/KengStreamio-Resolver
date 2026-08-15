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
//   - /vN/ prefix with segment_XXX.ts (numbered SSAI ad segments, any version)
//
// NOTE: every clause must evaluate to a boolean. Never compare a .test() result
// against -1 — `-1 !== false` is true, which classifies every segment as an ad
// and makes the whole movie look like one giant ad break.
//
// `convertvN/` was removed 2026-08-15: it is a FALSE POSITIVE. On
// s5.phim1280.tv those segments carry the same random 8-char names as the
// content around them, sit in a playlist with zero /adjump/ segments, and were
// confirmed on-device to be ordinary film — they are re-transcoded segments,
// and the #EXT-X-DISCONTINUITY around them marks an encoder change, not an ad
// break. Flagging them cut ~25s of real movie out of a single title.
//
// Bias: a false positive removes film the user paid attention to; a false
// negative merely shows an ad. Prefer missing an ad over cutting content.
function _isAdSegment(segment) {
  return segment.indexOf('/adjump/') !== -1
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

// ── Provider: opensource-1 ──────────────────────────────────────

async function railGroupPhimTrung(baseUrl) {
  function resolveBaseUrl(baseUrl) {
    return (typeof baseUrl === 'string' && /^https?:\/\//i.test(baseUrl))
      ? baseUrl
      : ((typeof location !== 'undefined' && location.origin) ? location.origin : '');
  }

  function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function absUrl(baseUrl, url) {
    const text = cleanText(url);
    if (!text) return '';
    try { return new URL(text, baseUrl).href; } catch (_e) { return text; }
  }

  function imgUrl(url) {
    const text = cleanText(url);
    if (!text) return '';
    try { return new URL(text, 'https://phimimg.com').href; } catch (_e) { return text; }
  }

  function inferMediaType(item, fallbackType) {
    const type = cleanText(item && item.type || '').toLowerCase();
    const episodeCurrent = cleanText(item && item.episode_current || '').toLowerCase();
    if (fallbackType) return fallbackType;
    if (type === 'single' || type === 'movie' || episodeCurrent === 'full') return 'movie';
    return 'series';
  }

  function parseGenres(item) {
    if (!item || !Array.isArray(item.category)) return [];
    return item.category.map((genre) => cleanText(genre && genre.name ? genre.name : '')).filter(Boolean);
  }

  function isTrailer(item) {
    const haystack = [item && item.episode_current, item && item.name, item && item.origin_name].map(cleanText).join(' ').toLowerCase();
    return haystack.includes('trailer');
  }

  function normalizeMovieItem(baseUrl, item, fallbackType) {
    const poster = cleanText(item.poster_url || item.thumb_url || '');
    const thumb = cleanText(item.thumb_url || item.poster_url || '');
    const episodeCurrent = cleanText(item.episode_current || '');
    const quality = cleanText(item.quality || '');
    const lang = cleanText(item.lang || '');
    const title = cleanText(item.name || '');
    const slug = cleanText(item.slug || '');
    return {
      rank: 0,
      title,
      title_original: cleanText(item.origin_name || ''),
      poster_url: imgUrl(poster),
      thumbnail_url: imgUrl(poster),
      url: slug ? absUrl(baseUrl, '/phim/' + encodeURIComponent(slug)) : '',
      media_type: inferMediaType(item, fallbackType),
      badge_text: episodeCurrent || quality,
      badge_sub: lang,
      year: cleanText(item.year || ''),
      rating: item.tmdb && item.tmdb.vote_average ? String(item.tmdb.vote_average) : '',
      synopsis: cleanText(item.description || ''),
      age_rating: '',
      episode_current: episodeCurrent,
      genres: parseGenres(item)
    };
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('Fetch failed: ' + res.status);
    return await res.json();
  }

  async function fetchItems(baseUrl, apiPath, page = 1, fallbackType) {
    const siteBase = resolveBaseUrl(baseUrl);
    const url = new URL(apiPath, siteBase);
    url.searchParams.set('page', String(Number.parseInt(page || '1', 10) || 1));
    url.searchParams.set('limit', '10');
    logRail('fetchItems page=' + url.searchParams.get('page') + ' url=' + url.href);
    const json = await fetchJson(url.href);
    const items = Array.isArray(json && json.data && json.data.items) ? json.data.items : [];
    logRail('fetchItems received items=' + items.length);
    return items
      .filter((item) => item && !isTrailer(item))
      .map((item) => normalizeMovieItem(siteBase, item, fallbackType))
      .filter((movie) => movie.title && movie.url);
  }
  function logRail(message) {
    console.log('[KENG][opensource-1][railGroupPhimTrung] ' + message);
  }

  function makeRail(movies) {
    return {
      id: 'phim_trung',
      title: 'Phim Trung',
      subtitle: null,
      card_height_percent: 0.18,
      card_size_ratio: 0.667,
      is_hero_source: false,
      show_rank: false,
      movies: movies,
      show_cta: { js_method: 'getAllPhimTrung' }
    };
  }

  try {
    logRail('start');
    const movies = await fetchItems(baseUrl, '/v1/api/quoc-gia/trung-quoc', 1);
    logRail('success movies=' + movies.length);
    return JSON.stringify([makeRail(movies)]);
  } catch (e) {
    logRail('error ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

async function getAllPhimTrung(baseUrl, page = 1) {
  function resolveBaseUrl(baseUrl) {
    return (typeof baseUrl === 'string' && /^https?:\/\//i.test(baseUrl))
      ? baseUrl
      : ((typeof location !== 'undefined' && location.origin) ? location.origin : '');
  }

  function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function absUrl(baseUrl, url) {
    const text = cleanText(url);
    if (!text) return '';
    try { return new URL(text, baseUrl).href; } catch (_e) { return text; }
  }

  function imgUrl(url) {
    const text = cleanText(url);
    if (!text) return '';
    try { return new URL(text, 'https://phimimg.com').href; } catch (_e) { return text; }
  }

  function inferMediaType(item, fallbackType) {
    const type = cleanText(item && item.type || '').toLowerCase();
    const episodeCurrent = cleanText(item && item.episode_current || '').toLowerCase();
    if (fallbackType) return fallbackType;
    if (type === 'single' || type === 'movie' || episodeCurrent === 'full') return 'movie';
    return 'series';
  }

  function parseGenres(item) {
    if (!item || !Array.isArray(item.category)) return [];
    return item.category.map((genre) => cleanText(genre && genre.name ? genre.name : '')).filter(Boolean);
  }

  function isTrailer(item) {
    const haystack = [item && item.episode_current, item && item.name, item && item.origin_name].map(cleanText).join(' ').toLowerCase();
    return haystack.includes('trailer');
  }

  function normalizeMovieItem(baseUrl, item, fallbackType) {
    const poster = cleanText(item.poster_url || item.thumb_url || '');
    const thumb = cleanText(item.thumb_url || item.poster_url || '');
    const episodeCurrent = cleanText(item.episode_current || '');
    const quality = cleanText(item.quality || '');
    const lang = cleanText(item.lang || '');
    const title = cleanText(item.name || '');
    const slug = cleanText(item.slug || '');
    return {
      rank: 0,
      title,
      title_original: cleanText(item.origin_name || ''),
      poster_url: imgUrl(poster),
      thumbnail_url: imgUrl(poster),
      url: slug ? absUrl(baseUrl, '/phim/' + encodeURIComponent(slug)) : '',
      media_type: inferMediaType(item, fallbackType),
      badge_text: episodeCurrent || quality,
      badge_sub: lang,
      year: cleanText(item.year || ''),
      rating: item.tmdb && item.tmdb.vote_average ? String(item.tmdb.vote_average) : '',
      synopsis: cleanText(item.description || ''),
      age_rating: '',
      episode_current: episodeCurrent,
      genres: parseGenres(item)
    };
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('Fetch failed: ' + res.status);
    return await res.json();
  }

  async function fetchItems(baseUrl, apiPath, page = 1, fallbackType) {
    const siteBase = resolveBaseUrl(baseUrl);
    const url = new URL(apiPath, siteBase);
    url.searchParams.set('page', String(Number.parseInt(page || '1', 10) || 1));
    url.searchParams.set('limit', '20');
    logRail('fetchItems page=' + url.searchParams.get('page') + ' url=' + url.href);
    const json = await fetchJson(url.href);
    const items = Array.isArray(json && json.data && json.data.items) ? json.data.items : [];
    logRail('fetchItems received items=' + items.length);
    return items
      .filter((item) => item && !isTrailer(item))
      .map((item) => normalizeMovieItem(siteBase, item, fallbackType))
      .filter((movie) => movie.title && movie.url);
  }
  function logRail(message) {
    console.log('[KENG][opensource-1][railGroupPhimTrung] ' + message);
  }

  function makeRail(movies) {
    return {
      id: 'phim_trung',
      title: 'Phim Trung',
      subtitle: null,
      card_height_percent: 0.18,
      card_size_ratio: 0.667,
      is_hero_source: false,
      show_rank: false,
      movies: movies,
      show_cta: { js_method: 'getAllPhimTrung' }
    };
  }

  try {
    logRail('cta start page=' + page);
    const movies = await fetchItems(baseUrl, '/v1/api/quoc-gia/trung-quoc', page);
    logRail('cta success movies=' + movies.length);
    return JSON.stringify(movies);
  } catch (e) {
    logRail('cta error ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}
