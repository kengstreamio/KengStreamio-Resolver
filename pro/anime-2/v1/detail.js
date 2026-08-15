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

// ── Provider: anime-2 ──────────────────────────────────────

// Provider: anime-2
// Function: getMovieDetail(baseUrl, movieUrl) -> JSON string of movie detail with episodes
// v6.1 contract: baseUrl dynamic.

async function getMovieDetail(movieUrl) {
  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function absUrl(url) {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/') && typeof location !== 'undefined' && location.origin) {
      return location.origin + url;
    }
    return url;
  }

  async function fetchText(url) {
    const resp = await fetch(url, { credentials: 'omit' });
    if (!resp.ok) throw new Error(`Fetch failed: ${url} -> HTTP ${resp.status}`);
    return await resp.text();
  }

  try {
    const html = await fetchText(movieUrl);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Extract basic movie info (hhpanda.st selectors)
    const titleEl = doc.querySelector('.movie_name, h1.movie_name');
    const title = titleEl ? cleanText(titleEl.textContent) : '';

    const originalTitleEl = doc.querySelector('.org_title, h2.org_title');
    const titleOriginal = originalTitleEl ? cleanText(originalTitleEl.textContent) : '';

    const posterEl = doc.querySelector('.film-poster-img, .movie-thumb img, .film-poster img');
    let posterUrl = '';
    if (posterEl) {
      posterUrl = posterEl.getAttribute('src') || posterEl.getAttribute('data-src') || '';
    }

    const ratingEl = doc.querySelector('.kksr-rating, .imdb-rating, .movie-rating');
    const rating = ratingEl ? cleanText(ratingEl.textContent) : '';

    const yearEl = doc.querySelector('.movie-year, .year, [itemprop="datePublished"]');
    const year = yearEl ? cleanText(yearEl.textContent).replace(/[^\d]/g, '').slice(0, 4) : '';

    const synopsisEl = doc.querySelector('.desc, .synopsis, .movie-description, #film-content');
    const synopsis = synopsisEl ? cleanText(synopsisEl.textContent) : '';

    // Extract genres
    const genreLinks = doc.querySelectorAll('.movie-cat a, .categories a, .genre a');
    const genres = [];
    for (const link of genreLinks) {
      const text = cleanText(link.textContent);
      if (text && text !== '...') genres.push(text);
    }

    // Extract actors
    const actorLinks = doc.querySelectorAll('.cast-list a, .actors a');
    const actors = [];
    for (const link of actorLinks) {
      const name = cleanText(link.textContent);
      if (name) {
        actors.push({
          name: name,
          avatar_url: ''
        });
      }
    }

    // Extract episodes from server items (hhpanda.st structure)
    const serverItems = doc.querySelectorAll('.halim-server, .server-item, .server');
    const episodesByNumber = {}; // Map: episodeNumber → { servers: [], title: '' }
    
    serverItems.forEach((serverEl, serverIdx) => {
      // Get server name from halim-server-name span
      const serverNameEl = serverEl.querySelector('.halim-server-name, .server-name, .server-title');
      let serverName = serverNameEl ? cleanText(serverNameEl.textContent) : `Server ${serverIdx + 1}`;
      // Clean up server name - remove # prefix if present
      serverName = serverName.replace(/^#\s*/, '').trim();
      
      // Get episode links - hhpanda uses .halim-episode a or .halim-list-eps a
      const episodeLinks = serverEl.querySelectorAll('.halim-episode a, .halim-list-eps a, a[href*="watch-"], .episodes a');
      episodeLinks.forEach((epLink, epIdx) => {
        const href = epLink.getAttribute('href') || '';
        const epText = cleanText(epLink.textContent);
        // Extract episode number from text like "Tập 166"
        const epMatch = epText.match(/(\d+)/);
        const epNumber = epMatch ? parseInt(epMatch[1], 10) : epIdx + 1;

        if (!href) return;

        // Parse server ID from URL: /tap-N-svS.html
        const svMatch = href.match(/-sv(\d+)\.html$/);
        const serverId = svMatch ? svMatch[1] : String(serverIdx + 1);

        if (!episodesByNumber[epNumber]) {
          episodesByNumber[epNumber] = {
            servers: [],
            title: epText,
            number: epNumber
          };
        }
        
        episodesByNumber[epNumber].servers.push({
          id: serverId,
          server: serverName.replace(/:$/, ''), // Remove trailing colon
          url: absUrl(href),
          sv: serverId
        });
      });
    });

    // Convert to Flutter contract: array of episodes with servers array
    const episodes = Object.values(episodesByNumber).map((ep) => ({
      episode_index: ep.number - 1, // Flutter uses 0-based index
      name: ep.title,
      servers: ep.servers
    })).sort((a, b) => a.episode_index - b.episode_index);

    // Build movie detail object
    const detail = {
      title: title,
      title_original: titleOriginal,
      poster_url: absUrl(posterUrl),
      thumbnail_url: absUrl(posterUrl),
      url: movieUrl,
      media_type: episodes.length > 0 ? 'series' : 'movie',
      badge_text: '',
      badge_sub: '',
      year: year,
      rating: rating,
      synopsis: synopsis,
      age_rating: '',
      episode_current: '',
      genres: genres,
      actors: actors,
      episodes: episodes
    };

    return JSON.stringify(detail);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}