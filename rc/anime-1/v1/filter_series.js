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

// Provider: anime-1
// Standalone: Filter Series
// Function: filterSeries(baseUrl, sortIdx, sortVal, [filterGroup]* , page) -> JSON string
// Filter groups come as triples: [id, idx, val] dynamically from app config.
// For anime-1: 1 sort group + 1 filter group (genre).
// HalimMovies WordPress: uses genre category pages (/huyen-huyen/page/{N}, etc.)
// genreIdx maps to WordPress category slugs defined in GENRE_SLUGS.
// v6.1 contract: dynamic params.

async function filterSeries(...allArgs) {
  // Extract baseUrl, sortIdx, sortVal
  const baseUrl = allArgs[0];
  const sortIdx = allArgs[1];
  const sortVal = allArgs[2];
  const base = (baseUrl || '').replace(/\/+$/, '');

  // Remaining: filter groups triples [id, idx, val, id, idx, val...], last is page
  const rest = allArgs.slice(3);
  const page = Math.max(1, parseInt(rest.pop() || 1, 10));

  // Find genre filter group
  let genreIdx = '-1';
  for (let i = 0; i < rest.length; i += 3) {
    if (rest[i] === 'genre') {
      genreIdx = rest[i + 1];
      break;
    }
  }

  // WordPress category slugs for series genres (from homepage nav)
  const GENRE_SLUGS = [
    'huyen-huyen',    // 0: Huyền Huyễn
    'xuyen-khong',    // 1: Xuyên Không
    'trung-sinh',     // 2: Trùng Sinh
    'tien-hiep',      // 3: Tiên Hiệp
    'co-trang',       // 4: Cổ Trang
    'hai-huoc',       // 5: Hài Hước
    'kiem-hiep',      // 6: Kiếm Hiệp
    'hien-dai',       // 7: Hiện Đại
  ];

  // Determine genre slug from genreIdx
  let slug = '';
  if (genreIdx !== '-1' && genreIdx !== undefined && genreIdx !== null) {
    const idx = parseInt(genreIdx, 10);
    if (idx >= 0 && idx < GENRE_SLUGS.length) {
      slug = GENRE_SLUGS[idx];
    }
  }
  // Fallback: use phim-hoan-thanh (completed, all types) if no genre
  if (!slug) slug = 'phim-hoan-thanh';

  const url = page <= 1
    ? `${base}/${slug}`
    : `${base}/${slug}/page/${page}`;

  try {
    const html = await fetchText(url);
    const movies = parseGenericList(html, base, 32);
    const result = movies.map((m, i) => ({
      rank: (page - 1) * 32 + i + 1,
      title: m.title || '',
      title_original: m.title_original || '',
      poster_url: m.poster_url || '',
      thumbnail_url: m.thumbnail_url || '',
      url: m.url || '',
      media_type: 'series',
      badge_text: m.badge_text || '',
      badge_sub: m.badge_sub || '',
      year: m.year || '',
      rating: m.rating || '',
      synopsis: m.synopsis || '',
      age_rating: m.age_rating || '',
      episode_current: m.episode_current || '',
      genres: m.genres || []
    }));
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify([]);
  }
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
