/* BOSCO Home page behaviour: mounts the wordmark, keeps the drone clip
   playing, routes both Get started links through the page transition, and
   plays the arrive intro only when returning from the Dashboard. The teardown
   dialog lives in teardown.js. */
(function () {
  'use strict';

  const T = window.BoscoTransition;
  window.BoscoMark.mountAll();

  /** Start the muted hover loop; browsers may refuse autoplay, which is harmless (the poster shows). */
  function playClip() {
    const video = document.getElementById('drone-video');
    if (!video) return;
    video.muted = true;
    const attempt = video.play();
    if (attempt && attempt.catch) attempt.catch(() => {});
  }
  playClip();

  // Get started (hero and teardown end) → Dashboard. The teardown stage recedes
  // with Home's content when the dialog is open.
  const content = () => [document.getElementById('home-body'), document.querySelector('.teardown-stage')];
  document.querySelectorAll('a[data-transition="to-dashboard"]').forEach(link => {
    T.bindLink(link, () => ({ content: content() }));
  });

  // Dashboard → Home leaves a one-shot flag; a direct visit shows no intro.
  if (T.takeFlag(T.HOME_INTRO_FLAG)) T.arrive({ content: document.getElementById('home-body') });
  else document.documentElement.classList.remove('bx-pre-cover');
})();
