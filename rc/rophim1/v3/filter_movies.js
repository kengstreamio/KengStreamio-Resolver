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

// ── Provider: rophim1 ──────────────────────────────────────

// RoPhim1 | Filter Phim Lẻ — v3
// Contract: filterMovies(sortIdx, sortVal, countryId, countryIdx, countryVal, yearId, yearIdx, yearVal, genreId, genreIdx, genreVal, page = 1) -> JSON array
//
// The active site now exposes JSON search data via:
// GET /baseapi/api/v1/movies/search?page=...&limit=32&type=movie&sort=...&countries=...&genres=...&years=...

async function filterMovies(baseUrl,
    sortIdx,   sortVal,
    countryId, countryIdx, countryVal,
    yearId,    yearIdx,    yearVal,
    genreId,   genreIdx,   genreVal,
    page
) {
    page = page || 1;
    const SITE_BASE = baseUrl;
    const BASE_API = `${SITE_BASE}/baseapi/api/v1`;
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    const thumbnailOrientationCache = new Map();

    const SORT_VALUES = ['updatedAt', 'imdb_rating', 'view_total'];
    const COUNTRY_IDS = [
      '24', '25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35',
      '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47',
      '48', '49', '50', '51', '52', '53', '54', '55', '56', '57', '58', '59',
      '60', '61', '62', '63', '64', '65', '66', '67', '68', '69', '70', '71',
      '72', '73', '74', '75', '76', '77', '78', '79', '80', '81', '82', '83',
      '84', '85', '86', '87', '88', '89', '90', '91', '92', '93', '94', '95',
      '96', '97', '98', '99', '100', '101', '102', '103', '104', '105', '106',
      '107', '108', '109', '110', '111', '112', '113', '114', '115'
    ];
    const GENRE_IDS = [
      '60', '61', '62', '63', '64', '65', '66', '67', '68', '69', '70', '71',
      '72', '73', '74', '75', '76', '77', '78', '79', '80', '81', '82', '83',
      '84', '85', '86', '87', '88', '89', '90', '91', '92', '93', '94', '95',
      '96', '97', '98', '99', '100', '101', '102', '103', '104', '105', '106',
      '107', '108', '109', '110', '111', '112', '113', '114', '115', '116',
      '117', '118', '119', '120', '121'
    ];

    function buildFetchOptions(refererUrl) {
        return {
            headers: {
                'User-Agent': UA,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Referer': refererUrl || SITE_BASE + '/',
                'Origin': SITE_BASE,
            },
        };
    }

    function normalizeText(value) {
        return String(value || '').trim().toLowerCase();
    }

    function isTrailer(apiMovie) {
        const status = normalizeText(apiMovie.status);
        const episodeCurrent = normalizeText(apiMovie.episode_current);
        const name = normalizeText(apiMovie.name);
        const slug = normalizeText(apiMovie.slug);
        return status === 'trailer' || episodeCurrent === 'trailer' || name.includes('trailer') || slug.includes('.trailer');
    }

    function normalizePoster(url) {
        if (!url) return '';
        if (url.startsWith('//')) return 'https:' + url;
        return url;
    }

    async function isPortraitImage(url) {
        if (!url) return false;
        if (thumbnailOrientationCache.has(url)) {
            return thumbnailOrientationCache.get(url);
        }

        const probe = new Promise((resolve) => {
            if (typeof Image === 'undefined' || typeof document === 'undefined') {
                resolve(false);
                return;
            }

            const img = new Image();
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            const timeoutId = setTimeout(() => finish(false), 8000);

            img.onload = () => {
                clearTimeout(timeoutId);
                finish((img.naturalHeight || 0) > (img.naturalWidth || 0));
            };

            img.onerror = () => {
                clearTimeout(timeoutId);
                finish(false);
            };

            img.src = url;
        });

        thumbnailOrientationCache.set(url, probe);
        return probe;
    }

    async function resolvePortraitThumbnail(apiMovie) {
        const thumbnailUrl = normalizePoster(apiMovie.thumbnail || '');
        if (!thumbnailUrl) return '';

        try {
            const isPortrait = await isPortraitImage(thumbnailUrl);
            if (isPortrait) {
                return thumbnailUrl;
            }
            console.log('[KENG][RoPhim1] filterMovies skipped landscape thumbnail: ' + thumbnailUrl);
        } catch (e) {
            console.log('[KENG][RoPhim1] filterMovies thumbnail probe failed: ' + e.message);
        }

        return '';
    }

    async function transformMovie(apiMovie, rank) {
        const badgeText = apiMovie.episode_current || apiMovie.quality || '';
        const genres = Array.isArray(apiMovie.categories)
            ? apiMovie.categories.map((item) => item && item.name ? item.name : '').filter(Boolean)
            : [];
        const thumbnailUrl = await resolvePortraitThumbnail(apiMovie);

        return {
            rank,
            title: apiMovie.name || '',
            title_original: apiMovie.origin_name || '',
            poster_url: normalizePoster(apiMovie.poster || apiMovie.thumbnail || ''),
            thumbnail_url: thumbnailUrl,
            url: apiMovie.slug ? `${SITE_BASE}/phim/${apiMovie.slug}` : '',
            actors: [],
            media_type: apiMovie.type === 'series' ? 'series' : 'movie',
            badge_text: badgeText,
            badge_sub: apiMovie.quality || '',
            year: String(apiMovie.publish_year || ''),
            rating: String(apiMovie.imdb_rating || ''),
            synopsis: '',
            age_rating: '',
            episode_current: apiMovie.episode_current || '',
            genres
        };
    }

    async function fetchJson(url) {
        const res = await fetch(url, buildFetchOptions(SITE_BASE + '/'));
        if (!res.ok) throw new Error('Fetch failed ' + res.status + ': ' + url);
        return res.json();
    }

    async function resolveCountryId() {
        if (normalizeText(countryVal)) {
            try {
                const payload = await fetchJson(`${BASE_API}/regions?limit=100`);
                const regions = Array.isArray(payload.data) ? payload.data : [];
                const match = regions.find((item) => normalizeText(item.name) === normalizeText(countryVal));
                if (match) return String(match.id);
            } catch (e) {
                console.log('[KENG][RoPhim1] filterMovies country lookup fallback: ' + e.message);
            }
        }

        if (countryIdx !== '-1') {
            const idx = parseInt(countryIdx, 10);
            return idx >= 0 && idx < COUNTRY_IDS.length ? COUNTRY_IDS[idx] : '';
        }

        return '';
    }

    async function resolveGenreId() {
        if (normalizeText(genreVal)) {
            try {
                const payload = await fetchJson(`${BASE_API}/categories?limit=100`);
                const categories = Array.isArray(payload.data) ? payload.data : [];
                const match = categories.find((item) => normalizeText(item.name) === normalizeText(genreVal));
                if (match) return String(match.id);
            } catch (e) {
                console.log('[KENG][RoPhim1] filterMovies genre lookup fallback: ' + e.message);
            }
        }

        if (genreIdx !== '-1') {
            const idx = parseInt(genreIdx, 10);
            return idx >= 0 && idx < GENRE_IDS.length ? GENRE_IDS[idx] : '';
        }

        return '';
    }

    function resolveSortValue() {
        const label = normalizeText(sortVal);
        if (label.includes('imdb')) return 'imdb_rating';
        if (label.includes('lượt xem') || label.includes('luot xem') || label.includes('view')) return 'view_total';
        if (label.includes('mới') || label.includes('updated')) return 'updatedAt';

        if (sortIdx !== '-1') {
            const idx = parseInt(sortIdx, 10);
            return idx >= 0 && idx < SORT_VALUES.length ? SORT_VALUES[idx] : 'updatedAt';
        }

        return 'updatedAt';
    }

    try {
        const currentPage = Math.max(1, parseInt(page, 10) || 1);
        console.log('[KENG][RoPhim1] filterMovies: page ' + currentPage);

        const [countryApiId, genreApiId] = await Promise.all([
            resolveCountryId(),
            resolveGenreId()
        ]);

        const params = [
            'page=' + currentPage,
            'limit=32',
            'type=movie',
            'sort=' + resolveSortValue(),
        ];

        if (countryApiId) params.push('countries=' + countryApiId);
        if (genreApiId) params.push('genres=' + genreApiId);
        if (yearIdx !== '-1' && String(yearVal || '').trim()) {
            params.push('years=' + encodeURIComponent(String(yearVal).trim()));
        }

        const url = `${BASE_API}/movies/search?${params.join('&')}`;
        const payload = await fetchJson(url);
        const items = Array.isArray(payload.result) ? payload.result : Array.isArray(payload.data) ? payload.data : [];
        const movies = await Promise.all(items
            .filter((item) => item && !isTrailer(item))
            .slice(0, 32)
            .map((item, index) => transformMovie(item, (currentPage - 1) * 32 + index + 1)));

        console.log('[KENG][RoPhim1] filterMovies SUCCESS: ' + movies.length + ' items (page ' + currentPage + ')');
        return JSON.stringify(movies);
    } catch (e) {
        console.log('[KENG][RoPhim1] filterMovies error: ' + e.message);
        return JSON.stringify([]);
    }
}
