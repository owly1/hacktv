/* BOSCO Home page behaviour: mounts the wordmark and keeps the drone clip
   playing. The teardown dialog and page transitions are wired in their own
   scripts. */
(function () {
  'use strict';

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
})();
