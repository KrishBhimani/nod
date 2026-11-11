const VIDEO_ID = 'cjEK7V9GucQ';

export function startHeroVideo() {
  const play = document.getElementById('heroPlayBtn');
  if (!play) return;

  play.addEventListener('click', () => {
    const player = document.createElement('iframe');
    player.src = `https://www.youtube-nocookie.com/embed/${VIDEO_ID}?autoplay=1&rel=0&playsinline=1`;
    player.title = 'Nod video';
    player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    player.allowFullscreen = true;
    play.replaceWith(player);
    player.focus();
  });
}
