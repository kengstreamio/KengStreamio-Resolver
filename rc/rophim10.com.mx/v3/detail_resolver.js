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

// ── Provider: rophim10.com.mx ──────────────────────────────────────

/**
 * Detail Resolver v6 (HTML metadata + episodes API with Parts Support)
 * Story: 10.16
 * Contract: getMovieDetail(filmUrl) -> JSON object with parts[] field (v6.1 breaking change)
 * Source: HTML SSR movie payload + GET /baseapi/api/v1/episodes/by-idMovie/{movieId}
 * Parts: Group episodes by season_number field
 */
async function getMovieDetail(filmUrl) {
  const SITE_BASE = resolveSiteBase(filmUrl);
  if (!SITE_BASE) {
    return JSON.stringify({ error: 'Cannot resolve site base from filmUrl' });
  }
  const BASE_API = SITE_BASE + '/baseapi/api/v1';
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

  function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function stripHtml(html) {
    return String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseEpisodeTotal(str) {
    if (!str) return 0;
    const match = String(str).match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function parseEpisodeNumber(name) {
    if (!name) return null;

    const directNum = parseInt(name, 10);
    if (!isNaN(directNum)) return directNum;

    const match = String(name).match(/\D+(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  function parseActorsFromDetailPage(html) {
    const actors = [];
    const seen = new Set();

    const actorCardRe = /<div class="v-item">\s*<a class="v-actor v-actor-medium" href="([^"]+)">\s*<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"[^>]*>\s*<\/a>/gi;
    let match;
    while ((match = actorCardRe.exec(html)) !== null) {
      const href = cleanText(match[1] || '');
      const name = cleanText(match[2] || '');
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      actors.push({
        name,
        avatar_url: cleanText(match[3] || ''),
        actor_url: href,
      });
    }

    if (actors.length > 0) {
      return actors;
    }

    const metaMatch = html.match(/<meta name="video:actor" content="([^"]+)"/i);
    if (!metaMatch) {
      return [];
    }

    return metaMatch[1]
      .split(',')
      .map((name) => cleanText(name))
      .filter(Boolean)
      .map((name) => ({ name, avatar_url: '', actor_url: '' }));
  }

  function extractSerializedMovie(html) {
    const keyCandidates = ['\\"movie\\":', '"movie":'];
    let idx = -1;
    let key = '';
    for (const candidate of keyCandidates) {
      idx = html.indexOf(candidate);
      if (idx !== -1) {
        key = candidate;
        break;
      }
    }

    if (idx === -1) {
      return null;
    }

    const start = html.indexOf('{', idx + key.length);
    if (start === -1) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < html.length; i++) {
      const ch = html[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (ch === '{') {
        depth++;
        continue;
      }

      if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end === -1) {
      return null;
    }

    return html.slice(start, end);
  }

  function parseMoviePayload(html) {
    const serializedMovie = extractSerializedMovie(html);
    if (!serializedMovie) {
      return null;
    }

    try {
      const movieJsonText = JSON.parse('"' + serializedMovie + '"');
      return JSON.parse(movieJsonText);
    } catch (e) {
      console.warn(`[KENG][RoPhim10] Failed to parse serialized movie payload: ${e.message}`);
      return null;
    }
  }

  try {
    console.log(`[KENG][RoPhim10] getMovieDetail: ${filmUrl}`);

    const slugMatch = filmUrl.match(/\/phim\/([^/?]+)/);
    if (!slugMatch) {
      return JSON.stringify({ error: 'Invalid film URL format' });
    }

    const slug = slugMatch[1];

    const filmPageResponse = await fetch(filmUrl, buildFetchOptions(filmUrl));
    const filmPageHtml = filmPageResponse.ok ? await filmPageResponse.text() : '';

    const apiMovie = parseMoviePayload(filmPageHtml);
    if (!apiMovie) {
      throw new Error('No movie data in HTML payload');
    }

    const movieId = apiMovie.id || (Array.isArray(apiMovie.latestEpisodes) && apiMovie.latestEpisodes.length > 0
      ? apiMovie.latestEpisodes[0].movieId
      : 0);
    const partNumber = apiMovie.partNumber || 0;

    let parts = [];
    if (movieId) {
      try {
        const episodesUrl = `${BASE_API}/episodes/by-idMovie/${movieId}`;
        const episodesResponse = await fetch(episodesUrl, buildFetchOptions(filmUrl));

        if (episodesResponse.ok) {
          const episodesData = await episodesResponse.json();
          const episodeItems = Array.isArray(episodesData)
            ? episodesData
            : (episodesData.result || episodesData.data || []);

          if (Array.isArray(episodeItems) && episodeItems.length > 0) {
            parts = groupEpisodesByParts(episodeItems, apiMovie.slug || slug, partNumber, SITE_BASE);
          }
        }
      } catch (e) {
        console.warn(`[KENG][RoPhim10] Failed to fetch episodes: ${e.message}`);
      }
    }

    if (parts.length === 0) {
      parts = [{
        name: 'Phần 1',
        episodes: []
      }];
    }

    const htmlActors = parseActorsFromDetailPage(filmPageHtml);
    const apiActors = Array.isArray(apiMovie.actors) ? apiMovie.actors : [];
    const actorCount = Math.max(apiActors.length, htmlActors.length);
    const actorItems = [];
    for (let i = 0; i < actorCount; i++) {
      const apiActor = apiActors[i] || {};
      const htmlActor = htmlActors[i] || {};
      const name = cleanText(apiActor.other_name || apiActor.name || htmlActor.name || '');
      if (!name) continue;
      actorItems.push({
        name,
        avatar_url: cleanText(htmlActor.avatar_url || apiActor.thumbnail || ''),
        actor_url: cleanText(
          htmlActor.actor_url ||
          apiActor.href ||
          apiActor.url ||
          '',
        ),
      });
    }

    const detail = {
      id: apiMovie.slug || slug,
      title: apiMovie.name || '',
      title_original: apiMovie.origin_name || '',
      poster_url: apiMovie.poster || apiMovie.thumbnail || '',
      thumbnail_url: apiMovie.thumbnail || '',
      url: apiMovie.slug ? `${SITE_BASE}/phim/${apiMovie.slug}` : filmUrl,
      year: String(apiMovie.publish_year || ''),
      duration: apiMovie.episode_time || '',
      rating: String(apiMovie.imdb_rating || ''),
      country: Array.isArray(apiMovie.regions) && apiMovie.regions.length > 0
        ? apiMovie.regions[0].name || ''
        : (Array.isArray(apiMovie.countries) && apiMovie.countries.length > 0
          ? apiMovie.countries[0].name || ''
          : ''),
      genres: Array.isArray(apiMovie.categories)
        ? apiMovie.categories.map((c) => c.name || c)
        : [],
      description: apiMovie.description
        ? stripHtml(apiMovie.description)
        : (apiMovie.origin_name ? stripHtml(apiMovie.origin_name) : ''),
      media_type: apiMovie.type === 'series' ? 'series' : 'movie',
      total_episodes: apiMovie.episode_total ? parseEpisodeTotal(apiMovie.episode_total) : 0,
      badge_text: apiMovie.episode_current || '',
      parts,
      actors: actorItems,
    };

    const totalEpisodes = parts.reduce((sum, part) => sum + part.episodes.length, 0);
    const actorUrls = actorItems.filter((actor) => actor.actor_url).length;
    console.log(`[KENG][RoPhim10] getMovieDetail: ${detail.title} (${detail.media_type}) with ${parts.length} parts, ${totalEpisodes} episodes, ${actorItems.length} actors (${actorUrls} urls)`);
    return JSON.stringify(detail);

  } catch (e) {
    console.error(`[KENG][RoPhim10] getMovieDetail ERROR: ${e.message}`);
    return JSON.stringify({ error: e.message });
  }
}

/**
 * Group episodes by season_number (parts) and format to Episode Contract
 * @param {Array} episodeItems - Raw episode items from API
 * @param {string} movieSlug - Movie slug for building watch URLs
 * @param {number} expectedParts - Expected number of parts (from movie.partNumber)
 * @returns {Array} Parts array with episodes
 */
function groupEpisodesByParts(episodeItems, movieSlug, expectedParts, baseUrl) {
  const partsMap = new Map();

  for (const item of episodeItems) {
    const seasonNum = item.season_number || 1;

    if (!partsMap.has(seasonNum)) {
      partsMap.set(seasonNum, []);
    }

    partsMap.get(seasonNum).push(item);
  }

  const sortedSeasons = Array.from(partsMap.keys()).sort((a, b) => a - b);

  const parts = [];
  for (const seasonNum of sortedSeasons) {
    const rawEpisodes = partsMap.get(seasonNum);
    const episodeMap = new Map();

    for (const item of rawEpisodes) {
      const epNum = parseEpisodeNumber(item.name);
      const epKey = epNum !== null ? epNum : item.name;

      if (!episodeMap.has(epKey)) {
        episodeMap.set(epKey, {
          episode_index: epNum !== null ? epNum - 1 : 0,
          name: item.name,
          servers: []
        });
      }

      const ep = episodeMap.get(epKey);
      if (item.server && item.id) {
        const watchUrl = `${baseUrl}/xem-phim/${movieSlug}.${item.id}`;
        ep.servers.push({
          server: item.server.replace(/:$/, ''),
          url: watchUrl
        });
      }
    }

    const episodes = Array.from(episodeMap.values())
      .sort((a, b) => a.episode_index - b.episode_index);

    parts.push({
      name: `Phần ${seasonNum}`,
      episodes
    });
  }

  return parts;
}

function parseEpisodeNumber(name) {
  if (!name) return null;

  const directNum = parseInt(name, 10);
  if (!isNaN(directNum)) return directNum;

  const match = String(name).match(/\D+(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function resolveSiteBase(url) {
  const siteMatch = String(url || '').match(/^(https?:\/\/[^/]+)/);
  if (siteMatch) return siteMatch[1];
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return '';
}
