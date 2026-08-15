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

function inferMediaType(movie) {
  const type = cleanText(movie && movie.type || '').toLowerCase();
  const totalEpisodes = Number.parseInt(movie && movie.total_episodes ? String(movie.total_episodes) : '', 10) || 0;
  const currentEpisode = cleanText(movie && movie.current_episode || '').toLowerCase();
  if (type === 'movie' || type === 'single' || /full/.test(currentEpisode)) {
    return 'movie';
  }
  if (/tập|episode|phần|hoàn\s*tất/.test(currentEpisode) || totalEpisodes > 1) {
    return 'series';
  }
  return 'series';
}

function parseGenres(movie) {
  const groups = movie && movie.category;
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

function parseActors(movie) {
  const raw = Array.isArray(movie && movie.actors)
    ? movie.actors
    : Array.isArray(movie && movie.actor)
      ? movie.actor
      : cleanText(movie && movie.casts || '').split(',');

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

function extractSlug(filmUrl) {
  try {
    const url = new URL(cleanText(filmUrl), resolveBaseUrl(filmUrl));
    const slug = cleanText(url.pathname.split('/').filter(Boolean).pop() || '');
    return slug;
  } catch (_e) {
    return '';
  }
}

function parseEpisodes(movie, baseUrl, filmSlug) {
  const groups = Array.isArray(movie && movie.episodes) ? movie.episodes : [];
  const mapped = [];
  let episodeCounter = 0;

  groups.forEach((group) => {
    const serverName = cleanText(group && group.server_name || 'Server').replace(/:$/, '');
    const items = Array.isArray(group && group.items) ? group.items : [];
    items.forEach((entry) => {
      const rawName = cleanText(entry && entry.name || '');
      if (!rawName || /trailer/i.test(rawName)) return;

      const isFull = /full/i.test(rawName);
      const match = rawName.match(/(\d+)/);
      const episodeIndex = match ? Number.parseInt(match[1], 10) : (isFull ? 1 : null);
      if (episodeIndex === null) return;

      let item = mapped.find((ep) => ep._episodeIndex === episodeIndex);
      if (!item) {
        item = {
          _episodeIndex: episodeIndex,
          episode_index: episodeCounter++,
          name: isFull ? 'Tập Full' : `Tập ${episodeIndex}`,
          servers: []
        };
        mapped.push(item);
      }

      const embedUrl = cleanText(entry.embed || '');
      const m3u8Url = cleanText(entry.m3u8 || '');
      let epUrl = '';
      if (embedUrl) {
        epUrl = embedUrl;
      } else if (m3u8Url) {
        epUrl = m3u8Url;
      } else {
        epUrl = absUrl(baseUrl, `/film/${encodeURIComponent(filmSlug)}`);
      }

      item.servers.push({
        server: serverName,
        url: epUrl
      });
    });
  });

  return mapped
    .sort((a, b) => a._episodeIndex - b._episodeIndex)
    .map(({ _episodeIndex, ...rest }, index) => ({
      episode_index: index,
      name: rest.name,
      servers: rest.servers
    }))
    .filter((ep) => Array.isArray(ep.servers) && ep.servers.length > 0);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://phim.nguonc.com' } });
  if (!res.ok) {
    throw new Error('Fetch failed: ' + res.status);
  }
  return await res.json();
}

async function getMovieDetail(filmUrl) {
  try {
    if (!filmUrl) throw new Error('Missing filmUrl');

    const siteBase = resolveBaseUrl(filmUrl);
    const filmSlug = extractSlug(filmUrl);
    if (!filmSlug) throw new Error('Invalid filmUrl');

    const json = await fetchJson(new URL(`/api/film/${encodeURIComponent(filmSlug)}`, siteBase).href);
    const movie = json && json.movie ? json.movie : {};
    const parts = parseEpisodes(movie || {}, siteBase, filmSlug);

    const detail = {
      rank: 0,
      title: cleanText(movie.name || ''),
      title_original: cleanText(movie.original_name || ''),
      poster_url: imgUrl(movie.thumb_url || movie.poster_url || ''),
      thumbnail_url: imgUrl(movie.poster_url || movie.thumb_url || ''),
      url: absUrl(siteBase, `/film/${encodeURIComponent(filmSlug)}`),
      actors: parseActors(movie),
      media_type: inferMediaType(movie),
      badge_text: cleanText(movie.current_episode || movie.quality || ''),
      badge_sub: cleanText(movie.language || ''),
      year: cleanText(movie.year || ''),
      rating: cleanText(movie.rating || ''),
      synopsis: stripHtml(movie.description || ''),
      age_rating: cleanText(movie.age_rating || ''),
      episode_current: cleanText(movie.current_episode || ''),
      genres: parseGenres(movie),
      parts: [
        {
          name: 'Phần 1',
        episodes: parts.length ? parts : [{
          episode_index: 0,
          name: 'Tập Full',
          servers: [{
            server: 'Server 1',
              url: absUrl(siteBase, `/film/${encodeURIComponent(filmSlug)}`)
            }]
          }]
        }
      ]
    };

    return JSON.stringify(detail);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}
