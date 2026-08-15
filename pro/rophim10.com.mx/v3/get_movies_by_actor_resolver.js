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

// ── Provider: rophim10.com.mx ──────────────────────────────────────

/**
 * Movies by Actor Resolver v3
 * Contract: getMoviesByActor(baseUrl, actorName, page = 1) → JSON array of movie items
 * Source: /dien-vien/{slug}?page=N with embedded actor.movies[] payload
 */
async function getMoviesByActor(baseUrl, actorName, page = 1) {
  const SITE_BASE = resolveBaseUrl(baseUrl);
  if (!SITE_BASE) {
    return JSON.stringify({ error: 'Cannot resolve site base from baseUrl' });
  }
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  const safeSlug = encodeURIComponent(String(actorName || '').trim());

  if (Number(page) > 1) {
    console.log(`[KENG][RoPhim10] getMoviesByActor: page=${page} for ${safeSlug} is not supported, returning empty list`);
    return JSON.stringify([]);
  }

  function buildFetchOptions(refererUrl) {
    return {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': refererUrl || SITE_BASE + '/',
        'Origin': SITE_BASE,
      },
    };
  }

  function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function absUrl(url) {
    const text = cleanText(url);
    if (!text) return '';
    try {
      return new URL(text, SITE_BASE).href;
    } catch (_e) {
      return text;
    }
  }

  function inferMediaType(movie) {
    const type = cleanText(movie && movie.type || '').toLowerCase();
    const episodeCurrent = cleanText(movie && movie.episode_current || '').toLowerCase();
    if (type === 'single' || type === 'movie' || episodeCurrent === 'full') return 'movie';
    return 'series';
  }

  function parseGenres(movie) {
    const list = Array.isArray(movie && movie.categories) ? movie.categories : [];
    return list
      .map((genre) => cleanText(genre && genre.name ? genre.name : ''))
      .filter(Boolean);
  }

  function parseCountries(movie) {
    const list = Array.isArray(movie && movie.countries) ? movie.countries : [];
    return list
      .map((country) => cleanText(country && country.name ? country.name : ''))
      .filter(Boolean)
      .join(', ');
  }

  function isTrailer(movie) {
    const status = cleanText(movie && movie.status || '').toLowerCase();
    const epCurrent = cleanText(movie && movie.episode_current || '').toLowerCase();
    const name = cleanText(movie && movie.name || '').toLowerCase();
    return status === 'trailer' || epCurrent === 'trailer' || name.includes('trailer');
  }

  function inferMediaTypeFromMeta(html) {
    const normalized = html.replace(/\\"/g, '"');
    const typeMatch = normalized.match(/"type":"([^"]+)"/i);
    const type = cleanText(typeMatch ? typeMatch[1] : '').toLowerCase();
    const epMatch = normalized.match(/"episode_current":"([^"]+)"/i);
    const episodeCurrent = cleanText(epMatch ? epMatch[1] : '').toLowerCase();
    if (type === 'single' || type === 'movie' || episodeCurrent.includes('full')) {
      return 'movie';
    }
    if (type === 'series' || episodeCurrent.includes('tập') || episodeCurrent.includes('tap')) {
      return 'series';
    }
    return 'movie';
  }

  function extractYearFromHtml(html) {
    const normalized = html.replace(/\\"/g, '"');
    const match =
      normalized.match(/"publish_year":(\d{4})/i) ||
      normalized.match(/"release_year":(\d{4})/i) ||
      normalized.match(/"year":(\d{4})/i);
    return match ? String(match[1]) : '';
  }

  function extractBadgeFromHtml(html) {
    const normalized = html.replace(/\\"/g, '"');
    const epMatch = normalized.match(/"episode_current":"([^"]+)"/i);
    if (epMatch) return cleanText(epMatch[1]);
    const qualityMatch = normalized.match(/"quality":"([^"]+)"/i);
    return qualityMatch ? cleanText(qualityMatch[1]) : '';
  }

  function parseActorItemList(html) {
    const cards = [];
    const seen = new Set();
    const normalized = html.replace(/\\"/g, '"');
    const cardRe =
      /<div class="sw-item"><a class="v-thumbnail" href="([^"]+)">([\s\S]*?)<\/a><div class="info"><h4 class="item-title lim-1"><a title="([^"]*)"[^>]*>([^<]*)<\/a><\/h4><h4 class="alias-title lim-1"><a title="([^"]*)"[^>]*>([^<]*)<\/a><\/h4><\/div><\/div>/g;
    let match;
    while ((match = cardRe.exec(normalized)) !== null) {
      const href = cleanText(match[1]);
      const thumbnailBlock = match[2] || '';
      const title = cleanText(match[3] || match[4] || '');
      const titleOriginal = cleanText(match[5] || match[6] || '');
      const imgMatch = thumbnailBlock.match(/<img[^>]*src="([^"]+)"/i);
      const badgeMatches = Array.from(
        thumbnailBlock.matchAll(/<strong>([^<]+)<\/strong>/gi),
      ).map((m) => cleanText(m[1]));
      const badgeBody = badgeMatches.filter(Boolean).join(' / ');
      const badgeClassMatch = thumbnailBlock.match(/class="[^"]*\bline-center\b[^"]*\b(line-lt|line-tm|line-pd)\b[^"]*"/i);
      const badgePrefix = badgeClassMatch
        ? ({ 'line-lt': 'LT.', 'line-tm': 'TM.', 'line-pd': 'PĐ.' }[badgeClassMatch[1].toLowerCase()] || '')
        : '';
      const badgeText = badgePrefix && badgeBody ? `${badgePrefix} ${badgeBody}` : badgeBody;

      if (!href || !title) continue;
      const dedupeKey = absUrl(href);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      cards.push({
        title,
        title_original: titleOriginal,
        url: dedupeKey,
        poster_url: imgMatch ? absUrl(imgMatch[1]) : '',
        thumbnail_url: imgMatch ? absUrl(imgMatch[1]) : '',
        badge_text: badgeText,
      });
    }

    return cards;
  }

  function extractBalancedSegment(text, startIndex, openChar, closeChar) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let begin = -1;

    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === openChar) {
        if (begin < 0) begin = i;
        depth += 1;
        continue;
      }

      if (ch === closeChar) {
        depth -= 1;
        if (depth === 0 && begin >= 0) {
          return text.slice(begin, i + 1);
        }
      }
    }
    return '';
  }

  function parseMoviesFromHtml(html) {
    const actorItems = parseActorItemList(html);
    if (actorItems.length > 0) {
      return actorItems.map((item) => ({
        rank: 0,
        title: item.title,
        title_original: item.title_original || '',
        poster_url: item.poster_url || '',
        thumbnail_url: item.thumbnail_url || '',
        url: item.url,
        media_type: 'movie',
        badge_text: item.badge_text || '',
        badge_sub: '',
        year: '',
        rating: '',
        synopsis: '',
        age_rating: '',
        episode_current: '',
        genres: [],
      }));
    }

    const normalized = html.replace(/\\"/g, '"');
    const marker = '"movies":[';
    const idx = normalized.indexOf(marker);
    if (idx < 0) return [];

    const arrayJson = extractBalancedSegment(normalized, idx + marker.length - 1, '[', ']');
    if (!arrayJson) return [];

    let rawMovies = [];
    try {
      rawMovies = JSON.parse(arrayJson);
    } catch (_e) {
      return [];
    }

    if (!Array.isArray(rawMovies)) {
      return [];
    }

    return rawMovies
      .filter((movie) => movie && !isTrailer(movie))
      .map((movie) => ({
        rank: 0,
        title: cleanText(movie.name || ''),
        title_original: cleanText(movie.origin_name || ''),
        poster_url: absUrl(movie.poster || movie.thumbnail || ''),
        thumbnail_url: absUrl(movie.thumbnail || ''),
        url: movie.slug ? `${SITE_BASE}/phim/${movie.slug}` : '',
        media_type: inferMediaType(movie),
        badge_text: cleanText(movie.episode_current || movie.quality || ''),
        badge_sub: '',
        year: String(movie.publish_year || ''),
        rating: String(movie.imdb_rating || ''),
        synopsis: cleanText(movie.description || ''),
        age_rating: cleanText(movie.rating || ''),
        episode_current: cleanText(movie.episode_current || ''),
        genres: parseGenres(movie),
      }));
  }

  function resolveActorPageUrl(actorUrl, page) {
    const raw = String(actorUrl || '').trim();
    if (!raw) return '';
    try {
      const normalized = raw.startsWith('http')
        ? raw
        : (raw.startsWith('/')
          ? raw
          : `/dien-vien/${raw}`);
      const url = new URL(normalized, SITE_BASE);
      url.searchParams.set('page', String(page));
      return url.href;
    } catch (_e) {
      return '';
    }
  }

  try {
    const url = resolveActorPageUrl(actorName, page);
    if (!url) {
      throw new Error('Invalid actor URL');
    }
    console.log(`[KENG][RoPhim10] getMoviesByActor: fetching ${url}`);
    const response = await fetch(url, buildFetchOptions(SITE_BASE + '/'));

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const movies = parseMoviesFromHtml(html);
    console.log(`[KENG][RoPhim10] getMoviesByActor: parsed ${movies.length} items from ${url}`);

    if (movies.length === 0) {
      return JSON.stringify([]);
    }

    return JSON.stringify(movies);
  } catch (e) {
    console.error(`[KENG][RoPhim10] getMoviesByActor ERROR: ${e.message}`);
    return JSON.stringify({ error: e.message });
  }
}

function resolveBaseUrl(baseUrl) {
  if (typeof baseUrl === 'string' && /^https?:\/\//i.test(baseUrl)) return baseUrl;
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return '';
}
