/*
 * Demo open-tracker
 * Pings itaiarik@gmail.com when a prospect opens the demo.
 *
 * Setup:
 * 1. Sign up at https://web3forms.com (use itaiarik@gmail.com).
 * 2. Verify the email Web3Forms sends.
 * 3. Replace ACCESS_KEY below with the key from the dashboard.
 *
 * Share a tagged link per prospect:
 *   https://the-reformery.pages.dev/?ref=rachel-stephenson
 *   https://the-reformery.pages.dev/?ref=marietta
 *
 * To stop tracking yourself, visit once from each device with:
 *   https://the-reformery.pages.dev/?me=itai      (then bookmark or close)
 *   https://the-reformery.pages.dev/?me=sister
 */
(function () {
  var SITE_NAME = 'Market Polo';
  var ACCESS_KEY = '8014fe3f-21e4-47fa-be51-3fb323cff295';
  var ENDPOINT = 'https://api.web3forms.com/submit';

  if (ACCESS_KEY === 'YOUR_WEB3FORMS_ACCESS_KEY') return;

  try {
    var params = new URLSearchParams(location.search);
    var me = params.get('me');
    var ref = params.get('ref');

    if (me) {
      localStorage.setItem('demo-excluded', me);
      return;
    }
    if (localStorage.getItem('demo-excluded')) return;

    if (ref) sessionStorage.setItem('demo-ref', ref);
    var who = sessionStorage.getItem('demo-ref') || '(no tag)';

    var ua = navigator.userAgent;
    var device = matchMedia('(max-width: 768px)').matches ? 'Mobile' : 'Desktop';
    var when = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });

    function post(subject, extra) {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          access_key: ACCESS_KEY,
          subject: subject,
          from_name: 'Demo Tracker',
          message: [
            'Site: ' + SITE_NAME,
            'Prospect: ' + who,
            'Page: ' + location.pathname,
            'Device: ' + device,
            'Time: ' + when + ' (London)',
            'Referrer: ' + (document.referrer || '(direct)'),
            'URL: ' + location.href,
            extra ? '\nSignal: ' + extra : '',
            '\nUser Agent: ' + ua
          ].join('\n')
        })
      }).catch(function () {});
    }

    if (!sessionStorage.getItem('demo-pinged')) {
      sessionStorage.setItem('demo-pinged', '1');
      post('🟢 ' + who + ' opened ' + SITE_NAME);
    }

    var deepFired = false;
    function fireDeep(reason) {
      if (deepFired || sessionStorage.getItem('demo-engaged')) return;
      deepFired = true;
      sessionStorage.setItem('demo-engaged', '1');
      post('⭐ ' + who + ' engaged with ' + SITE_NAME, reason);
    }
    setTimeout(function () { fireDeep('45s on page'); }, 45000);
    window.addEventListener('scroll', function () {
      var doc = document.documentElement;
      var max = (doc.scrollHeight - window.innerHeight) || 1;
      if ((window.scrollY / max) > 0.55) fireDeep('scrolled 55% of page');
    }, { passive: true });
  } catch (e) {}
})();
