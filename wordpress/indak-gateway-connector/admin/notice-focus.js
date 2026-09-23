/*
 * After a connector action redirects back, move keyboard and screen reader focus to the result
 * notice. Runs on load, after WordPress's common.js has repositioned notices (moving a focused
 * element would drop its focus).
 */
window.addEventListener('load', function () {
  var notice = document.getElementById('indak-gateway-notice');
  if (!notice) {
    return;
  }
  notice.focus();
  notice.addEventListener('click', function (event) {
    // Dismissing removes the focused element, so hand focus to the section heading.
    if (!event.target.closest('.notice-dismiss')) {
      return;
    }
    var heading = document.querySelector('.wrap h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus();
    }
  });
});
