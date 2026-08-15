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

// ── Provider: anime-2 ──────────────────────────────────────

// Provider: anime-2 (hhpanda.st)
// Standalone: Stream URL resolver
// Function: getStreamUrl(episodeUrl) -> JSON string of stream object
// Episode URL:  {baseUrl}/watch-<slug>/tap-N-svS.html
// Resolver: fetch watch HTML -> extract post_id from DoPostInfo
//           -> parse #halim-ajax-list-server .get-eps for sub_server labels/types
//           -> for each sub_type, call player.php to get actual iframe URL
//           -> return top-level stream result + sub_servers[] as full stream objects
// v6.1 contract: no top-level declarations.

async function getStreamUrl(episodeUrl) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  function log(msg) {
    try { console.log('[KENG][anime-2][getStreamUrl] ' + msg); } catch (_e) {}
  }

  function parseEpisode(episodeUrl) {
    // Expected: {baseUrl}/watch-<slug>/tap-N-svS.html OR {baseUrl}/<slug>/tap-N-svS.html
    // -> baseUrl={baseUrl}, episodeSlug="tap-N", serverId="S"
    try {
      const u = new URL(episodeUrl);
      const baseUrl = u.protocol + '//' + u.host;
      // Match /watch-<slug>/tap-N-svS.html OR /<slug>/tap-N-svS.html
      const m = u.pathname.match(/(?:\/watch-)?([^/]+)\/(tap-\d+)-sv(\d+)\.html$/);
      if (!m) return null;
      return { baseUrl, episodeSlug: m[2], serverId: m[3], fullUrl: episodeUrl };
    } catch (_e) {
      return null;
    }
  }

  function extractPostId(html) {
    // hhpanda.st uses DoPostInfo.id instead of halim_cfg
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const scripts = doc.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (!/DoPostInfo\s*=/.test(txt)) continue;
      const idMatch = txt.match(/["']?id["']?\s*:\s*(\d+)/);
      if (idMatch) {
        return idMatch[1];
      }
    }
    return null;
  }

  function extractSubServerTypes(html) {
    // Parse sub-server quality tabs from watch page HTML
    // Structure: <span class="get-eps play-listsv ..." data-type="pro">1080P V2</span>
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tabs = doc.querySelectorAll('#halim-ajax-list-server .get-eps[data-type]');
    const seen = new Set();
    const subServers = [];
    for (const tab of tabs) {
      const subType = (tab.getAttribute('data-type') || '').trim();
      let label = (tab.textContent || '').replace(/\s+/g, ' ').trim();
      if (!subType || !label) continue;
      // Deduplicate by subType to avoid duplicate entries from multiple server sections
      if (seen.has(subType)) continue;
      seen.add(subType);
      subServers.push({ label: label, sub_type: subType });
    }
    return subServers;
  }

  function extractIframeUrl(text) {
    // Extract iframe src from player.php response
    const match = text.match(/src=["']([^"']+)["']/);
    return match ? match[1] : null;
  }

  async function callPlayer(baseUrl, postId, episodeSlug, serverId, subType, referer) {
    const playerUrl = baseUrl + '/player/player.php';
    const params = new URLSearchParams({
      'action': 'dox_ajax_player',
      'post_id': postId,
      'chapter_st': episodeSlug,
      'type': subType,
      'sv': serverId
    });
    const resp = await fetch(playerUrl + '?' + params, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': referer,
      },
    });
    if (!resp.ok) {
      return { error: 'player.php HTTP ' + resp.status + ': ' + playerUrl };
    }
    const iframeUrl = extractIframeUrl(await resp.text());
    if (!iframeUrl) {
      return { error: 'No iframe found in player.php response for type=' + subType };
    }
    return { url: iframeUrl };
  }

  function buildStreamResult(url, headers, error) {
    if (error) {
      return { error: error };
    }
    return {
      type: 'embed',
      url: url,
      headers: headers,
    };
  }

  try {
    log('episode=' + episodeUrl);

    // If caller already has a direct m3u8 URL, short-circuit
    if (/\.m3u8(\?|$)/.test(episodeUrl)) {
      return JSON.stringify({ type: 'm3u8', url: episodeUrl, headers: {} });
    }

    const parsed = parseEpisode(episodeUrl);
    if (!parsed) {
      return JSON.stringify({ error: 'Cannot parse episodeUrl: ' + episodeUrl });
    }

    // 1) Fetch the watch page HTML to grab post_id from DoPostInfo
    const watchResp = await fetch(parsed.fullUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': parsed.baseUrl + '/',
      },
    });
    if (!watchResp.ok) {
      return JSON.stringify({ error: 'Watch page HTTP ' + watchResp.status + ': ' + parsed.fullUrl });
    }
    const watchHtml = await watchResp.text();
    const postId = extractPostId(watchHtml);
    if (!postId) {
      return JSON.stringify({ error: 'DoPostInfo.id not found in watch HTML' });
    }
    log('post_id=' + postId);

    // 2) Parse sub_server labels/types from watch page HTML
    const subServerTypes = extractSubServerTypes(watchHtml);
    log('sub_server_types=' + JSON.stringify(subServerTypes));

    // 3) Resolve each sub_server into a full stream object
    const subServers = [];
    let defaultResult = null;
    for (const ss of subServerTypes) {
      const playerResult = await callPlayer(
        parsed.baseUrl,
        postId,
        parsed.episodeSlug,
        parsed.serverId,
        ss.sub_type,
        parsed.fullUrl
      );
      if (playerResult.error) {
        log('sub_server error [' + ss.sub_type + ']: ' + playerResult.error);
      }
      const streamObj = buildStreamResult(
        playerResult.url || '',
        { 'Referer': parsed.fullUrl, 'User-Agent': UA },
        playerResult.error
      );
      const subServerItem = { label: ss.label, ...streamObj };
      subServers.push(subServerItem);
      // First non-error sub-server becomes the default top-level result
      if (!defaultResult && !playerResult.error && playerResult.url) {
        defaultResult = subServerItem;
      }
    }

    // 4) If no sub-servers found, fallback to legacy 'pro' call
    if (!defaultResult && subServers.length === 0) {
      log('fallback legacy pro');
      const playerResult = await callPlayer(
        parsed.baseUrl,
        postId,
        parsed.episodeSlug,
        parsed.serverId,
        'pro',
        parsed.fullUrl
      );
      defaultResult = buildStreamResult(
        playerResult.url || '',
        { 'Referer': parsed.fullUrl, 'User-Agent': UA },
        playerResult.error
      );
    }

    if (!defaultResult) {
      return JSON.stringify({ error: 'No playable stream found for any sub-server' });
    }

    // 5) Return top-level stream result with sub_servers attached
    const result = { ...defaultResult };
    if (subServers.length > 0) {
      result.sub_servers = subServers;
    }
    log('default_url=' + result.url);
    log('sub_server_count=' + subServers.length);

    return JSON.stringify(result);

  } catch (e) {
    log('error: ' + (e && e.message ? e.message : e));
    return JSON.stringify({ error: e && e.message ? e.message : String(e) });
  }
}
