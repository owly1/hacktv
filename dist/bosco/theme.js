/* Apply the saved dashboard theme before CSS paints. Storage may be unavailable. */
(function () {
  'use strict';
  try {
    if (localStorage.getItem('bx-theme') === 'light') document.documentElement.dataset.theme = 'light';
  } catch { /* Default to dark when browser storage is blocked. */ }
})();
