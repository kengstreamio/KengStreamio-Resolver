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

// ── Provider: rophim11 ──────────────────────────────────────

async function getMovieDetail(filmUrl) {
  const SITE_BASE = resolveSiteBase(filmUrl);
  if (!SITE_BASE) {
    return JSON.stringify({ error: 'Cannot resolve site base from filmUrl' });
  }
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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

  function decodeHtml(text) {
    return String(text ?? '')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#8211;/g, '-')
      .replace(/&#8217;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();
  }

  function stripHtml(html) {
    return String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function slugify(text) {
    return cleanText(text)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function resolveCanonicalDetailUrl(url) {
    const match = String(url || '').match(/^(https?:\/\/[^/]+)\/phim\/([^/?#]+)(?:\/tap-\d+)?/i);
    if (!match) return url;
    return `${match[1]}/phim/${match[2]}`;
  }

  function extractBalancedObject(text, startIndex) {
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

      if (ch === '{') {
        if (begin < 0) begin = i;
        depth += 1;
        continue;
      }

      if (ch === '}') {
        depth -= 1;
        if (depth === 0 && begin >= 0) {
          return text.slice(begin, i + 1);
        }
      }
    }
    return '';
  }

  function parseWindowMovie(html) {
    const idx = html.indexOf('window._movie');
    if (idx === -1) return null;
    const start = html.indexOf('{', idx);
    if (start === -1) return null;
    const raw = extractBalancedObject(html, start);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  }

  function parseJsonLdMovie(html) {
    const scriptRe = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    for (const match of html.matchAll(scriptRe)) {
      const text = match[1].trim();
      if (!text) continue;
      try {
        const parsed = JSON.parse(text);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        const movie = candidates.find((item) => item && (item['@type'] === 'Movie' || item['@type'] === 'TVSeries'));
        if (movie) return movie;
      } catch (_e) {
        continue;
      }
    }
    return null;
  }

  function parseEpisodes(movie, siteBase, slug) {
    const groups = Array.isArray(movie && movie.episodes) ? movie.episodes : [];
    const episodeMap = new Map();

    for (const group of groups) {
      const serverName = cleanText(group && group.server_name || '');
      const serverData = Array.isArray(group && group.server_data) ? group.server_data : [];
      for (const item of serverData) {
        const epNum = parseEpisodeNumber(item && item.name);
        const key = epNum !== null ? epNum : cleanText(item && item.slug || item && item.name || '');
        if (!key) continue;

        if (!episodeMap.has(key)) {
          episodeMap.set(key, {
            episode_index: epNum !== null ? epNum - 1 : 0,
            name: epNum !== null ? `Tập ${epNum}` : cleanText(item && item.name || ''),
            servers: []
          });
        }

        const episode = episodeMap.get(key);
        const streamUrl = cleanText(item && (item.link_m3u8 || item.link_embed) || '');
        episode.servers.push({
          server: serverName,
          url: streamUrl || `${siteBase}/phim/${slug}/tap-${cleanText(item && item.slug || epNum || '')}`
        });
      }
    }

    return Array.from(episodeMap.values()).sort((a, b) => a.episode_index - b.episode_index);
  }

  function parseActors(jsonLdMovie) {
    const actors = Array.isArray(jsonLdMovie && jsonLdMovie.actor) ? jsonLdMovie.actor : [];
    return actors.map((actor) => {
      const name = cleanText(actor && actor.name ? actor.name : actor);
      if (!name) return null;
      return {
        name,
        avatar_url: '',
        actor_url: `${SITE_BASE}/dien-vien/${slugify(name)}/`
      };
    }).filter(Boolean);
  }

  try {
    const canonicalUrl = resolveCanonicalDetailUrl(filmUrl);
    const response = await fetch(canonicalUrl, buildFetchOptions(filmUrl));
    if (!response.ok) {
      throw new Error(`Fetch failed ${response.status}: ${canonicalUrl}`);
    }
    const html = await response.text();

    const movie = parseWindowMovie(html);
    if (!movie) {
      throw new Error('No movie payload found in HTML');
    }

    const jsonLdMovie = parseJsonLdMovie(html) || {};
    const slug = cleanText(movie.slug || canonicalUrl.match(/\/phim\/([^/?#]+)/)?.[1] || '');
    const parts = [{
      name: `Phần ${movie.season || 1}`,
      episodes: parseEpisodes(movie, SITE_BASE, slug)
    }];
    const totalEpisodes = parts[0].episodes.length;

    const title = cleanText(movie.title || jsonLdMovie.name || '');
    const titleOriginal = cleanText(jsonLdMovie.alternateName || movie.origin_name || '');
    const description = cleanText(stripHtml(jsonLdMovie.description || movie.description || ''));
    const genres = Array.isArray(jsonLdMovie.genre)
      ? jsonLdMovie.genre.map((g) => cleanText(g)).filter(Boolean)
      : [];
    const countryMatch = String((jsonLdMovie.description || html) ?? '').match(/Phim\s+(?:Lẻ|Bộ)\s+([^•]+?)\s+•\s+RoPhim/i);
    const country = cleanText(countryMatch ? countryMatch[1] : '');
    const duration = cleanText(jsonLdMovie.duration || '');
    const actors = parseActors(jsonLdMovie);

    return JSON.stringify({
      id: slug,
      title,
      title_original: titleOriginal,
      poster_url: cleanText(movie.poster || movie.thumb || ''),
      thumbnail_url: cleanText(movie.thumb || movie.poster || ''),
      url: `${SITE_BASE}/phim/${slug}`,
      year: cleanText(String(jsonLdMovie.datePublished || '').slice(0, 4)),
      duration,
      rating: '',
      country,
      genres,
      description,
      media_type: String(movie.type || '').toLowerCase() === 'series' ? 'series' : 'movie',
      total_episodes: totalEpisodes,
      badge_text: totalEpisodes ? `Tập ${totalEpisodes}` : '',
      parts,
      actors
    });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

function parseEpisodeNumber(name) {
  if (!name) return null;
  const direct = parseInt(String(name), 10);
  if (!Number.isNaN(direct)) return direct;
  const match = String(name).match(/\D+(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function resolveSiteBase(url) {
  const match = String(url || '').match(/^(https?:\/\/[^/]+)/);
  if (match) return match[1];
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return '';
}
