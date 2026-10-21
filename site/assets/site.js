/* Resolves the GitHub download links and site address from site/config.js. No network requests. */
(function () {
  'use strict';
  var cfg = window.RALLYFLOW_CONFIG || {};
  var owner = (cfg.owner || '').trim();
  var repo = (cfg.repo || 'rallyflow').trim();
  var host = location.hostname || '';
  var onPages = /\.github\.io$/i.test(host);
  if (!owner && onPages) owner = host.split('.')[0];
  if (onPages && !cfg.repo) {
    var first = location.pathname.split('/').filter(Boolean)[0];
    if (first) repo = first;
  }

  var repoUrl = owner ? 'https://github.com/' + owner + '/' + repo : '';
  var releasesUrl = repoUrl ? repoUrl + '/releases/latest' : '';
  var siteUrl = (cfg.siteUrl || '').trim();
  if (!siteUrl && /^https?:$/.test(location.protocol)) siteUrl = location.origin + location.pathname.replace(/[^/]*$/, '');
  if (!siteUrl && owner) siteUrl = 'https://' + owner + '.github.io/' + repo + '/';

  window.RALLYFLOW = { owner: owner, repo: repo, repoUrl: repoUrl, releasesUrl: releasesUrl, siteUrl: siteUrl };

  document.querySelectorAll('[data-download]').forEach(function (a) {
    if (releasesUrl) {
      a.href = releasesUrl;
      a.rel = 'noopener';
    } else {
      a.href = '#install';
    }
  });
  document.querySelectorAll('[data-repo-link]').forEach(function (a) {
    if (repoUrl) a.href = repoUrl;
    else a.hidden = true;
  });
  document.querySelectorAll('[data-releases-text]').forEach(function (el) {
    el.textContent = releasesUrl || 'the RallyFlow GitHub Releases page';
  });
  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = String(Math.max(2026, new Date().getFullYear()));
  });
})();
