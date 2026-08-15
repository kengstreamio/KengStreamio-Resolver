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

/**
 * Stream URL Resolver v1 — onflix.lol (rophim-13)
 * Contract: getStreamUrl(episodeUrl) → JSON { type, url, headers, ads? } | { error }
 *
 * Input: episodeUrl = server.url from detail_resolver episodes[].servers[]
 *
 * URL types from detail_resolver:
 *   SN   → api-content.onflix.xyz/m3u8/.../*.m3u8?exp=...&token=...   (direct m3u8, 24h TTL)
 *   PA   → v7.kkphimplayer7.com/.../index.m3u8                        (direct m3u8)
 *   OP   → vip.opstream90.com/.../index.m3u8                          (direct m3u8)
 *   NC   → ss.onflixstream.site/playlist?url=<base64(embed_url)>      (proxy → streamc.xyz embed)
 *   IDOYU → cdn.idoyu.com/?id=...&s_type=stream                       (embed player, no native stream)
 *
 * Strategy:
 *   1. If URL contains .m3u8 → return directly with appropriate headers
 *      - For PA: also parse variant playlist for ad detection (SSAI /adjump/ pattern)
 *   2. If URL is NC proxy (ss.onflixstream.site/playlist?url=...) → decode base64 → return embed URL
 *      (CORS blocks JS fetch → Flutter's EmbedPlayerSurface uses WebView iframe instead)
 *   3. If URL is idoyu.com → return as embed type (WebView-based player)
 *   4. Otherwise → error
 */


async function getStreamUrl(episodeUrl) {
  const _UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  function _fetchOpts(referer, origin) {
    return {
      headers: {
        'User-Agent': _UA,
        'Accept': '*/*',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': referer || 'https://onflix.lol/',
        'Origin': origin || 'https://onflix.lol',
      },
    };
  }

  function _extractOrigin(url) {
    try {
      const u = new URL(url);
      return u.origin;
    } catch (_) {
      return 'https://onflix.lol';
    }
  }

  // Detect which server this URL belongs to based on hostname
  function _detectServer(url) {
    if (url.includes('api-content.onflix.xyz')) return 'sn';
    if (url.includes('kkphimplayer') || url.includes('phim1280.tv')) return 'pa';
    if (url.includes('opstream')) return 'op';
    if (url.includes('ss.onflixstream.site')) return 'nc';
    if (url.includes('idoyu.com')) return 'idoyu';
    return 'unknown';
  }

  // Decode base64 (standard + URL-safe, with padding)
  function _b64decode(str) {
    // URL-safe → standard
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding
    while (s.length % 4 !== 0) s += '=';
    return atob(s);
  }

  try {
    const server = _detectServer(episodeUrl);
    console.log('[KENG][rophim-13] getStreamUrl: ' + episodeUrl + ' | server=' + server);

    // ── Strategy 1: Direct m3u8 (SN / PA / OP) ──────────────────────────────
    if (episodeUrl.includes('.m3u8')) {
      let referer = 'https://onflix.lol/';

      // PA: kkphimplayer7, phim1280.tv — master m3u8 returns relative variant path
      // (e.g. "3500kb/hls/index.m3u8"). VLC on Android fails to resolve
      // relative paths when TLS session is re-negotiated on the redirect.
      // Fix: fetch master, resolve relative → return absolute variant URL.
      // All m3u8 types (SN, PA, OP) → makeStreamM3U8Result handles server detection + PA variant resolve
      console.log('[KENG][rophim-13] ' + server.toUpperCase() + ' m3u8: ' + episodeUrl);
      const result = await makeStreamM3U8Result(episodeUrl, referer);
      console.log('[KENG][rophim-13] Stream result: ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
      return JSON.stringify(result);
    }

    // ── Strategy 2: NC proxy — ss.onflixstream.site/playlist?url=<base64> ───
    //
    // CORS: fetch() từ headless WebView origin (onflix.lol) đến embed site bị
    // CORS block (server không trả Access-Control-Allow-Origin). Không thể
    // dùng JS fetch để lấy embed HTML → extract m3u8.
    //
    // Solution: decode base64 → trả embed URL cho Flutter, xử lý bằng
    // WebView-based embed player (EmbedPlayerSurface) thay vì native player.
    if (server === 'nc') {
      console.log('[KENG][rophim-13] NC proxy detected, decoding...');

      // Extract base64 param
      let b64 = '';
      try {
        const urlObj = new URL(episodeUrl);
        b64 = urlObj.searchParams.get('url') || '';
      } catch (_) {
        const m = episodeUrl.match(/[?&]url=([^&]+)/);
        b64 = m ? m[1] : '';
      }

      if (!b64) {
        throw new Error('NC proxy: cannot extract url param from ' + episodeUrl);
      }

      // Decode → embed URL (e.g. https://embed15.streamc.xyz/embed.php?hash=...)
      const embedUrl = _b64decode(b64);
      console.log('[KENG][rophim-13] NC embed URL: ' + embedUrl);

      // Return embed URL — Flutter's EmbedPlayerSurface will load it in a
      // WebView iframe, bypassing CORS restrictions entirely.
      return JSON.stringify({
        type: 'embed',
        url: embedUrl,
        headers: {
          'Referer': 'https://onflix.lol/',
          'User-Agent': _UA,
        },
      });
    }

    // ── Fallback: unknown server → treat as embed ───────────────────────────
    //
    // Nếu không map được server type (ví dụ idoyu.com, hoặc embed domain mới),
    // trả về embed để Flutter dùng WebView. Embed fail vẫn tốt hơn crash.
    console.log('[KENG][rophim-13] Unknown server, falling back to embed: ' + episodeUrl);
    return JSON.stringify({
      type: 'embed',
      url: episodeUrl,
      headers: {
        'Referer': 'https://onflix.lol/',
        'User-Agent': _UA,
      },
    });

  } catch (e) {
    console.log('[KENG][rophim-13] getStreamUrl error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}
