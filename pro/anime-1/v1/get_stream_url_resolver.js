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
      return JSON.stringify({ type: 'm3u8', url: episodeUrl, headers: {} });
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

    return JSON.stringify({
      type: 'm3u8',
      url: m3u8Url,
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
