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
   * Find the RSC push containing movie + episodes data
   * It's the one with "movie":{...} and "episodes":[...]
   */
  function _findDataPush(pushes) {
    for (const p of pushes) {
      if (p.includes('"movie":{') && p.includes('"episodes":[')) {
        return p;
      }
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

    // Sort servers: SN → OP → PA → NC
    const _prio = (s) => {
      if (s.includes('(SN)')) return 0;
      if (s.includes('(OP)')) return 1;
      if (s.includes('(PA)')) return 2;
      if (s.includes('(NC)')) return 3;
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

    // 3. Find data push with movie + episodes
    const dataPush = _findDataPush(pushes);
    if (!dataPush) {
      throw new Error('No movie+episodes data in RSC payload');
    }

    // 4. Extract movie object
    const movieStr = _extractMovieObj(dataPush);
    if (!movieStr) {
      throw new Error('Cannot extract movie object');
    }
    const movie = JSON.parse(movieStr);

    // 5. Extract episodes array
    const epsStr = _extractEpisodesArr(dataPush);
    let rawEps = [];
    if (epsStr) {
      rawEps = JSON.parse(epsStr);
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
