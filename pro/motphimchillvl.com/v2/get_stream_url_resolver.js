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

// ── Provider: motphimchillvl.com ──────────────────────────────────────

/**
 * Motchill Resolver v1.0
 * Architecture: JS-Logic-Shell Standard
 *
 * App gọi:
 *   getEpisodes(filmUrl)   — lấy danh sách tập từ trang phim
 *   getStreamUrl(episodeUrl) — lấy M3U8 / embed link từ trang xem phim
 *
 * Toàn bộ logic fetch + parse nằm trong JS này.
 * Chạy trong WebView context với baseUrl động.
 */


async function getStreamUrl(episodeUrl) {
    const SITE_BASE = resolveSiteBase(episodeUrl);
    if (!SITE_BASE) {
        return JSON.stringify({ error: 'Cannot resolve site base from episodeUrl' });
    }
    const MOTCHILL_BASE = SITE_BASE;
    try {
        // Fast path: if the URL is already a direct m3u8 stream, return immediately
        if (episodeUrl.includes('.m3u8')) {
            console.log('[JS-MC] Direct m3u8 URL detected, skipping fetch: ' + episodeUrl);
            const result = await makeStreamM3U8Result(episodeUrl, '');
            console.log('[JS-MC] Direct m3u8 ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
            return JSON.stringify(result);
        }

        // Stream links are embedded directly in the episode page (/phim/slug/tap-N-ID)
        // No redirect needed — fetch the URL as-is
        console.log('[JS-MC] Fetching watch page: ' + episodeUrl);
        const res = await fetch(episodeUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!res.ok) throw new Error('Watch page fetch failed: ' + res.status);
        const html = await res.text();
        let m3u8Url = null;
        let embedUrl = null;

        // Strategy 1: parse any tag that has BOTH data-link and data-type attributes
        // Use [\s\S]*? to handle multi-line tags and any attribute order.
        // Covers: <li data-link="..." data-type="m3u8" ...> and <div data-type="..." data-link="...">
        const tagRe = /<[a-z][^>]*?data-link="([^"]+)"[\s\S]*?data-type="([^"]+)"[^>]*>/gi;
        const tagRe2 = /<[a-z][^>]*?data-type="([^"]+)"[\s\S]*?data-link="([^"]+)"[^>]*>/gi;
        let m;

        while ((m = tagRe.exec(html)) !== null) {
            const link = m[1];
            const type = m[2].toLowerCase();
            if (type === 'm3u8' && !m3u8Url) m3u8Url = link;
            if (type === 'embed' && !embedUrl) embedUrl = link;
        }
        while ((m = tagRe2.exec(html)) !== null) {
            const type = m[1].toLowerCase();
            const link = m[2];
            if (type === 'm3u8' && !m3u8Url) m3u8Url = link;
            if (type === 'embed' && !embedUrl) embedUrl = link;
        }

        // Strategy 2: fallback — scan for data-link values and infer type from URL pattern
        if (!m3u8Url && !embedUrl) {
            const linkRe = /data-link="([^"]+)"/gi;
            while ((m = linkRe.exec(html)) !== null) {
                const link = m[1];
                if (!m3u8Url && link.includes('.m3u8')) m3u8Url = link;
                else if (!embedUrl && (link.startsWith('http') || link.startsWith('//'))) embedUrl = link;
            }
            if (m3u8Url || embedUrl) {
                console.log('[JS-MC] Strategy 2 fallback used — data-type attr missing');
            }
        }

        if (!m3u8Url && embedUrl) {
            console.log('[JS-MC] m3u8 missing, attempting to follow embed: ' + embedUrl);
            const resolvedM3u8 = await _followEmbed(embedUrl);
            if (resolvedM3u8) m3u8Url = resolvedM3u8;
        }

        const headers = {
            'Referer': MOTCHILL_BASE + '/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        if (m3u8Url) {
            console.log('[JS-MC] STREAM RESOLVED (m3u8): ' + m3u8Url);
            const referer = MOTCHILL_BASE + '/';
            const result = await makeStreamM3U8Result(m3u8Url, referer);
            console.log('[JS-MC] Stream result: ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
            return JSON.stringify(result);
        }
        if (embedUrl) {
            console.log('[JS-MC] STREAM RESOLVED (embed): ' + embedUrl);
            return JSON.stringify({ type: 'embed', url: embedUrl, headers });
        }

        throw new Error('No stream link found in episode page');
    } catch (e) {
        console.log('[JS-MC] getStreamUrl error: ' + e.message);
        return JSON.stringify({ error: e.message });
    }
}

function resolveSiteBase(url) {
    const siteMatch = url.match(/^(https?:\/\/[^/]+)/);
    if (siteMatch) return siteMatch[1];
    if (typeof location !== 'undefined' && location.origin) return location.origin;
    return '';
}

/**
 * Deep crawl into popular embed providers to find the direct .m3u8 link
 */
async function _followEmbed(url) {
    try {
        console.log('[JS-MC] Unpacking embed: ' + url);
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
        });
        const html = await res.text();

        // Pattern 1: jwplayer file: "..." or sources: [{file: "..."}]
        // Pattern 2: Typical file: '...' logic in stream providers
        const m3u8Re = /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i;
        const match = html.match(m3u8Re);
        if (match) {
            console.log('[JS-MC] Found m3u8 inside embed');
            return match[1];
        }

        // Pattern 3: some providers use base64 or obfuscation, which we might not hit with simple regex
        // but often they expose a direct link in a <script> or as a 'src'
        return null;
    } catch (e) {
        console.log('[JS-MC] _followEmbed error: ' + e.message);
        return null;
    }
}
