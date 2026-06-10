// Provider: anime-2
// Function: getMovieDetail(baseUrl, movieUrl) -> JSON string of movie detail with episodes
// v6.1 contract: baseUrl dynamic.

async function getMovieDetail(baseUrl, movieUrl) {
  function cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function absUrl(url, baseUrl) {
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return baseUrl + url;
    return baseUrl + '/' + url;
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
    const episodes = [];

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

        if (href) {
          episodes.push({
            server: serverName.replace(/:$/, ''), // Remove trailing colon
            url: absUrl(href, baseUrl),
            title: epText,
            number: epNumber
          });
        }
      });
    });

    // Build movie detail object
    const detail = {
      title: title,
      title_original: titleOriginal,
      poster_url: absUrl(posterUrl, baseUrl),
      thumbnail_url: absUrl(posterUrl, baseUrl),
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