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

// ── Provider: rophim12 ──────────────────────────────────────

// Story 10-13 | RoPhim12 | Rail Group All — v3 (API-based)
// Contract: railGroupAll() -> JSON { rails: [...] }
// Performance: 1 JS call → 9 rails (v5: 9 JS calls)

/**
 * Main rail group resolver
 * Fetches all home screen rails via APIs
 * v6 contract: returns array of rail objects with embedded movies
 * 
 * Fallback strategy:
 * - Try API endpoints first
 * - Fall back to HTML parsing if APIs unavailable  
 * - Skip unavailable rails gracefully
 */
async function railGroupAll(baseUrl) {
  // ===== CONSTANTS (Must be inside function to avoid WebView scope conflicts) =====
  const SITE_BASE = baseUrl;
  const BASE_API = baseUrl + '/baseapi/api/v1';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  console.log('[KENG][RoPhim12] railGroupAll() v6 — API-based');

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

  /**
   * Transform API movie to movie-data-contract format
   * Strict mapping per docs/json-schema-contract/movie-data-contract.md
   * @param {object} apiMovie - API response movie object
   * @returns {object} Contract-compliant movie object
   */
  /**
   * Check if movie is a trailer-only/upcoming item (should be excluded)
   * Trailers have status='trailer' or episode_current='Trailer' 
   */
  function isTrailer(apiMovie) {
    const status = (apiMovie.status || '').toLowerCase();
    const epCurrent = (apiMovie.episode_current || '').toLowerCase();
    const name = (apiMovie.name || '').toLowerCase();
    const slug = (apiMovie.slug || '').toLowerCase();
    
    return status === 'trailer' || 
           epCurrent === 'trailer' || 
           name.includes('trailer') || 
           slug.includes('.trailer');
  }

  function transformApiMovie(apiMovie) {
    const badgeText = apiMovie.episode_current || apiMovie.quality || '';
    return {
      rank: 0,  // No rank in grouped view
      title: apiMovie.name || '',
      title_original: apiMovie.origin_name || '',  // Fixed: was original_title
      poster_url: apiMovie.poster || apiMovie.thumbnail || '',  // Prefer poster (landscape) for home rails
      thumbnail_url: apiMovie.thumbnail || '',  // Portrait for history/favorites
      url: apiMovie.slug ? `${SITE_BASE}/phim/${apiMovie.slug}` : '',
      media_type: apiMovie.type === 'series' ? 'series' : 'movie',  // Fixed: was movie_type
      badge_text: badgeText,  // Added: required field
      badge_sub: '',   // Added: required field
      year: String(apiMovie.publish_year || ''),  // Fixed: convert to string
      rating: String(apiMovie.imdb_rating || ''),  // Fixed: was imdb_rating, convert to string
      synopsis: '',  // Added: required field
      age_rating: '',  // Added: required field
      episode_current: apiMovie.episode_current || '',
      genres: []  // Added: required field
    };
  }

  const rails = [];
  const errors = [];
  
  try {
    // ===== OPTION: API-Based Rails (Homepage Lists API) =====
    // Fetch structured rail data directly from API
    // No longer relying on HTML parsing as app doesn't pass HTML
    try {
        console.log('[KENG][RoPhim12] Fetching rails from Homepage Lists API...');
        const apiUrl = BASE_API + '/lists/homepageLists?page=1&limit=10';
        const apiData = await fetch(apiUrl, buildFetchOptions(SITE_BASE + '/')).then((r) => {
          if (!r.ok) throw new Error('Homepage Lists API returned ' + r.status);
          return r.json();
        });
          
          // API structure: { status, result: { collections: [{ slug, name, movies: [...] }] } }
          if (apiData && apiData.result && apiData.result.collections && Array.isArray(apiData.result.collections)) {
            const apiRails = [];
            const railMap = {
              'phim-sap-toi': { id: 'phim_hot', is_hero_source: true, limit: 20 },
              'phim-dien-anh-moi-coong': { id: 'cinema', limit: 16 },
              'top-10-phim-bo-hom-nay': { id: 'top10_series', show_rank: true, limit: 10 },
              'man-nhan-voi-phim-chieu-rap': { id: 'cinema_featured', limit: 12 },
              'phim-han-quoc-moi': { id: 'korean', limit: 12 },
              'phim-trung-quoc-moi': { id: 'chinese', limit: 12 },
              'au-my': { id: 'usuk', limit: 12 },
              'kho-tang-anime-moi-nhat': { id: 'anime', limit: 12 },
              'dien-anh-hong-kong-o-cho-nay-nay': { id: 'hongkong', limit: 12 }
            };
            
            // CTA config: rails that have show_cta enabled
            const ctaConfig = {
              'korean':           { js_method: 'getAllKorean' },
              'chinese':          { js_method: 'getAllChinese' },
              'usuk':             { js_method: 'getAllUsuk' },
              'cinema':           { js_method: 'getAllCinema' },
              'cinema_featured':  { js_method: 'getAllCinemaFeatured' },
              'phim_hot':         { js_method: 'getAllPhimHot' },
              'anime':            { js_method: 'getAllAnime' },
              'hongkong':         { js_method: 'getAllHongKong' },
            };

            for (const apiList of apiData.result.collections) {
              const slug = apiList.slug || '';
              const railConfig = railMap[slug];
              
              if (railConfig && apiList.movies && Array.isArray(apiList.movies)) {
                // Story 11-7: Filter out trailer/upcoming movies before transforming
                const filteredMovies = apiList.movies.filter(m => {
                  const movieData = m.movie ? m.movie : m;
                  return !isTrailer(movieData);
                });
                
                const movies = filteredMovies.slice(0, railConfig.limit).map((m, index) => {
                  const movieData = m.movie ? m.movie : m;
                  const movie = transformApiMovie(movieData);
                  // Story 11-6: If rail has show_rank, set rank from index
                  if (railConfig.show_rank) {
                    movie.rank = index + 1;
                  }
                  return movie;
                });
                
                if (movies.length > 0) {
                  const railId = railConfig.id;
                  const showCta = ctaConfig[railId] ? { js_method: ctaConfig[railId].js_method } : null;
                  apiRails.push({
                    id: railId,
                    title: apiList.name || railId,
                    subtitle: null,
                    card_height_percent: 0.18,
                    card_size_ratio: 1.5,
                    is_hero_source: railConfig.is_hero_source || false,
                    show_rank: railConfig.show_rank || false,
                    movies: movies,
                    show_cta: showCta
                  });
                  
                  console.log('[KENG][RoPhim12] API rail: ' + railId + ' (' + movies.length + ' movies) cta=' + (showCta ? showCta.js_method : 'null'));
                }
              }
            }
            
            if (apiRails.length > 0) {
              rails.push(...apiRails);
              console.log('[KENG][RoPhim12] Loaded ' + apiRails.length + ' rails from Homepage Lists API');
            }
          }
    } catch (e) {
        errors.push('Homepage Lists API error: ' + e.message);
    }
    
    // ===== RESPONSE =====
    if (rails.length === 0) {
      console.warn('[KENG][RoPhim12] No rails found');
      errors.forEach(e => console.warn('[KENG][RoPhim12] ' + e));

      // Error format per contract: { error: '...' } — NOT { rails: [], error: '...' }
      return JSON.stringify({
        error: 'Could not fetch any rails. Errors: ' + errors.join('; ')
      });
    }

    // Validate & return plain array per v6 Rail Group Contract
    const validRails = rails.map(rail => ({
      id: rail.id || 'unknown',
      title: rail.title || 'Untitled Rail',
      subtitle: rail.subtitle || null,
      card_height_percent: rail.card_height_percent || 0.18,
      card_size_ratio: rail.card_size_ratio || 0.667,
      is_hero_source: rail.is_hero_source || false,
      show_rank: rail.show_rank || false,
      movies: Array.isArray(rail.movies) ? rail.movies : [],
      show_cta: rail.show_cta || null
    }));

    console.log('[KENG][RoPhim12] Returning ' + validRails.length + ' rails');
    return JSON.stringify(validRails);  // Plain array, NOT { rails: [...] }
    
  } catch (e) {
    console.error('[KENG][RoPhim12] railGroupAll() FATAL: ' + e.message);
    return JSON.stringify({
      error: 'Fatal error: ' + e.message
    });
  }
}

// =============================================================================
// CTA Functions — "Xem tất cả" handlers
// API: GET /movies/by-region/{slug}?page={n}  (public, no auth)
// API: GET /movies/by-category/{slug}?page={n} (public, no auth)
// Contract: (page: number) → JSON.stringify(movies[]) | '[]' when exhausted
// =============================================================================

/**
 * Shared CTA helper — fetches a paginated movie list from a public API endpoint
 * @param {string} url - Full API URL with page param
 * @param {string} label - Log label
 */
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
    
    return status === 'trailer' || 
           epCurrent === 'trailer' || 
           name.includes('trailer') || 
           slug.includes('.trailer');
  }

  function transformCtaMovie(apiMovie) {
    const badgeText = apiMovie.episode_current || apiMovie.quality || '';
    return {
      rank: 0,
      title: apiMovie.name || '',
      title_original: apiMovie.origin_name || '',
      poster_url: apiMovie.thumbnail || apiMovie.poster || '',  // Prefer thumbnail (portrait) for CTA
      thumbnail_url: apiMovie.thumbnail || '',  // Portrait for history/favorites
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
      console.warn('[KENG][RoPhim12] ' + label + ' HTTP ' + r.status);
      return JSON.stringify([]);
    }
    const data = await r.json();
    const items = data.result || [];
    if (!Array.isArray(items) || items.length === 0) {
      return JSON.stringify([]);
    }
    const filteredItems = items.filter(apiMovie => {
      const movieData = apiMovie.movie ? apiMovie.movie : apiMovie;
      return !isTrailer(movieData);
    });
    const movies = filteredItems.map(transformCtaMovie).filter(m => m.title && m.url);
    console.log('[KENG][RoPhim12] ' + label + ' page movies: ' + movies.length);
    return JSON.stringify(movies);
  } catch (e) {
    console.error('[KENG][RoPhim12] ' + label + ' error: ' + e.message);
    return JSON.stringify([]);
  }
}

async function getAllKorean(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, 
    baseUrl + '/baseapi/api/v1/movies/by-region/han-quoc?page=' + p,
    'getAllKorean p=' + p
  );
}

async function getAllChinese(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, 
    baseUrl + '/baseapi/api/v1/movies/by-region/trung-quoc?page=' + p,
    'getAllChinese p=' + p
  );
}

async function getAllUsuk(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, 
    baseUrl + '/baseapi/api/v1/movies/by-region/au-my?page=' + p,
    'getAllUsuk p=' + p
  );
}

async function getAllCinema(baseUrl, page) {
  const p = page || 1;
  return _fetchCtaMovies(baseUrl, 
    baseUrl + '/baseapi/api/v1/movies/by-category/chieu-rap?page=' + p,
    'getAllCinema p=' + p
  );
}

/**
 * Fetch CTA movies from homepageLists by collection slug
 * Used for collections that don't have dedicated API endpoints
 */
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
    const slug = (apiMovie.slug || '').toLowerCase();
    
    return status === 'trailer' || 
           epCurrent === 'trailer' || 
           name.includes('trailer') || 
           slug.includes('.trailer');
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
    // Fetch all lists, then filter by slug client-side
    // Note: API doesn't support filtering by slug or pagination per list
    const url = BASE_API + '/lists/homepageLists?page=1&limit=15';
    const r = await fetch(url, buildFetchOptions(SITE_BASE + '/'));
    if (!r.ok) {
      console.warn('[KENG][RoPhim12] ' + label + ' HTTP ' + r.status);
      return JSON.stringify([]);
    }
    const data = await r.json();
    const collections = data?.result?.collections || [];
    const targetCollection = collections.find(c => c.slug === slug);

    if (!targetCollection || !targetCollection.movies || !Array.isArray(targetCollection.movies)) {
      console.warn('[KENG][RoPhim12] ' + label + ' collection not found or empty');
      return JSON.stringify([]);
    }

    // Simulate pagination by slicing the movies array
    // Note: homepageLists returns limited items (10-12), so page 2+ will be empty
    const pageSize = 12;
    const p = page || 1;
    const startIdx = (p - 1) * pageSize;
    const endIdx = startIdx + pageSize;
    const pageMovies = targetCollection.movies.slice(startIdx, endIdx);

    const filteredPageMovies = pageMovies.filter(apiMovie => {
      const movieData = apiMovie.movie ? apiMovie.movie : apiMovie;
      return !isTrailer(movieData);
    });
    const movies = filteredPageMovies.map(transformCtaMovie).filter(m => m.title && m.url);
    console.log('[KENG][RoPhim12] ' + label + ' page ' + p + ': ' + movies.length + ' movies');
    return JSON.stringify(movies);
  } catch (e) {
    console.error('[KENG][RoPhim12] ' + label + ' error: ' + e.message);
    return JSON.stringify([]);
  }
}

async function getAllCinemaFeatured(baseUrl, page) {
  return _fetchCtaFromList(baseUrl, 'man-nhan-voi-phim-chieu-rap', page, 'getAllCinemaFeatured');
}

async function getAllPhimHot(baseUrl, page) {
  return _fetchCtaFromList(baseUrl, 'phim-sap-toi', page, 'getAllPhimHot');
}

async function getAllAnime(baseUrl, page) {
  return _fetchCtaFromList(baseUrl, 'kho-tang-anime-moi-nhat', page, 'getAllAnime');
}

async function getAllHongKong(baseUrl, page) {
  return _fetchCtaFromList(baseUrl, 'dien-anh-hong-kong-o-cho-nay-nay', page, 'getAllHongKong');
}
