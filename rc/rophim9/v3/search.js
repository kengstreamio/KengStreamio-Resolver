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

// ── Provider: rophim9 ──────────────────────────────────────

/**
 * Search Resolver v3 (HTML page-based, dynamic baseUrl)
 * Contract: searchMovies(baseUrl, keyword, page) -> JSON array of movies
 * Source: GET /tim-kiem?q={query}&page={page}
 *
 * RoPhim9's public search API only returns 5 items/page while the web search page
 * renders 32 items/page. Parse the search page directly to match site behavior.
 */
async function searchMovies(baseUrl, keyword, page = 1) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  const SITE_BASE = baseUrl;

  function buildFetchOptions(refererUrl) {
    return {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': refererUrl || SITE_BASE + '/',
        'Origin': SITE_BASE,
      },
    };
  }

  function decodeHtml(text) {
    return (text || '')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  function normalizePoster(url) {
    if (!url) return '';
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('http')) return url;
    return SITE_BASE + url;
  }

  async function fetchHtml(url) {
    const res = await fetch(url, buildFetchOptions(SITE_BASE + '/'));
    if (!res.ok) throw new Error('Fetch failed ' + res.status + ': ' + url);
    return res.text();
  }

  function extractMoviePayload(html, slug) {
    const escapedNeedle = '\\"slug\\":\\"' + slug + '\\"';
    const rawNeedle = '"slug":"' + slug + '"';
    let idx = html.indexOf(escapedNeedle);
    let escaped = true;

    if (idx === -1) {
      idx = html.indexOf(rawNeedle);
      escaped = false;
    }
    if (idx === -1) return {};

    const window = html.slice(idx, idx + 7000);

    function pick(field) {
      const pattern = escaped
        ? new RegExp('\\\\"' + field + '\\\\":(?:\\\\"([^\\\\"]*)\\\\"|([^,}\\]]+))')
        : new RegExp('"' + field + '":(?:"([^"]*)"|([^,}\\]]+))');
      const match = window.match(pattern);
      if (!match) return '';
      return (match[1] || match[2] || '').trim().replace(/^"|"$/g, '');
    }

    return {
      title_original: decodeHtml(pick('origin_name')),
      media_type: pick('type') === 'series' ? 'series' : (pick('type') === 'movie' ? 'movie' : ''),
      badge_text: decodeHtml(pick('episode_current') || pick('quality')),
      year: pick('publish_year'),
      rating: pick('imdb_rating'),
    };
  }

  function resolveBadgePrefix(html) {
    const parts = [];

    const pdMatch = html.match(/\bline-pd\b[\s\S]*?<strong>([^<]+)<\/strong>/i);
    if (pdMatch) parts.push('PĐ. ' + decodeHtml(pdMatch[1]));

    const tmMatch = html.match(/\bline-tm\b[\s\S]*?<strong>([^<]+)<\/strong>/i);
    if (tmMatch) parts.push('TM. ' + decodeHtml(tmMatch[1]));

    const ltMatch = html.match(/\bline-lt\b[\s\S]*?<strong>([^<]+)<\/strong>/i);
    if (ltMatch) parts.push('LT. ' + decodeHtml(ltMatch[1]));

    return parts.join(' | ');
  }

  function isTrailerItem(item) {
    const text = `${item && item.title ? item.title : ''} ${item && item.badge_text ? item.badge_text : ''}`.toLowerCase();
    return text.includes('trailer');
  }

  try {
    if (!keyword || !keyword.trim()) throw new Error('keyword is required');

    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    console.log(`[KENG][RoPhim9] searchMovies: "${keyword}" (page ${currentPage})`);

    const url = `${SITE_BASE}/tim-kiem?q=${encodeURIComponent(keyword.trim())}&page=${currentPage}`;
    const html = await fetchHtml(url);

    const movieData = {};
    const itemRe = /<a[^>]+href="([^"]*\/phim\/([^"/?]+))"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = itemRe.exec(html)) !== null) {
      const link = match[1].startsWith('http') ? match[1] : SITE_BASE + match[1];
      const fullMatch = match[0];
      const content = match[2] ? match[3] : '';
      const slug = match[2];
      if (!slug) continue;

      if (link.includes('.trailer') || fullMatch.toLowerCase().includes('trailer') || content.toLowerCase().includes('trailer')) {
        continue;
      }

      if (!movieData[link]) {
        movieData[link] = {
          slug,
          title: '',
          title_original: '',
          poster_url: '',
          badge_text: '',
        };
      }

      const imgMatch = content.match(/src="([^"]+)"/i) || content.match(/data-src="([^"]+)"/i) || content.match(/data-original="([^"]+)"/i);
      if (imgMatch && !movieData[link].poster_url) {
        movieData[link].poster_url = normalizePoster(imgMatch[1]);
      }

      const titleMatch = fullMatch.match(/<a[^>]+title="([^"]+)"/i);
      if (titleMatch) {
        const text = decodeHtml(titleMatch[1]);
        if (!movieData[link].title) {
          movieData[link].title = text;
        } else if (!movieData[link].title_original && text !== movieData[link].title) {
          movieData[link].title_original = text;
        }
      }

      const badgeText = resolveBadgePrefix(content);
      if (badgeText && !movieData[link].badge_text) {
        movieData[link].badge_text = badgeText;
      }
    }

    const movies = [];
    for (const [link, data] of Object.entries(movieData)) {
      const embedded = extractMoviePayload(html, data.slug);
      const title = data.title || data.slug.replace(/-/g, ' ');
      const badgeText = data.badge_text || embedded.badge_text || '';
      const mediaType = embedded.media_type || (/tập|\bLT\.\b|\bTM\.\b/i.test(badgeText) ? 'series' : 'movie');

      movies.push({
        rank: 0,
        title,
        title_original: data.title_original || embedded.title_original || '',
        poster_url: data.poster_url,
        thumbnail_url: data.poster_url,
        url: link,
        media_type: mediaType,
        badge_text: badgeText,
        badge_sub: '',
        year: String(embedded.year || ''),
        rating: String(embedded.rating || ''),
        synopsis: '',
        age_rating: '',
        episode_current: embedded.badge_text || '',
        genres: []
      });
    }

    const filtered = movies.filter(item => !isTrailerItem(item));
    console.log(`[KENG][RoPhim9] searchMovies: returned ${filtered.length} results`);
    return JSON.stringify(filtered);

  } catch (e) {
    console.error(`[KENG][RoPhim9] searchMovies ERROR: ${e.message}`);
    return JSON.stringify({ error: e.message });
  }
}
