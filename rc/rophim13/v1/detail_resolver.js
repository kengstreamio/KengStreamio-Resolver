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

// ── Provider: rophim13 ──────────────────────────────────────

/**
 * Detail Resolver v1 — onflix.lol (rophim-13)
 * Contract: getMovieDetail(filmUrl) → JSON object with parts[] field (v6.1)
 * Source: Next.js RSC payload embedded in detail page HTML
 * Episodes: Directly in RSC payload with link_m3u8 + link_embed
 */
async function getMovieDetail(filmUrl) {
  const _API = 'https://k8s.onflixcdn.com/api';
  const _UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  function _fetchOpts(referer) {
    return {
      headers: {
        'User-Agent': _UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': referer || 'https://onflix.lol/',
      },
    };
  }

  function _clean(v) {
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  }

  function _stripHtml(html) {
    return String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  function _parseEpNum(name) {
    if (!name) return null;
    const n = parseInt(String(name).replace(/^0+/, ''), 10);
    return isNaN(n) ? null : n;
  }

  /**
   * Extract RSC pushes from Next.js HTML
   * Pattern: self.__next_f.push([1,"..."])
   */
  function _extractRscPushes(html) {
    const pushes = [];
    const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        pushes.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
      } catch (_) {
        // skip malformed
      }
    }
    return pushes;
  }

  /**
   * Find RSC push(es) containing movie + episodes data
   * They may be in the same push (old format) or separate pushes (new format).
   * Returns { moviePush, episodesPush } where episodesPush may be null.
   */
  function _findDataPush(pushes) {
    let moviePush = null;
    let episodesPush = null;

    for (const p of pushes) {
      // Look for movie data
      if (p.includes('"movie":{')) {
        if (p.includes('"episodes":[')) {
          // Combined format — both in one push
          return { moviePush: p, episodesPush: p };
        }
        moviePush = p;
      }
      // Look for episodes data (may be in a different push)
      if (p.includes('"episodes":[')) {
        episodesPush = p;
      }
    }

    if (moviePush) {
      return { moviePush, episodesPush };
    }
    return null;
  }

  /**
   * Extract movie object from RSC push using brace-depth parsing
   */
  function _extractMovieObj(text) {
    const key = '"movie":{';
    const idx = text.indexOf(key);
    if (idx === -1) return null;

    const start = idx + key.length - 1; // position of opening {
    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  /**
   * Extract episodes array from RSC push using bracket-depth parsing
   */
  function _extractEpisodesArr(text) {
    const key = '"episodes":[';
    const idx = text.indexOf(key);
    if (idx === -1) return null;

    const start = idx + key.length - 1; // position of opening [
    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '[') depth++;
      if (ch === ']') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  /**
   * Group flat episodes by episode number → nested with servers[]
   */
  function _groupEpisodes(rawEps) {
    const map = new Map(); // key = episode number
    const _SKIP_SRCS = new Set([]); // NC: was blocked (DNS+CORS), now handled via embed type

    for (const ep of rawEps) {
      let num = _parseEpNum(ep.name || ep.slug);
      let displayName = null; // null → use "Tập ${num}" default

      // Cinema/phim-le movies have non-numeric names like "FULL"
      if (num === null) {
        const rawName = _clean(ep.name || ep.slug || '');
        if (!rawName) continue; // truly empty — skip
        num = 0; // default episode number for single-episode movies
        displayName = rawName; // keep original name (e.g. "FULL")
      }

      // Skip NC server — ss.onflixstream.site DNS NXDOMAIN, embed cross-origin CORS blocked
      if (_SKIP_SRCS.has(ep.src)) continue;

      if (!map.has(num)) {
        map.set(num, { num, name: displayName || `Tập ${num}`, servers: [] });
      }

      const entry = map.get(num);
      const serverName = _clean(ep.server_name || 'Vietsub #1');
      const m3u8 = ep.link_m3u8 || '';
      const embed = ep.link_embed || '';

      // Prefer m3u8, fallback embed
      const url = m3u8 || embed;
      if (url) {
        entry.servers.push({ server: serverName, url });
      }
    }

    // Sort servers: SN → OP → NC → unknown → PA (PA lowest priority)
    const _prio = (s) => {
      if (s.includes('(SN)')) return 0;
      if (s.includes('(OP)')) return 1;
      if (s.includes('(NC)')) return 2;
      if (s.includes('(PA)')) return 100;
      return 99;
    };
    for (const [, entry] of map) {
      entry.servers.sort((a, b) => _prio(a.server) - _prio(b.server));
    }

    return Array.from(map.values())
      .sort((a, b) => a.num - b.num)
      .map((ep, idx) => ({
        episode_index: idx,
        name: ep.name,
        servers: ep.servers,
      }));
  }

  try {
    console.log(`[KENG][rophim-13] getMovieDetail: ${filmUrl}`);

    // 1. Fetch detail page HTML
    const resp = await fetch(filmUrl, _fetchOpts(filmUrl));
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const html = await resp.text();

    // 2. Extract RSC pushes
    const pushes = _extractRscPushes(html);
    if (pushes.length === 0) {
      throw new Error('No RSC payload found');
    }

    // 3. Find data push(es) with movie + episodes
    const dataPush = _findDataPush(pushes);
    if (!dataPush) {
      throw new Error('No movie+episodes data in RSC payload');
    }

    // 4. Extract movie object
    const movieStr = _extractMovieObj(dataPush.moviePush);
    if (!movieStr) {
      throw new Error('Cannot extract movie object');
    }
    const movie = JSON.parse(movieStr);

    // 5. Extract episodes array (may be in a separate push, or empty)
    let rawEps = [];
    if (dataPush.episodesPush) {
      const epsStr = _extractEpisodesArr(dataPush.episodesPush);
      if (epsStr) {
        rawEps = JSON.parse(epsStr);
      }
    }

    // 6. Group episodes
    const episodes = _groupEpisodes(rawEps);

    // 7. Build parts (single part — onflix has no multi-season)
    const parts = [{
      name: 'Phần 1',
      episodes,
    }];

    // 8. Build actors
    const actors = Array.isArray(movie.actors)
      ? movie.actors.map(a => ({
          name: _clean(a.name || a.original_name || ''),
          avatar_url: _clean(a.image_url || ''),
        })).filter(a => a.name)
      : [];

    // 9. Build genres
    const genres = Array.isArray(movie.categories)
      ? movie.categories.map(c => _clean(c.name || ''))
      : [];

    // 10. Build country
    const country = Array.isArray(movie.countries) && movie.countries.length > 0
      ? _clean(movie.countries[0].name || '')
      : '';

    // 11. media_type mapping
    const mediaType = movie.type === 'phim-bo' ? 'series' : 'movie';

    // 12. Build detail
    const slug = movie.slug || '';
    const detail = {
      id: slug,
      title: _clean(movie.title || ''),
      title_original: _clean(movie.original_title || ''),
      poster_url: _clean(movie.poster_url || ''),
      thumbnail_url: _clean(movie.thumb_url || ''),
      url: slug ? `https://onflix.lol/phim/${slug}` : filmUrl,
      year: String(movie.year || ''),
      duration: _clean(movie.time || ''),
      rating: String(movie.tmdb_vote_average || movie.rated || ''),
      country,
      genres,
      description: _stripHtml(movie.content || ''),
      media_type: mediaType,
      total_episodes: parseInt(movie.total_episode || movie.episode_total || '0', 10) || 0,
      badge_text: _clean(movie.episode_status || movie.episode_current || ''),
      parts,
      actors,
    };

    const totalEps = parts.reduce((s, p) => s + p.episodes.length, 0);
    console.log(`[KENG][rophim-13] getMovieDetail: ${detail.title} (${detail.media_type}) — ${parts.length} part(s), ${totalEps} episodes, ${actors.length} actors`);

    return JSON.stringify(detail);

  } catch (e) {
    console.error(`[KENG][rophim-13] getMovieDetail ERROR: ${e.message}`);
    return JSON.stringify({ error: e.message });
  }
}
