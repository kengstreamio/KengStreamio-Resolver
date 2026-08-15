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

// ── Provider: anime-1 ──────────────────────────────────────

// Provider: anime-1
// Standalone: Stream URL resolver
// Function: getStreamUrl(episodeUrl) -> JSON string of stream object
// Episode URL:  {baseUrl}/xem-phim-<slug>/tap-N-svS.html
// Resolver: fetch watch HTML → extract post_id + player_url from halim_cfg
//           → GET player.php?episode_slug&server_id&subsv_id&post_id
//           → return { type: "m3u8", url, headers } or { error }
// v6.1 contract: no top-level declarations.


async function getStreamUrl(episodeUrl) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  function log(msg) {
    try { console.log('[KENG][anime-1][getStreamUrl] ' + msg); } catch (_e) {}
  }

  function parseEpisode(episodeUrl) {
    // Expected: {baseUrl}/xem-phim-<slug>/tap-N-svS.html
    // → baseUrl={baseUrl}, episodeSlug="tap-N", serverId="S"
    try {
      const u = new URL(episodeUrl);
      const baseUrl = u.protocol + '//' + u.host;
      const m = u.pathname.match(/\/(tap-\d+)-sv(\d+)\.html$/);
      if (!m) return null;
      return { baseUrl, episodeSlug: m[1], serverId: m[2] };
    } catch (_e) {
      return null;
    }
  }

  function extractHalimCfg(html) {
    // Walk every <script> tag; find the inline one that defines halim_cfg
    // and pull out post_id + player_url.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const scripts = doc.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (!/halim_cfg\s*=/.test(txt)) continue;
      const postM = txt.match(/"post_id"\s*:\s*"?(\d+)"?/);
      const playerM = txt.match(/"player_url"\s*:\s*"([^"]+)"/);
      if (postM && playerM) {
        return {
          postId: postM[1],
          playerUrl: playerM[1].replace(/\\\//g, '/'),
        };
      }
    }
    return null;
  }

  try {
    log('episode=' + episodeUrl);

    // If caller already has a direct m3u8 URL, short-circuit
    if (/\.m3u8(\?|$)/.test(episodeUrl)) {
      const result = await makeStreamM3U8Result(episodeUrl, '');
      log('Direct m3u8, ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
      return JSON.stringify(result);
    }

    const parsed = parseEpisode(episodeUrl);
    if (!parsed) {
      return JSON.stringify({ error: 'Cannot parse episodeUrl: ' + episodeUrl });
    }

    // 1) Fetch the watch page HTML to grab post_id + player_url from halim_cfg
    const watchResp = await fetch(episodeUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': parsed.baseUrl + '/',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    if (!watchResp.ok) {
      return JSON.stringify({ error: 'Watch page HTTP ' + watchResp.status + ': ' + episodeUrl });
    }
    const watchHtml = await watchResp.text();
    const cfg = extractHalimCfg(watchHtml);
    if (!cfg) {
      return JSON.stringify({ error: 'halim_cfg.post_id / player_url not found in watch HTML' });
    }
    log('post_id=' + cfg.postId + ' player_url=' + cfg.playerUrl);

    // 2) Call player.php with the four params the bundle.js sends
    const playerUrl =
      cfg.playerUrl +
      '?episode_slug=' + encodeURIComponent(parsed.episodeSlug) +
      '&server_id=' + encodeURIComponent(parsed.serverId) +
      '&subsv_id=' +
      '&post_id=' + encodeURIComponent(cfg.postId);

    const playerResp = await fetch(playerUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json,text/javascript,*/*;q=0.8',
        'Referer': episodeUrl,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    if (!playerResp.ok) {
      return JSON.stringify({ error: 'player.php HTTP ' + playerResp.status + ': ' + playerUrl });
    }

    const data = await playerResp.json();

    // 3) Error paths: VIP (sv2 → 403), or generic status:false
    if (data && data.status === false) {
      const msg = data.message || ('player.php status:false (code=' + (data.code || 'n/a') + ')');
      return JSON.stringify({ error: msg });
    }
    if (!data || !data.file) {
      return JSON.stringify({ error: 'player.php response missing "file" field' });
    }

    const m3u8Url = String(data.file).replace(/\\\//g, '/');
    log('m3u8=' + m3u8Url + ' label=' + (data.label || '') + ' type=' + (data.type || ''));

    const referer = episodeUrl;
    const result = await makeStreamM3U8Result(m3u8Url, referer);
    log('Stream result: ads=' + (result.ads === null ? 'null' : (result.ads ? result.ads.length : 0)));
    return JSON.stringify(result);

  } catch (e) {
    log('error: ' + (e && e.message ? e.message : e));
    return JSON.stringify({ error: e && e.message ? e.message : String(e) });
  }
}
