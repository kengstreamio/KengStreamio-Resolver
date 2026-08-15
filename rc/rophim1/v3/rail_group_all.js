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

// ── Provider: rophim1 ──────────────────────────────────────

// RoPhim1 | Rail Group All — v3
// Contract: railGroupAll(baseUrl) -> JSON array of rails with embedded CTA methods.
//
// RoPhim1 exposes a different homepageLists catalog from RoPhim9/10, so the
// collection slug -> rail/CTA mapping is provider-specific.

async function railGroupAll(baseUrl) {
  const SITE_BASE = baseUrl;
  const BASE_API = baseUrl + '/baseapi/api/v1';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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

  function isTrailer(apiMovie) {
    const status = (apiMovie.status || '').toLowerCase();
    const epCurrent = (apiMovie.episode_current || '').toLowerCase();
    const name = (apiMovie.name || '').toLowerCase();
    const slug = (apiMovie.slug || '').toLowerCase();
    return status === 'trailer' || epCurrent === 'trailer' || name.includes('trailer') || slug.includes('.trailer');
  }

  function transformApiMovie(apiMovie) {
    const badgeText = apiMovie.episode_current || apiMovie.quality || '';
    return {
      rank: 0,
      title: apiMovie.name || '',
      title_original: apiMovie.origin_name || '',
      poster_url: apiMovie.poster || apiMovie.thumbnail || '',
      thumbnail_url: apiMovie.thumbnail || '',
      url: apiMovie.slug ? `${SITE_BASE}/phim/${apiMovie.slug}` : '',
      media_type: apiMovie.type === 'series' ? 'series' : 'movie',
      badge_text: badgeText,
      badge_sub: '',
      year: String(apiMovie.publish_year || ''),
      rating: String(apiMovie.imdb_rating || ''),
      synopsis: '',
      age_rating: '',
      episode_current: apiMovie.episode_current || '',
      genres: []
    };
  }

  const railMap = {
    'phim-han-quoc-moi': { id: 'korean', limit: 12 },
    'phim-trung-quoc-moi': { id: 'chinese', limit: 12 },
    'phim-us-uk-moi': { id: 'usuk', limit: 12 },
    'phim-hoat-hinh-anime': { id: 'anime', limit: 12 },
    'phim-chieu-rap-moi': { id: 'cinema', limit: 16 },
    'phim-bo-moi-nhat': { id: 'latest_series', limit: 16 },
    'top-phim-le-hom-nay': { id: 'top_movie_today', limit: 10, show_rank: true },
    'top-phim-bo-hom-nay': { id: 'top_series_today', limit: 10, show_rank: true },
    'phim-hay-nhat': { id: 'featured', limit: 12 },
    'tv-shows-chuong-trinh-truyen-hinh': { id: 'tv_shows', limit: 12 },
    'phim-ngan-short': { id: 'short_movies', limit: 12 },
    'phim-kinh-di': { id: 'horror', limit: 12 },
    'hoat-hinh-tre-em': { id: 'kids', limit: 12 },
    'ro-phim-sap-chieu': { id: 'upcoming', limit: 10 }
  };

  const ctaConfig = {
    korean: { js_method: 'getAllKorean' },
    chinese: { js_method: 'getAllChinese' },
    usuk: { js_method: 'getAllUsuk' },
    anime: { js_method: 'getAllAnime' },
    cinema: { js_method: 'getAllCinema' },
    latest_series: { js_method: 'getAllLatestSeries' },
    featured: { js_method: 'getAllFeatured' },
    tv_shows: { js_method: 'getAllTvShows' },
    short_movies: { js_method: 'getAllShortMovies' },
    horror: { js_method: 'getAllHorror' },
    kids: { js_method: 'getAllKids' },
  };

  try {
    console.log('[KENG][RoPhim1] railGroupAll()');
    const response = await fetch(`${BASE_API}/lists/homepageLists?page=1&limit=20`, buildFetchOptions(SITE_BASE + '/'));
    if (!response.ok) {
      throw new Error('Homepage Lists API returned ' + response.status);
    }

    const apiData = await response.json();
    const collections = apiData && apiData.result && Array.isArray(apiData.result.collections)
      ? apiData.result.collections
      : [];

    const rails = [];
    for (const collection of collections) {
      const config = railMap[collection.slug || ''];
      if (!config || !Array.isArray(collection.movies)) {
        continue;
      }

      const movies = collection.movies
        .map((item) => item && item.movie ? item.movie : item)
        .filter((movie) => movie && !isTrailer(movie))
        .slice(0, config.limit)
        .map((movie, index) => {
          const result = transformApiMovie(movie);
          if (config.show_rank) {
            result.rank = index + 1;
          }
          return result;
        });

      if (movies.length === 0) {
        continue;
      }

      rails.push({
        id: config.id,
        title: collection.name || config.id,
        subtitle: null,
        card_height_percent: 0.18,
        card_size_ratio: 1.5,
        is_hero_source: false,
        show_rank: !!config.show_rank,
        movies,
        show_cta: ctaConfig[config.id] || null,
      });
    }

    if (rails.length === 0) {
      return JSON.stringify({ error: 'No rails found from homepageLists' });
    }

    console.log(`[KENG][RoPhim1] railGroupAll: ${rails.length} rails`);
    return JSON.stringify(rails);
  } catch (e) {
    console.error('[KENG][RoPhim1] railGroupAll ERROR: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

async function _fetchCtaMovies(baseUrl, url, label) {
  const SITE_BASE = baseUrl;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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

  function isTrailer(apiMovie) {
    const status = (apiMovie.status || '').toLowerCase();
    const epCurrent = (apiMovie.episode_current || '').toLowerCase();
    const name = (apiMovie.name || '').toLowerCase();
    const slug = (apiMovie.slug || '').toLowerCase();
    return status === 'trailer' || epCurrent === 'trailer' || name.includes('trailer') || slug.includes('.trailer');
  }

  function transformCtaMovie(apiMovie) {
    const badgeText = apiMovie.episode_current || apiMovie.quality || '';
    return {
      rank: 0,
      title: apiMovie.name || '',
      title_original: apiMovie.origin_name || '',
      poster_url: apiMovie.thumbnail || apiMovie.poster || '',
      thumbnail_url: apiMovie.thumbnail || '',
      url: apiMovie.slug ? SITE_BASE + '/phim/' + apiMovie.slug : '',
      media_type: apiMovie.type === 'series' ? 'series' : 'movie',
      badge_text: badgeText,
      badge_sub: '',
      year: String(apiMovie.publish_year || ''),
      rating: String(apiMovie.imdb_rating || ''),
      synopsis: '',
      age_rating: '',
      episode_current: apiMovie.episode_current || '',
      genres: []
    };
  }

  try {
    const r = await fetch(url, buildFetchOptions(SITE_BASE + '/'));
    if (!r.ok) {
      console.warn('[KENG][RoPhim1] ' + label + ' HTTP ' + r.status);
      return JSON.stringify([]);
    }
    const data = await r.json();
    const items = data.result || data.data || [];
    if (!Array.isArray(items) || items.length === 0) {
      return JSON.stringify([]);
    }
    const movies = items
      .map((item) => item && item.movie ? item.movie : item)
      .filter((item) => item && !isTrailer(item))
      .map(transformCtaMovie)
      .filter((item) => item.title && item.url);
    console.log('[KENG][RoPhim1] ' + label + ' page movies: ' + movies.length);
    return JSON.stringify(movies);
  } catch (e) {
    console.error('[KENG][RoPhim1] ' + label + ' error: ' + e.message);
    return JSON.stringify([]);
  }
}

async function _fetchCtaFromList(baseUrl, slug, page, label) {
  const SITE_BASE = baseUrl;
  const BASE_API = baseUrl + '/baseapi/api/v1';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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

  function isTrailer(apiMovie) {
    const status = (apiMovie.status || '').toLowerCase();
    const epCurrent = (apiMovie.episode_current || '').toLowerCase();
    const name = (apiMovie.name || '').toLowerCase();
    const slugText = (apiMovie.slug || '').toLowerCase();
    return status === 'trailer' || epCurrent === 'trailer' || name.includes('trailer') || slugText.includes('.trailer');
  }

  function transformCtaMovie(apiMovie) {
    const badgeText = apiMovie.episode_current || apiMovie.quality || '';
    return {
      rank: 0,
      title: apiMovie.name || '',
      title_original: apiMovie.origin_name || '',
      poster_url: apiMovie.thumbnail || apiMovie.poster || '',
      thumbnail_url: apiMovie.thumbnail || '',
      url: apiMovie.slug ? SITE_BASE + '/phim/' + apiMovie.slug : '',
      media_type: apiMovie.type === 'series' ? 'series' : 'movie',
      badge_text: badgeText,
      badge_sub: '',
      year: String(apiMovie.publish_year || ''),
      rating: String(apiMovie.imdb_rating || ''),
      synopsis: '',
      age_rating: '',
      episode_current: apiMovie.episode_current || '',
      genres: []
    };
  }

  try {
    const r = await fetch(`${BASE_API}/lists/homepageLists?page=1&limit=20`, buildFetchOptions(SITE_BASE + '/'));
    if (!r.ok) {
      return JSON.stringify([]);
    }

    const data = await r.json();
    const collections = data && data.result && Array.isArray(data.result.collections)
      ? data.result.collections
      : [];
    const targetCollection = collections.find((item) => item.slug === slug);
    if (!targetCollection || !Array.isArray(targetCollection.movies)) {
      return JSON.stringify([]);
    }

    const pageSize = 12;
    const p = page || 1;
    const pageMovies = targetCollection.movies.slice((p - 1) * pageSize, p * pageSize);
    const movies = pageMovies
      .map((item) => item && item.movie ? item.movie : item)
      .filter((item) => item && !isTrailer(item))
      .map(transformCtaMovie)
      .filter((item) => item.title && item.url);
    console.log('[KENG][RoPhim1] ' + label + ' page ' + p + ': ' + movies.length + ' movies');
    return JSON.stringify(movies);
  } catch (e) {
    console.error('[KENG][RoPhim1] ' + label + ' error: ' + e.message);
    return JSON.stringify([]);
  }
}

async function getAllKorean(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-region/han-quoc?page=${p}`, 'getAllKorean p=' + p);
}

async function getAllChinese(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-region/trung-quoc?page=${p}`, 'getAllChinese p=' + p);
}

async function getAllUsuk(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-region/au-my?page=${p}`, 'getAllUsuk p=' + p);
}

async function getAllAnime(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-category/hoat-hinh?page=${p}`, 'getAllAnime p=' + p);
}

async function getAllCinema(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-type/movie?page=${p}`, 'getAllCinema p=' + p);
}

async function getAllLatestSeries(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-type/series?page=${p}`, 'getAllLatestSeries p=' + p);
}

async function getAllFeatured(baseUrl, page) {
  return _fetchCtaFromList(baseUrl, 'phim-hay-nhat', page, 'getAllFeatured');
}

async function getAllTvShows(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-category/tv-shows?page=${p}`, 'getAllTvShows p=' + p);
}

async function getAllShortMovies(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-category/short-drama?page=${p}`, 'getAllShortMovies p=' + p);
}

async function getAllHorror(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-category/kinh-di?page=${p}`, 'getAllHorror p=' + p);
}

async function getAllKids(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, `${baseUrl}/baseapi/api/v1/movies/by-category/tre-em?page=${p}`, 'getAllKids p=' + p);
}
