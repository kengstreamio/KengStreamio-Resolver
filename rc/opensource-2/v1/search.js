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

// ── Provider: opensource-2 ──────────────────────────────────────

function resolveBaseUrl(baseUrl) {
  return (typeof baseUrl === 'string' && /^https?:\/\//i.test(baseUrl))
    ? baseUrl
    : ((typeof location !== 'undefined' && location.origin) ? location.origin : '');
}

function splitArgs(rawArgs) {
  const args = Array.from(rawArgs);
  let baseUrl = '';
  if (typeof args[0] === 'string' && /^https?:\/\//i.test(args[0])) {
    baseUrl = args.shift();
  }
  return { baseUrl: resolveBaseUrl(baseUrl), args };
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  return cleanText(value).replace(/<[^>]*>/g, ' ');
}

function absUrl(baseUrl, url) {
  const text = cleanText(url);
  if (!text) return '';
  try {
    return new URL(text, baseUrl).href;
  } catch (_e) {
    return text;
  }
}

function imgUrl(url) {
  const text = cleanText(url);
  if (!text) return '';
  try {
    return new URL(text, 'https://phim.nguonc.com').href;
  } catch (_e) {
    return text;
  }
}

function slugify(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function inferMediaType(item) {
  const type = cleanText(item && item.type || '').toLowerCase();
  const totalEpisodes = Number.parseInt(item && item.total_episodes ? String(item.total_episodes) : '', 10) || 0;
  const currentEpisode = cleanText(item && item.current_episode || '').toLowerCase();
  if (type === 'movie' || type === 'single' || /full/.test(currentEpisode)) {
    return 'movie';
  }
  if (/tập|episode|phần|hoàn\s*tất/.test(currentEpisode) || totalEpisodes > 1) {
    return 'series';
  }
  return 'series';
}

function isTrailer(item) {
  const haystack = [
    item && item.badge_text,
    item && item.current_episode,
    item && item.name,
    item && item.original_name
  ].map(cleanText).join(' ').toLowerCase();
  return haystack.includes('trailer');
}

function parseGenres(item) {
  const groups = item && item.category;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return [];
  const result = [];
  Object.values(groups).forEach((group) => {
    const groupName = cleanText(group && group.group && group.group.name ? group.group.name : '');
    if (groupName && !/thể loại/i.test(groupName)) return;
    const list = Array.isArray(group && group.list) ? group.list : [];
    list.forEach((entry) => {
      const name = cleanText(entry && entry.name ? entry.name : '');
      if (name) result.push(name);
    });
  });
  return [...new Set(result)];
}

function parseActors(item) {
  const raw = Array.isArray(item && item.actors)
    ? item.actors
    : Array.isArray(item && item.actor)
      ? item.actor
      : cleanText(item && item.casts || '').split(',');

  return raw
    .map((actor) => {
      if (typeof actor === 'string') {
        return { name: cleanText(actor), avatar_url: '' };
      }
      if (actor && typeof actor === 'object') {
        return {
          name: cleanText(actor.name || actor.fullname || actor.title || ''),
          avatar_url: cleanText(actor.avatar_url || actor.thumbnail || actor.image || '')
        };
      }
      return { name: cleanText(actor), avatar_url: '' };
    })
    .filter((actor) => actor.name);
}

function normalizeMovieItem(baseUrl, item) {
  const thumb = cleanText(item.thumb_url || item.poster_url || '');
  const poster = cleanText(item.poster_url || item.thumb_url || '');
  const title = cleanText(item.name || '');
  const slug = cleanText(item.slug || '');
  const currentEpisode = cleanText(item.current_episode || '');
  const quality = cleanText(item.quality || '');
  const language = cleanText(item.language || '');

  return {
    rank: 0,
    title,
    title_original: cleanText(item.original_name || ''),
    poster_url: imgUrl(thumb || poster),
    thumbnail_url: imgUrl(poster || thumb),
    url: slug ? absUrl(baseUrl, `/film/${encodeURIComponent(slug)}`) : '',
    actors: parseActors(item),
    media_type: inferMediaType(item),
    badge_text: currentEpisode || quality,
    badge_sub: language,
    year: cleanText(item.year || ''),
    rating: cleanText(item.rating || ''),
    synopsis: stripHtml(item.description || ''),
    age_rating: cleanText(item.age_rating || ''),
    episode_current: currentEpisode,
    genres: parseGenres(item)
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://phim.nguonc.com' } });
  if (!res.ok) {
    throw new Error('Fetch failed: ' + res.status);
  }
  return await res.json();
}

async function searchMovies(baseUrl, keyword, page = 1) {
  try {
    const siteBase = resolveBaseUrl(baseUrl);
    const query = cleanText(keyword);
    if (!query) return JSON.stringify([]);

    const url = new URL('/api/films/search', siteBase);
    url.searchParams.set('keyword', query);
    const json = await fetchJson(url.href);
    const items = Array.isArray(json && json.items) ? json.items : [];
    const movies = items
      .filter((item) => item && !isTrailer(item))
      .map((item) => normalizeMovieItem(siteBase, item))
      .filter((movie) => movie.title && movie.url);

    return JSON.stringify(movies);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}
