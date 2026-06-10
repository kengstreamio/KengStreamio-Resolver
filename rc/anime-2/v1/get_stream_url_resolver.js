// Provider: anime-2 (hhpanda.st)
// Standalone: Stream URL resolver
// Function: getStreamUrl(episodeUrl) -> JSON string of stream object
// Episode URL:  {baseUrl}/watch-<slug>/tap-N-svS.html
// Resolver: fetch watch HTML → extract post_id from DoPostInfo
//           → call player.php?action=dox_ajax_player&post_id&chapter_st&type&sv
//           → returns iframe to streamfree.vip (encrypted) → return as iframe type
// v6.1 contract: no top-level declarations.

async function getStreamUrl(episodeUrl) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  function log(msg) {
    try { console.log('[KENG][anime-2][getStreamUrl] ' + msg); } catch (_e) {}
  }

  function parseEpisode(episodeUrl) {
    // Expected: {baseUrl}/watch-<slug>/tap-N-svS.html OR {baseUrl}/<slug>/tap-N-svS.html
    // → baseUrl={baseUrl}, episodeSlug="tap-N", serverId="S"
    try {
      const u = new URL(episodeUrl);
      const baseUrl = u.protocol + '//' + u.host;
      // Match /watch-<slug>/tap-N-svS.html OR /<slug>/tap-N-svS.html
      const m = u.pathname.match(/(?:\/watch-)?([^/]+)\/(tap-\d+)-sv(\d+)\.html$/);
      if (!m) return null;
      return { baseUrl, episodeSlug: m[2], serverId: m[3] };
    } catch (_e) {
      return null;
    }
  }

  function extractPostId(html) {
    // hhpanda.st uses DoPostInfo.id instead of halim_cfg
    // Search for: DoPostInfo = { id: 292, slug: 'gia-thien' };
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

  function extractIframeUrl(text) {
    // Extract iframe src from player.php response
    const match = text.match(/src=["']([^"']+)["']/);
    return match ? match[1] : null;
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
    const watchResp = await fetch(episodeUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': parsed.baseUrl + '/',
      },
    });
    if (!watchResp.ok) {
      return JSON.stringify({ error: 'Watch page HTTP ' + watchResp.status + ': ' + episodeUrl });
    }
    const watchHtml = await watchResp.text();
    const postId = extractPostId(watchHtml);
    if (!postId) {
      return JSON.stringify({ error: 'DoPostInfo.id not found in watch HTML' });
    }
    log('post_id=' + postId);

    // 2) Call player.php with hhpanda.st params
    const playerUrl = parsed.baseUrl + '/player/player.php';
    const params = new URLSearchParams({
      'action': 'dox_ajax_player',
      'post_id': postId,
      'chapter_st': parsed.episodeSlug,
      'type': 'pro',  // free server
      'sv': parsed.serverId
    });
    
    const playerResp = await fetch(playerUrl + '?' + params, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': episodeUrl,
      },
    });
    if (!playerResp.ok) {
      return JSON.stringify({ error: 'player.php HTTP ' + playerResp.status + ': ' + playerUrl });
    }

    const playerHtml = await playerResp.text();
    const iframeUrl = extractIframeUrl(playerHtml);
    
    if (!iframeUrl) {
      return JSON.stringify({ error: 'No iframe found in player.php response' });
    }
    log('iframe=' + iframeUrl);

    // hhpanda returns streamfree.vip embed which uses bytecode encryption
    // Return as embed type - Flutter WebView will handle it
    return JSON.stringify({
      type: 'embed',
      url: iframeUrl,
      headers: {
        'Referer': episodeUrl,
        'User-Agent': UA,
      },
    });

  } catch (e) {
    log('error: ' + (e && e.message ? e.message : e));
    return JSON.stringify({ error: e && e.message ? e.message : String(e) });
  }
}