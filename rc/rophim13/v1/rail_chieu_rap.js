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

// ── Provider: rophim13 ──────────────────────────────────────

// Provider: rophim-13 | Site: https://onflix.lol
// Contract: railChieuRap(baseUrl) -> JSON { rails: [...] }
// API: https://k8s.onflixcdn.com/api/movies?type=chieu_rap&sort=newest&page=1&limit=12
// v6.1 rail-group contract — standalone CTA rail

// ===== SHARED CONSTANTS (file scope) =====
const _CR_API = 'https://k8s.onflixcdn.com/api';
const _CR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function _crFetchOpts(referer) {
  return {
    headers: {
      'User-Agent': _CR_UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': referer || 'https://onflix.lol/',
      'Origin': 'https://onflix.lol',
    },
  };
}

function _crTransformMovie(m, siteBase) {
  let badgeSub = '';
  const vs = m.vietsub || 0;
  const tm = m.thuyet_minh || 0;
  if (vs > 0 && tm > 0) {
    badgeSub = `P.Đ ${vs} | T.M ${tm}`;
  } else if (vs > 0) {
    badgeSub = `P.Đ ${vs}`;
  } else if (tm > 0) {
    badgeSub = `T.M ${tm}`;
  }
  const mediaType = m.type === 'phim-bo' ? 'series' : 'movie';
  const genres = m.categories
    ? m.categories.split(', ').map(g => g.trim()).filter(Boolean)
    : [];
  return {
    rank: 0,
    title: m.title || '',
    title_original: m.original_title || '',
    poster_url: m.thumb_url || m.poster_url || '',
    url: m.slug ? `${siteBase}/phim/${m.slug}` : '',
    media_type: mediaType,
    badge_text: m.quality || '',
    badge_sub: badgeSub,
    year: m.year ? String(m.year) : '',
    rating: m.tmdb_vote_average ? String(m.tmdb_vote_average) : '',
    synopsis: '',
    age_rating: m.rated || '',
    episode_current: m.episode_current || '',
    genres: genres,
  };
}

async function railChieuRap(baseUrl) {
  console.log('[KENG][rophim-13] railChieuRap() v1');

  try {
    const apiUrl = `${_CR_API}/movies?type=chieu_rap&sort=newest&page=1&limit=12`;
    const res = await fetch(apiUrl, _crFetchOpts(baseUrl + '/'));
    if (!res.ok) throw new Error('Movies API returned ' + res.status);
    const data = await res.json();
    const rawMovies = data.data || [];

    const seen = new Set();
    const movies = [];
    for (const m of rawMovies) {
      if (m.slug && !seen.has(m.slug)) {
        seen.add(m.slug);
        movies.push(_crTransformMovie(m, baseUrl));
      }
    }

    const validMovies = movies
      .filter(m => m.title && m.url)
      .sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
    console.log(`[KENG][rophim-13] railChieuRap() done — ${validMovies.length} movies`);

    return JSON.stringify({
      rails: [{
        id: 'chieu_rap',
        title: 'Phim Chiếu Rạp',
        subtitle: null,
        card_height_percent: 0.22,
        card_size_ratio: 0.667,
        is_hero_source: false,
        show_rank: false,
        movies: validMovies,
        show_cta: { js_method: 'getAllChieuRap' },
      }],
    });
  } catch (e) {
    console.log(`[KENG][rophim-13] railChieuRap() error: ${e.message}`);
    return JSON.stringify({ rails: [] });
  }
}

// ===== CTA FUNCTION =====
async function getAllChieuRap(page = 1) {
  const url = `${_CR_API}/movies?type=chieu_rap&sort=newest&page=${page}&limit=12`;
  const res = await fetch(url, _crFetchOpts());
  if (!res.ok) return JSON.stringify([]);
  const data = await res.json();
  const movies = (data.data || []).map(m => _crTransformMovie(m, 'https://onflix.lol'));
  return JSON.stringify(movies.filter(m => m.title && m.url).sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0)));
}
