/* Fills the flyer's QR code and address from site/config.js (via site.js). Generated locally, offline. */
(function () {
  'use strict';
  var info = window.RALLYFLOW || {};
  var target = info.siteUrl || info.releasesUrl || '';
  var qr = document.getElementById('qr');
  var url = document.getElementById('url');
  if (target) {
    qr.innerHTML = window.RallyQR.toSvg(target, { margin: 2, dark: '#11241b', light: '#ffffff' });
    url.textContent = target.replace(/^https?:\/\//, '').replace(/\/$/, '');
  } else {
    // No address known yet (site/config.js not filled in and opened from disk): print a search hint instead.
    qr.innerHTML = '<p class="bigurl">Search “RallyFlow pickleball”</p>';
    url.textContent = '';
  }
  var button = document.getElementById('print');
  if (button) button.addEventListener('click', function () { window.print(); });
})();
